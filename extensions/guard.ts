/**
 * guard — safety net for irreversible bash commands that GLOBAL_AGENTS.md reserves for the user:
 * pushes to main/master, force pushes, history rewrites (`commit --amend`, `rebase`, `filter-*`),
 * `git reset --hard`, `git clean -f`, discarding changes (`git checkout --`/`.`/`-f`, `git restore`
 * of the working tree, `git switch -f`, `git stash drop|clear`), `git branch -D`, and recursive `rm`
 * outside build and temp directories.
 * With a UI it asks for confirmation; without one (print mode) it blocks.
 * `/guard on|off` toggles it for the current session; every session starts on.
 * The `## Authorization` policy stays the primary rule; this is a pattern match, not a parser.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// A command position: start of line/command, after `;`, `&`, `|`, `(`, `{`, `` ` ``, `$(`, a shell keyword
// (`then`, `do`, `else`), a wrapper with its options (`env -i`, `xargs -0`, `sudo`, `nohup`, `time`, `exec`,
// `rtk [proxy]`, `command`), `eval`, `find -exec`, or a shell's `-c` (`bash -lc`, `zsh -c`), plus optional
// `NAME=value` prefixes and a directory path (`/usr/bin/git`). Keeps mentions such as `grep 'git push'` from matching.
const AT_COMMAND = String.raw`(?:^|[;&|(){\x60\n]|\$\(\s*|\b(?:then|do|else)\s+|\b(?:rtk(?:\s+proxy)?|env|command|sudo|xargs|nohup|time|exec)(?:\s+-\S+)*\s+|\beval\s+["']?|\s-exec(?:dir)?\s+|\b(?:ba|z|da|k)?sh\s+(?:-\w+\s+)*-\w*c\w*\s+["']?)\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:[\w.~-]*\/)*`;
// `git` global options (`-C dir`, `-c k=v`, `--git-dir=...`) before the subcommand.
const GIT_GLOBALS = String.raw`(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--(?:git-dir|work-tree|namespace|super-prefix)(?:=\S*|\s+(?:"[^"]*"|'[^']*'|\S+))|--?[\w-]+(?:=\S*)?))*`;
// Rest of the same command (stops at a command separator).
const ARGS = String.raw`[^;&|\n]*`;

// Lookaheads, so a command nested in another one's arguments (`git log "$(git push ...)"`) is found too.
const GIT_COMMAND = new RegExp(`(?=${AT_COMMAND}git(${GIT_GLOBALS})\\s+([\\w-]+)(${ARGS}))`, "g");
const RM_COMMAND = new RegExp(`(?=${AT_COMMAND}rm(?![\\w-])(${ARGS}))`, "g");
// A quoted commit message (`-m "..."`, `-am '...'`, `--message=...`) is text, unless it runs a command.
const MESSAGE_ARG = /(\s(?:-[A-Za-z]*m\s*|--message(?:=|\s+)))("(?:[^"\\]|\\.)*"|'[^']*')/g;
// `cd` at a command position: a bare push may then target another repository's branch.
const CD = new RegExp(`${AT_COMMAND}(?:cd|pushd)(?![\\w-])`);
// Build directories and named entries inside temp directories that recursive `rm` may remove without
// asking (`./dist`, `/tmp/x`, `${TMPDIR:?}/x`). Never a temp root or a glob in it (`/tmp/*`), and never
// bare `$TMPDIR/…`, which becomes `/…` when TMPDIR is unset.
// A named entry, then optionally a path inside it (`/tmp/x/*` is fine; `/tmp/x*` is not).
const TEMP_ENTRY = String.raw`[^/*?\s]+(?:/\S*)?$`;
const DISPOSABLE = new RegExp(
	String.raw`^(?:(?:\./)?(?:node_modules|dist|build|out|target|coverage|\.cache|\.next|\.turbo|tmp)(?:/|$)|(?:/private)?/tmp/${TEMP_ENTRY}|/var/folders/[^/*?\s]+/[^/*?\s]+/[^/*?\s]+/${TEMP_ENTRY}|\$\{TMPDIR:\?\}/${TEMP_ENTRY})`,
);
// Push options whose value is a separate word, so it is not mistaken for the remote or a refspec.
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
const PROTECTED_BRANCHES = new Set(["main", "master"]);

// Arguments as words, without quotes, parentheses, and backticks (`"main"`, `main)`, `main"`).
function wordsOf(args: string): string[] {
	return args
		.split(/\s+/)
		.map((w) => w.replace(/["'()\x60]/g, ""))
		.filter(Boolean);
}

// `-f`, `--force`, or a short-option cluster containing the letter (`-fd`).
function hasShort(words: string[], letter: string, long?: string): boolean {
	return words.some((w) => (long !== undefined && w === long) || new RegExp(`^-[A-Za-z]*${letter}[A-Za-z]*$`).test(w));
}

// `git push [opts] [remote] [refspec...]`: a refspec's destination is after `:`; with no refspec
// (or `HEAD`) the current branch is pushed, which is unknown when the command changes directory.
function pushRisk(words: string[], currentBranch: () => string | undefined, elsewhere: boolean): string | undefined {
	if (hasShort(words, "f", "--force") || words.some((w) => w.startsWith("--force-") || /^\+/.test(w)))
		return "force push";
	if (words.includes("--all") || words.includes("--mirror")) return "push to main/master";
	const positional = words.filter((w, i) => !w.startsWith("-") && !PUSH_VALUE_OPTIONS.has(words[i - 1]));
	// `--repo` names the remote, so every positional word is a refspec.
	const hasRepo = words.some((w, i) => w.startsWith("--repo=") || (w === "--repo" && i < words.length - 1));
	const refspecs = hasRepo ? positional : positional.slice(1);
	const targets = refspecs.length ? refspecs.map((r) => r.split(":").pop() ?? "") : ["HEAD"];
	if (elsewhere && targets.includes("HEAD")) return "push after changing directory or branch (target unknown)";
	const protectedTarget = targets.some((target) => {
		const branch = target === "HEAD" ? currentBranch() : target.replace(/^refs\/heads\//, "");
		return branch !== undefined && PROTECTED_BRANCHES.has(branch);
	});
	return protectedTarget ? "push to main/master" : undefined;
}

function gitRisk(
	sub: string,
	words: string[],
	currentBranch: () => string | undefined,
	elsewhere: boolean,
): string | undefined {
	switch (sub) {
		case "push":
			return pushRisk(words, currentBranch, elsewhere);
		case "commit":
			return words.includes("--amend") ? "history rewrite (commit --amend)" : undefined;
		case "rebase":
			return ["--abort", "--continue", "--skip", "--quit"].some((w) => words.includes(w))
				? undefined
				: "history rewrite (rebase)";
		case "filter-branch":
		case "filter-repo":
			return `history rewrite (${sub})`;
		case "switch":
			return hasShort(words, "f", "--force") || words.includes("--discard-changes")
				? "discard changes (git switch)"
				: undefined;
		case "stash":
			return words[0] === "drop" || words[0] === "clear" ? `git stash ${words[0]}` : undefined;
		case "reset":
			return words.includes("--hard") ? "git reset --hard" : undefined;
		case "clean":
			return hasShort(words, "f", "--force") && !hasShort(words, "n", "--dry-run") ? "git clean -f" : undefined;
		case "checkout":
			return words.includes("--") || words.includes(".") || hasShort(words, "f", "--force")
				? "discard changes (git checkout)"
				: undefined;
		case "restore": {
			const staged = hasShort(words, "S", "--staged");
			const worktree = hasShort(words, "W", "--worktree");
			return !staged || worktree ? "discard changes (git restore)" : undefined;
		}
		case "branch":
			return hasShort(words, "D") || (hasShort(words, "d", "--delete") && hasShort(words, "f", "--force"))
				? "git branch -D"
				: undefined;
		default:
			return undefined;
	}
}

export function classify(
	command: string,
	currentBranch: () => string | undefined = () => undefined,
): string | undefined {
	command = command.replace(MESSAGE_ARG, (arg, flag: string, message: string) =>
		message.startsWith('"') && /\$\(|\x60/.test(message) ? arg : `${flag}""`,
	);
	const gitCommands = [...command.matchAll(GIT_COMMAND)];
	// The session's branch is read before the command runs, so it says nothing about the target after
	// `cd`, `git checkout`/`switch`, or `git -C`/`--git-dir`/`--work-tree`.
	const branchMayChange = CD.test(command) || gitCommands.some(([, , sub]) => sub === "checkout" || sub === "switch");
	for (const [, globals, sub, args] of gitCommands) {
		const elsewhere = branchMayChange || /(?:^|\s)(?:-C|--git-dir|--work-tree)\b/.test(globals);
		const risk = gitRisk(sub, wordsOf(args), currentBranch, elsewhere);
		if (risk) return risk;
	}
	for (const [, args] of command.matchAll(RM_COMMAND)) {
		const words = wordsOf(args);
		if (!hasShort(words, "[rR]", "--recursive")) continue;
		// Not targets: options, `find -exec` placeholders, and redirections (`2>/dev/null`, `> log`).
		const isRedirect = (w: string | undefined) => w !== undefined && /^\d*(?:[<>]+|>&)\d*$/.test(w);
		const targets = words.filter(
			(w, i) => !w.startsWith("-") && w !== "{}" && w !== "\\" && !/^\d*[<>]/.test(w) && !isRedirect(words[i - 1]),
		);
		const disposable =
			targets.length > 0 && targets.every((t) => DISPOSABLE.test(t) && !/(?:^|\/)\.\.(?:\/|$)/.test(t));
		if (!disposable) return "recursive rm";
	}
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
		if (!ctx.hasUI)
			return { block: true, reason: `Blocked (${risk}): needs explicit user approval; no UI to confirm.` };
		const ok = await ctx.ui.confirm(`Allow ${risk}?`, command);
		return ok ? undefined : { block: true, reason: `Blocked by user (${risk}).` };
	});
}
