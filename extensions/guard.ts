/**
 * guard — minimal safety net for irreversible bash commands: pushing to main/master and `rm -f`.
 * With a UI it asks for confirmation; without one (print mode, delegated workers) it blocks.
 * `/guard on|off` toggles it for the current session; every session starts on.
 * The `## Authorization` policy in GLOBAL_AGENTS.md stays the primary rule; extend this as cases come up.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// A command position: start of line/command, after `;`, `&`, `|`, `(`, `` ` ``, `$(`, or after
// `rtk [proxy]`/`env`/`command`/`sudo`/`sh -c`, plus optional `NAME=value` prefixes.
// Keeps mentions such as `grep 'git push'` from matching.
const AT_COMMAND = String.raw`(?:^|[;&|()\x60\n]|\$\(\s*|\b(?:rtk(?:\s+proxy)?|env|command|sudo)\s+|\b(?:ba)?sh\s+-c\s+["']?)\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*`;
// `git` plus global options (`-C dir`, `-c k=v`, `--git-dir=...`) before the subcommand.
const GIT = String.raw`${AT_COMMAND}git(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--(?:git-dir|work-tree|namespace|super-prefix)(?:=\S*|\s+(?:"[^"]*"|'[^']*'|\S+))|--?[\w-]+(?:=\S*)?))*\s+`;
// Rest of the same command (stops at a command separator).
const ARGS = String.raw`[^;&|\n]*`;

const GIT_PUSH = new RegExp(`${GIT}push(?![\\w-])(${ARGS})`, "g");
const RM_FORCE = new RegExp(`${AT_COMMAND}rm(?=${ARGS}\\s(?:-\\w*f|--force\\b))`);
const PROTECTED_BRANCHES = new Set(["main", "master"]);

// `git push [opts] [remote] [refspec...]`: a refspec's destination is after `:`; with no refspec
// (or `HEAD`) the current branch is pushed.
function pushesProtected(args: string, currentBranch: () => string | undefined): boolean {
	const words = args.trim().split(/\s+/).filter(Boolean);
	if (words.includes("--all") || words.includes("--mirror")) return true;
	const refspecs = words.filter((w) => !w.startsWith("-")).slice(1);
	const targets = refspecs.length ? refspecs.map((r) => r.replace(/^\+/, "").split(":").pop() ?? "") : ["HEAD"];
	return targets.some((target) => {
		const branch = target === "HEAD" ? currentBranch() : target.replace(/^refs\/heads\//, "");
		return branch !== undefined && PROTECTED_BRANCHES.has(branch);
	});
}

export function classify(command: string, currentBranch: () => string | undefined = () => undefined): string | undefined {
	for (const match of command.matchAll(GIT_PUSH)) {
		if (pushesProtected(match[1], currentBranch)) return "push to main/master";
	}
	if (RM_FORCE.test(command)) return "rm -f";
	return undefined;
}

function branchIn(cwd: string): string | undefined {
	const res = spawnSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
	return res.status === 0 ? res.stdout.trim() : undefined;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

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
		const risk = classify(command, () => branchIn(ctx.cwd));
		if (!risk) return undefined;
		if (!ctx.hasUI) return { block: true, reason: `Blocked (${risk}): needs explicit user approval; no UI to confirm.` };
		const ok = await ctx.ui.confirm(`Allow ${risk}?`, command);
		return ok ? undefined : { block: true, reason: `Blocked by user (${risk}).` };
	});
}
