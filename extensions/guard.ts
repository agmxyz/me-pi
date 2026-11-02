/**
 * guard — safety net for irreversible bash commands that GLOBAL_AGENTS.md reserves for the user:
 * pushes to main/master, force pushes, history rewrites (`commit --amend`, `rebase`, `filter-*`),
 * `git reset --hard`, `git clean -f`, discarding changes (`git checkout --`/`.`/`-f`, `git restore`
 * of the working tree, `git switch -f`, `git stash drop|clear`), `git branch -D`, and recursive `rm`
 * outside build and temp directories.
 * With a UI it asks for confirmation; without one (print mode) it blocks.
 * `/guard on|off` toggles it for the current session; every session starts on.
 * The Approval policy in GLOBAL_AGENTS.md stays the primary rule; this is a pattern match, not a parser.
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

// Shell options accepted by installer matching and shell `-c` command-position recognition.
const SHELL_OPTION = String.raw`(?:--(?:[\w-]+(?:=\S*)?)?|-\w+)`;
// A command position: start of line/command, after `;`, `&`, `|`, `(`, `{`, `` ` ``, `$(`, a shell keyword
// (`then`, `do`, `else`), a wrapper with its options (`env -i`, `xargs -0`, `sudo`, `nohup`, `time`, `exec`,
// `rtk [proxy]`, `command`), `eval`, `find -exec`, or a shell's `-c` (`bash -lc`, `zsh -c`), plus optional
// `NAME=value` prefixes and a directory path (`/usr/bin/git`). Keeps mentions such as `grep 'git push'` from matching.
const AT_COMMAND = String.raw`(?:^|[;&|(){\x60\n]|\$\(\s*|\b(?:then|do|else)\s+|\b(?:rtk(?:\s+proxy)?|env|command|sudo|xargs|nohup|time|exec)(?:\s+-\S+)*\s+|\beval\s+["']?|\s-exec(?:dir)?\s+|\b(?:ba|z|da|k)?sh\s+(?:${SHELL_OPTION}\s+)*-\w*c\w*\s+["']?)\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:[\w.~-]*\/)*`;
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
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

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

// A heredoc read by `cat` or `git` (`-m "$(cat <<'EOF'`, `commit -F - <<EOF`): its body is text. The opener line is
// kept; a heredoc fed to a shell (`bash <<EOF`) is still scanned.
const TEXT_HEREDOC = /((?:\bcat|\bgit\s[^;&|\n]*?)\s*<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n\t*\3(?=\n|$)/g;

// Empties quoted commit messages, unless they run a command, and text heredoc bodies.
function withoutMessages(command: string): string {
	return command
		.replace(TEXT_HEREDOC, "$1")
		.replace(MESSAGE_ARG, (arg, flag: string, message: string) =>
			message.startsWith('"') && /\$\(|\x60/.test(message) ? arg : `${flag}""`,
		);
}

// `V=$(mktemp -d …) && cd "$V"` opening a command: its git commands then run in a fresh temp repo.
const FRESH_TEMP_REPO =
	/^\s*(\w+)=\$\(mktemp -d[^()$\x60;&|]*\)\s*(?:&&|;)\s*cd\s+(?:"\$\{?\1\}?"|\$\{?\1\}?)\s*(?:&&|;)/;
// What could take git out of it: any other expansion, an absolute, home, or `..` path, or a git-dir override.
const LEAVES_TEMP =
	/[$\x60~]|(?:^|[\s=:"'(])(?:\/|\.\.(?:[/\s"')]|$))|(?:^|\s)(?:-C|--git-dir|--work-tree)\b|\bGIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|CONFIG\w*|NAMESPACE)=/;

/** Whether every git command in `command` runs in the fresh temp repo it opens with; reassigning the variable or a path that could leave it keeps the git rules. */
function inFreshTempRepo(command: string): boolean {
	const fresh = FRESH_TEMP_REPO.exec(command);
	if (!fresh) return false;
	const name = fresh[1];
	const rest = command.slice(fresh[0].length);
	if (new RegExp(`\\b${name}=`).test(rest)) return false;
	return !LEAVES_TEMP.test(rest.replace(new RegExp(`"\\$\\{?${name}\\}?"|\\$\\{?${name}\\}?(?!\\w)`, "g"), "TEMP"));
}

export function classify(
	command: string,
	currentBranch: () => string | undefined = () => undefined,
): string | undefined {
	command = withoutMessages(command);
	const gitCommands = inFreshTempRepo(command) ? [] : [...command.matchAll(GIT_COMMAND)];
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

// Worker-only rules for the delegate `implement` role: commands that move its checkout off the job's branch, pull in
// other history, or reach shared state (refs, the common dir's config, remotes, GitHub, Pi's settings).
// Always blocked, no prompt.
const GH_COMMAND = new RegExp(`${AT_COMMAND}gh(?![\\w.-])`);
const PI_COMMAND = new RegExp(`${AT_COMMAND}pi\\s+(install|remove|uninstall|update|config)(?![\\w-])`);
// `./install.sh`, `/abs/install.sh`, `sh|bash|zsh [opts] install.sh`, or `.`/`source install.sh`; not `install.test.sh`.
// A simple shell `-n install.sh` invocation only parses syntax, so don't classify that filename as an execution.
const INSTALL_SYNTAX_CHECK = String.raw`(?:ba|z)?sh\s+-n\s+(?:[\w.~-]*\/)*install\.sh(?![\w.-])`;
const INSTALL_SH = new RegExp(
	`${AT_COMMAND}(?!${INSTALL_SYNTAX_CHECK})(?:(?:(?:ba|z)?sh|source|\\.)\\s+(?:${SHELL_OPTION}\\s+)*(?:[\\w.~-]*\\/)*)?install\\.sh(?![\\w.-])`,
);
// `git config` forms that only read.
const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope"]);
// Options that keep `git config <key>` a read: scopes and value types (`--type X` is dropped first).
const CONFIG_READ_OPTIONS = new Set(["--local", "--global", "--system", "--worktree", "--bool", "--int", "--path"]);

function workerGitRisk(sub: string, words: string[]): string | undefined {
	switch (sub) {
		case "push":
			return "git push is main-session only";
		case "worktree":
			return "git worktree (adds checkouts that share the repo; main-session only)";
		case "switch":
		case "checkout":
			return `git ${sub} (stay on the job's branch)`;
		case "merge":
		case "cherry-pick":
		case "pull":
			return `git ${sub} (commit only your own changes)`;
		case "stash":
			// `git stash list|show` only read.
			return words[0] === "list" || words[0] === "show" ? undefined : "git stash (leave failing work uncommitted)";
		case "commit":
			return hasShort(words, "n", "--no-verify") ? "git commit --no-verify (hooks must run)" : undefined;
		case "config": {
			if (words[0] === "get" || words[0] === "list" || words.some((w) => CONFIG_READS.has(w))) return undefined;
			const rest = words.filter((w, i) => w !== "--type" && words[i - 1] !== "--type" && !w.startsWith("--type="));
			const positional = rest.filter((w) => !w.startsWith("-"));
			const readKey = positional.length === 1 && rest.every((w) => !w.startsWith("-") || CONFIG_READ_OPTIONS.has(w));
			return readKey ? undefined : "git config write (shared with the main checkout)";
		}
		case "remote":
			return "git remote (shared with the main checkout)";
		case "update-ref":
			return "git update-ref (moves shared refs)";
		case "symbolic-ref":
			// Reads (`-q HEAD`, `--short HEAD`) pass; setting or deleting a symbolic ref does not.
			return words.filter((w) => !w.startsWith("-")).length >= 2 || hasShort(words, "d", "--delete")
				? "git symbolic-ref (moves shared refs)"
				: undefined;
		case "branch":
			return hasShort(words, "[mM]", "--move") ? "git branch -m (renames shared refs)" : undefined;
		case "tag":
			return hasShort(words, "[fd]") || words.includes("--force") || words.includes("--delete")
				? "git tag -f/-d (moves shared refs)"
				: undefined;
		default:
			return undefined;
	}
}

export function workerRisk(command: string): string | undefined {
	command = withoutMessages(command);
	for (const [, , sub, args] of inFreshTempRepo(command) ? [] : command.matchAll(GIT_COMMAND)) {
		const risk = workerGitRisk(sub, wordsOf(args));
		if (risk) return risk;
	}
	if (GH_COMMAND.test(command)) return "gh is main-session only";
	if (INSTALL_SH.test(command)) return "install.sh would change Pi's settings and live links";
	const pi = command.match(PI_COMMAND);
	if (pi) return `pi ${pi[1]} would change Pi's settings`;
	return undefined;
}

// Subcommands that change the index, the working tree, HEAD, or the branch: blocked in the main session while an
// implement worker writes in the same checkout. Reads (`git log`, `status`, `diff`, `stash list|show`) pass.
const TREE_WRITES = new Set([
	"add",
	"rm",
	"mv",
	"commit",
	"merge",
	"rebase",
	"reset",
	"restore",
	"checkout",
	"switch",
	"stash",
	"cherry-pick",
	"revert",
	"am",
	"apply",
	"pull",
	"clean",
	"update-index",
	"read-tree",
	"checkout-index",
	"sparse-checkout",
	"submodule",
	"update-ref",
	"symbolic-ref",
]);

// The first git subcommand in `command` that writes the checkout (`"commit"`), or undefined.
export function gitTreeWrite(command: string): string | undefined {
	for (const [, , sub, args] of withoutMessages(command).matchAll(GIT_COMMAND)) {
		// `git stash list|show` only read.
		const words = wordsOf(args);
		if (sub === "stash" && ["list", "show"].includes(words[0])) continue;
		// `git branch` writes when it forces, moves, or deletes a branch; listing and creating pass.
		if (
			sub === "branch" &&
			(hasShort(words, "[fmMdD]") || ["--force", "--move", "--delete"].some((w) => words.includes(w)))
		)
			return sub;
		if (TREE_WRITES.has(sub)) return sub;
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
		const block = (reason: string) => {
			if (process.env.ME_PI_RUN === "1") {
				const jobId = process.env.ME_PI_DELEGATE_JOB_ID;
				const attempt = Number(process.env.ME_PI_DELEGATE_ATTEMPT);
				if (jobId && Number.isSafeInteger(attempt) && attempt > 0 && event.toolCallId) {
					const fact: GuardStopEvent = {
						owner: "guard",
						jobId,
						attempt,
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
		if (!ctx.hasUI) return block(`Blocked (${risk}): needs explicit user approval; no UI to confirm.`);
		const ok = await ctx.ui.confirm(`Allow ${risk}?`, command);
		return ok ? undefined : block(`Blocked by user (${risk}).`);
	});
}
