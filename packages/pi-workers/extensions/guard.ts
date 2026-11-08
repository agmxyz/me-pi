/**
 * Safety net for really dangerous bash commands: a recursive rm outside every repo (or of a repo root or `.git`),
 * discarding uncommitted work, and force pushes or pushes to main/master on a network remote (`guard-policy.ts`).
 * With a UI it asks for confirmation; without one (print mode) it blocks. In a delegate worker it always blocks, and
 * also blocks the history rewrites the main session now allows (amend, rebase, filter-branch/-repo, `branch -D`).
 * `/guard on|off` toggles it for the current session; every session starts on.
 * The Approval policy in GLOBAL_AGENTS.md stays the primary rule; this is a guardrail, not a sandbox.
 */

import { homedir } from "node:os";
import { posix } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isWorkerProcess, workerIdentity } from "./delegate-env.ts";
import { branchOf, dirtIn, remoteUrlOf, repoRootOf } from "./guard-disk.ts";
import { type Finding, type PolicyEnv, policy } from "./guard-policy.ts";
import { classify } from "./guard-regex.ts";
import { initShell } from "./guard-shell.ts";

export const GUARD_STOP_EVENT = "me-pi:guard-stop";

export interface GuardStopEvent {
	owner: "guard";
	jobId: string;
	attempt: number;
	toolCallId: string;
	cause: "guard-denial";
	resource: "guard";
	effect: "denied";
}

/** The disk as the policy reads it, live, for a command run in `cwd`. */
function liveEnv(cwd: string): PolicyEnv {
	return { cwd, home: homedir(), branch: () => branchOf(cwd), branchOf, repoRootOf, remoteUrlOf };
}

/** Whether a case-2 finding's work is at risk now: uncommitted changes there, or a repo that can't be read. */
function atRisk(f: Finding): boolean {
	const d = f.dirty;
	if (!d || d.always || d.repo === undefined) return true;
	const { repo } = d;
	const paths = d.paths?.map((p) => posix.relative(repo, p));
	const whole = paths === undefined || paths.some((p) => p === "" || p.startsWith(".."));
	return dirtIn(repo, whole ? undefined : paths, d.untracked) !== "clean";
}

/**
 * Why `command` needs approval (main session) or is blocked (worker), or undefined when it may run. `parser` false
 * means the grammar failed to load: guard 0.1.3's regex verdict judges the whole command.
 */
export function guardRisk(command: string, cwd: string, parser: boolean, worker: boolean): string | undefined {
	if (!parser) return classify(command, () => branchOf(cwd));
	let v: ReturnType<typeof policy>;
	try {
		v = policy(command, liveEnv(cwd));
	} catch (error) {
		// A parser or policy bug must not let a command through unjudged, nor stop guard: fail closed on this one.
		const why = error instanceof Error ? error.message : String(error);
		return classify(command, () => branchOf(cwd)) ?? `guard could not judge this command (${why})`;
	}
	const risks = v.findings.filter((f) => f.level === "ask" || atRisk(f)).map((f) => f.detail);
	if (worker) risks.push(...v.dropped.filter((d) => d.rule === "history").map((d) => `${d.detail} (workers)`));
	return risks.length ? [...new Set(risks)].join("; ") : undefined;
}

export default function (pi: ExtensionAPI) {
	registerGuard(pi);
}

/** The extension, with the parser loader injectable so tests can make it fail. */
export function registerGuard(pi: ExtensionAPI, loadParser: () => Promise<void> = initShell) {
	let enabled = true;
	// Loaded once, in the background, so startup never waits on it; the first bash call awaits it (~10 ms).
	let loadError: string | undefined;
	let warned = false;
	const ready = loadParser().then(
		() => true,
		(error: unknown) => {
			loadError = error instanceof Error ? error.message : String(error);
			return false;
		},
	);

	pi.registerCommand("guard", {
		description: "Dangerous-bash guard: /guard on | off (current session; default on)",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "on" || arg === "off") enabled = arg === "on";
			else if (arg) return ctx.ui.notify("usage: /guard [on|off]", "warning");
			ctx.ui.notify(`guard ${enabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!enabled || event.toolName !== "bash") return undefined;
		const command = String((event.input as { command?: unknown }).command ?? "");
		const parser = await ready;
		if (!parser && !warned) {
			warned = true;
			ctx.ui?.notify(
				`guard: the bash parser failed to load, so guard falls back to its older pattern rules (asks more often): ${loadError}`,
				"warning",
			);
		}
		const worker = isWorkerProcess();
		const risk = guardRisk(command, ctx.cwd, parser, worker);
		if (!risk) return undefined;
		const block = (reason: string) => {
			if (worker) {
				const identity = workerIdentity();
				if (identity && event.toolCallId) {
					const fact: GuardStopEvent = {
						owner: "guard",
						...identity,
						toolCallId: event.toolCallId,
						cause: "guard-denial",
						resource: "guard",
						effect: "denied",
					};
					pi.events.emit(GUARD_STOP_EVENT, fact);
				}
			}
			return { block: true, reason };
		};
		if (worker) return block(`Blocked (${risk}): delegate workers can't run this; leave it to the main session.`);
		if (!ctx.hasUI) return block(`Blocked (${risk}): needs explicit user approval; no UI to confirm.`);
		const ok = await ctx.ui.confirm(`Allow ${risk}?`, command);
		return ok ? undefined : block(`Blocked by user (${risk}).`);
	});
}
