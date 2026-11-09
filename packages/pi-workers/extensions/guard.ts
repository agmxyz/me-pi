/**
 * Safety net for really dangerous bash commands: a recursive rm outside every repo (or of a repo root or `.git`),
 * discarding uncommitted work, and force pushes or pushes to main/master on a network remote (`guard-policy.ts`).
 * With a UI it asks for confirmation; without one (print mode) it blocks. In a delegate worker it always blocks, and
 * keeps blocking the history rewrites the main session no longer asks about (amend, rebase, filter-branch/-repo,
 * `branch -D`).
 * `/guard on|off` toggles it for the current session; every session starts on.
 * The Approval policy in GLOBAL_AGENTS.md stays the primary rule; this is a guardrail, not a sandbox.
 */

import { homedir } from "node:os";
import { posix } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isWorkerProcess, workerIdentity } from "./delegate-env.ts";
import {
	branchOf,
	dirtIn,
	isCheckoutRef,
	pushUrlsOf,
	remoteUrlOf,
	repoRootOf,
	startBudget,
	urlRewritesOf,
} from "./guard-disk.ts";
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
	return {
		cwd,
		home: homedir(),
		branch: () => branchOf(cwd),
		branchOf,
		repoRootOf,
		remoteUrlOf,
		pushUrlsOf,
		urlRewritesOf,
		isCheckoutRef,
	};
}

/** Whether a case-2 finding's work is at risk now: uncommitted changes there, or a repo that can't be read. */
function atRisk(f: Finding): boolean {
	const d = f.dirty;
	if (!d || d.always || d.repo === undefined) return true;
	const { repo } = d;
	const paths = d.paths?.map((p) => posix.relative(repo, p));
	const whole = paths === undefined || paths.some((p) => p === "" || p.startsWith(".."));
	return dirtIn(repo, whole ? undefined : paths, d.untracked, d.ignored) !== "clean";
}

/** How `guardRisk` judges: `parser` false means the grammar failed to load; `judge` is injectable for tests. */
export interface GuardOptions {
	parser: boolean;
	worker: boolean;
	judge?: typeof policy;
}

/**
 * Why `command` needs approval (main session) or is blocked (worker), or undefined when it may run. Without the parser,
 * guard 0.1.3's regex verdict judges the whole command.
 */
export function guardRisk(
	command: string,
	cwd: string,
	{ parser, worker, judge = policy }: GuardOptions,
): string | undefined {
	startBudget();
	const regex = () => classify(command, () => branchOf(cwd));
	if (!parser) return regex();
	let v: ReturnType<typeof policy>;
	try {
		v = judge(command, liveEnv(cwd));
	} catch (error) {
		// A parser or policy bug must not let a command through unjudged, nor stop guard: fail closed on this one, and
		// say so even when 0.1.3's rules also object.
		const why = error instanceof Error ? error.message : String(error);
		const failed = `guard could not judge this command (${why})`;
		const reason = regex();
		return reason ? `${reason}; ${failed}` : failed;
	}
	const risks = v.findings
		.filter((f) => f.level === "ask" || atRisk(f))
		.map((f) => (f.level === "ask-if-dirty" ? `${f.detail} (uncommitted work would be lost)` : f.detail));
	if (worker) risks.push(...v.dropped.filter((d) => d.rule === "history").map((d) => `${d.detail} (workers)`));
	return risks.length ? [...new Set(risks)].join("; ") : undefined;
}

export default function (pi: ExtensionAPI) {
	registerGuard(pi);
}

// A parser that hasn't loaded by then counts as failed: guard never waits on it longer (it loads in ~10 ms).
export const PARSER_LOAD_TIMEOUT_MS = 5_000;

/** The extension, with the parser loader and the policy injectable so tests can make them fail. */
export function registerGuard(
	pi: ExtensionAPI,
	loadParser: () => Promise<void> = initShell,
	judge: typeof policy = policy,
	loadTimeoutMs = PARSER_LOAD_TIMEOUT_MS,
) {
	let enabled = true;
	// Loaded once, in the background, so startup never waits on it; the first bash call awaits it, at most
	// `loadTimeoutMs`.
	let loadError: string | undefined;
	let warned = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`not loaded after ${loadTimeoutMs} ms`)), loadTimeoutMs);
	});
	const ready = Promise.race([loadParser(), timeout])
		.then(
			() => true,
			(error: unknown) => {
				loadError = error instanceof Error ? error.message : String(error);
				return false;
			},
		)
		.finally(() => clearTimeout(timer));

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
		const risk = guardRisk(command, ctx.cwd, { parser, worker, judge });
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
		const ok = await ctx.ui.confirm(`guard: allow this command? ${risk}`, command);
		return ok ? undefined : block(`Blocked by user (${risk}).`);
	});
}
