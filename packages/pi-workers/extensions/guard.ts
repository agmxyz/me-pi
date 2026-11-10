/**
 * Safety net for irreversible bash commands (force push, main push, history rewrites, resets, discards, recursive rm).
 * With a UI it asks for confirmation; without one (print mode) it blocks. Plain history rewrites only block in
 * delegate workers; ones that run a command (`rebase -x`, an editor override, a `filter-branch` command filter or
 * `--setup`) ask in every session (see `classify`). So do git options and env that run a command (`-c alias.x=…`,
 * `--upload-pack`, `submodule foreach`, `GIT_SSH_COMMAND`, `GIT_PAGER`, `git config core.pager …`).
 * `/guard on|off` toggles it for the current session; every session starts on.
 * This is the only rule for local git and rm safety. It's a pattern match, not a parser: it sees bash only, and
 * misses commands it can't read (interpreter code, a non-recursive rm).
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isImplementWorker, isWorkerProcess, workerIdentity } from "./delegate-env.ts";

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
// `NAME=value` or `NAME+=value` prefixes and a directory path (`/usr/bin/git`). Keeps mentions such as
// `grep 'git push'` from matching.
const AT_COMMAND = String.raw`(?:^|[;&|(){\x60\n]|\$\(\s*|\b(?:then|do|else)\s+|\b(?:rtk(?:\s+proxy)?|env|command|sudo|xargs|nohup|time|exec)(?:\s+-\S+)*\s+|\beval\s+["']?|\s-exec(?:dir)?\s+|\b(?:ba|z|da|k)?sh\s+(?:${SHELL_OPTION}\s+)*-\w*c\w*\s+["']?)\s*(?:[A-Za-z_]\w*\+?=(?:"[^"]*"|'[^']*'|\S*)\s+)*(?:[\w.~-]*\/)*`;
// `git` global options (`-C dir`, `-c k=v`, `-c k='a b'`, `--git-dir=...`, `--exec-path dir`) before the subcommand.
const GIT_GLOBALS = String.raw`(?:\s+(?:-[Cc]\s+(?:[^\s"']|"[^"]*"|'[^']*')+|--(?:git-dir|work-tree|namespace|super-prefix|exec-path)(?:=\S*|\s+(?:"[^"]*"|'[^']*'|\S+))|--?[\w-]+(?:=\S*)?))*`;
// Rest of the same command: steps over redirects that contain `&` or `|` (`2>&1`, `>&2`, `&>`, `&>>`, `>|`), so words
// after them are still read. Stops at `;`, `&&`, `||`, `|`, `|&`, a lone `&`, and newline.
const ARGS = String.raw`(?:[<>]&|&>|>\||[^;&|\n])*`;

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
// `${TMPDIR:?}` is the session's temp dir only if the command can't rebind TMPDIR first (`TMPDIR=/ rm …`,
// `export TMPDIR=/;`, `sudo`, `z=TMP; z+=DIR=/; ((z))`, `bash -c '…'` reading rc files). Fail closed: outside those
// expansions, the command must be plain characters (no expansion, assignment, arithmetic, brace, glob, escape, or single
// quote), never spell `TMP` or `DIR` once quotes are dropped (`TMP""DIR`), and call nothing that changes the environment
// or writes a variable, at any position, including `.` at a command start unless a path continues it (`.>/dev/null v`
// sources). A false prompt is fine; a miss is not.
const TMPDIR_REF = `\${TMPDIR:?}`;
const NOT_PLAIN = /[^\w\s/.,:@%+&|;>"-]/;
const REBINDS_ENV =
	/TMP|DIR|(?<![\w-])(?:env|sudo|doas|su|runuser|pkexec|export|unset|set|source|declare|local|typeset|readonly|read|readarray|mapfile|printf|getopts|eval|let|builtin|enable|exec|select|trap|alias|fc|history)(?![\w-])|(?:^|[\s;&|(])\.(?![\w./-])/;

function tmpdirMayChange(command: string): boolean {
	const rest = command.replaceAll(TMPDIR_REF, "");
	return NOT_PLAIN.test(rest) || REBINDS_ENV.test(rest.replace(/["']/g, ""));
}

// Push options whose value is a separate word, so it is not mistaken for the remote or a refspec.
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
export const PROTECTED_BRANCHES: ReadonlySet<string> = new Set(["main", "master"]);

/**
 * git's words, without redirects (`2>&1`, `>/dev/null`, `&> log`, and the file after a bare operator): a redirect is not
 * a remote or refspec (`git push origin 2>&1` pushes the current branch, #93). A word with a glued redirect
 * (`origin>log`, `--force&>log`) keeps the part before it. With quotes or escapes in the arguments, a glued `<>&|`
 * can't be told from a quoted one (`"a>b:main"`), so the whole words are a second reading; callers judge each and
 * take the riskiest.
 */
function gitReadings(args: string): string[][] {
	const raw = args.split(/\s+/).filter(Boolean);
	const cut = raw.flatMap((w, i) => {
		if (REDIRECT.test(w) || (i > 0 && REDIRECT_OPERATOR.test(raw[i - 1]))) return [];
		const at = w.search(/[<>&|]/);
		return at > 0 ? [w.slice(0, at)] : [w];
	});
	const readings = [wordsOf(cut.join(" "))];
	if (/["'\\]/.test(args) && raw.some((w) => /[<>&|]/.test(w))) readings.push(wordsOf(args));
	return readings;
}

// Arguments as words, without quotes, parentheses, and backticks (`"main"`, `main)`).
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

// Anywhere in the command, since `GIT_COMMAND` doesn't capture env prefixes: an editor variable assignment
// (`X=… git`, `env X=…`, `export X=…`) or a `core.editor`/`sequence.editor` config (`-c`, `--config-env`).
const EDITOR_OVERRIDE = /(?<![\w-])(?:GIT_SEQUENCE_EDITOR|GIT_EDITOR|VISUAL|EDITOR)\+?=|(?:core|sequence)\.editor/i;
// `filter-branch` options that run a command (the filters and `--setup`); `--subdirectory-filter` doesn't.
const COMMAND_FILTER = /^--(?:(?:tree|index|msg|env|commit|parent|tag-name)-filter|setup)(?:=|$)/;
// `rebase --exec` or a unique prefix git accepts (`--ex`, `--exe`); `-x cmd`, glued `-xcmd`, or a short cluster
// holding x (`-ix`). A cluster where x is another option's glued value matches too, so it fails closed (asks).
const REBASE_EXEC = /^(?:--ex(?:ec?)?(?:=|$)|-[A-Za-z]*x)/;
// Options that resume or stop a rebase in progress.
const REBASE_RESUME = ["--abort", "--continue", "--skip", "--quit"];
// Env that makes git run a command, anywhere in the command (`X=… git`, `env X=…`, `export X=…`); `GIT_CONFIG_*` can set
// any config key, `GIT_TEMPLATE_DIR` installs hooks, and `LESSOPEN`/`LESSCLOSE` run through the default `less` pager.
// `GIT_CONFIG_NOSYSTEM` doesn't match.
const EXEC_ENV =
	/(?<![\w-])(GIT_SSH(?:_COMMAND)?|(?:GIT|SSH)_ASKPASS|GIT_EXTERNAL_DIFF|GIT_PROXY_COMMAND|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|LESS(?:OPEN|CLOSE)|GIT_CONFIG(?:_COUNT|_(?:KEY|VALUE)_\d+|_PARAMETERS|_GLOBAL|_SYSTEM)?)\+?=/;
// An editor variable assignment (`GIT_EDITOR=…`), case-sensitive, so a `core.editor` key or `editor=` text doesn't match;
// `-c core.editor=…` and `git config core.editor …` are config writes.
const EDITOR_ENV = /(?<![\w.-])(?:GIT_SEQUENCE_EDITOR|GIT_EDITOR|VISUAL|EDITOR)\+?=/;
// A pager set to anything but `cat` or empty (`GIT_PAGER=cat`, `PAGER=''` stay quiet); `+=` appends to an unknown value.
const PAGER_ENV = /(?<![\w-])((?:GIT_)?PAGER)(?:\+=|=(?!(?:cat|'cat'|"cat"|''|"")?(?:[\s;&|)\x60]|$)))/;
// `--config-env` reads any config value from the environment.
const CONFIG_ENV = /(?<![\w-])--config-env(?![\w-])/;
// Config keys that never run a command, for `git -c` and `git config` writes; `*` is one section or subkey segment.
const SAFE_CONFIG_KEYS = [
	"user.*",
	"color.*",
	"advice.*",
	"init.defaultBranch",
	"core.quotePath",
	"core.autocrlf",
	"commit.gpgSign",
	"tag.gpgSign",
	"protocol.version",
	"push.default",
	"push.autoSetupRemote",
	"pull.rebase",
	"pull.ff",
	"safe.directory",
];
const SAFE_CONFIG_KEY = new RegExp(
	`^(?:${SAFE_CONFIG_KEYS.map((k) => k.replaceAll(".", "\\.").replaceAll("*", "[^.]+")).join("|")})$`,
	"i",
);
// A pager key: it runs its value, except `cat` or empty.
const PAGER_KEY = /^(?:core\.pager|pager\.[^.]+)$/i;
// A `-c key=value` global option (`-c user.name='a b'`, `-c 'k=v'`).
const CONFIG_OPTION = /(?:^|\s)-c\s+((?:[^\s"']|"[^"]*"|'[^']*')+)/g;
// A `git clone` config option: `-c k=v`, glued or in a short cluster (`-ck=v`, `-qc k=v`), or `--config` or a prefix of it,
// with `=` or a space (`--config=k=v`, `--conf k=v`). A cluster where c is another option's glued value fails closed.
const CLONE_CONFIG_OPTION =
	/(?:^|\s)(?:-[abd-zA-Z]*c\s*|--c(?:o(?:n(?:f(?:i(?:g)?)?)?)?)?(?:=|\s+))((?:[^\s"']|"[^"]*"|'[^']*')+)/g;
// `--exec-path` with a value runs git's commands from there; alone, it prints the path.
const EXEC_PATH = /(?:^|\s)--exec-path(?:=|\s+[^\s;&|])/;
// `git config` options that take the next word as their value.
const CONFIG_VALUE_OPTIONS = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment", "--value"]);
// `git config` forms that only read.
const CONFIG_READS = new Set(["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope"]);
// `git config` forms that read, remove, or edit by hand; `CONFIG_READS` lists the other reads.
const CONFIG_NO_SET = new Set([
	"--unset",
	"--unset-all",
	"--remove-section",
	"--get-color",
	"--get-colorbool",
	"--get-urlmatch",
	"-e",
	"--edit",
]);
const CONFIG_NO_SET_SUBCOMMANDS = new Set(["get", "list", "unset", "remove-section", "edit"]);

// Whether setting `key` to `value` may make git run a command: any key off the safe list, except a pager set to `cat`
// or empty.
function configMayRun(key: string, value: string): boolean {
	if (SAFE_CONFIG_KEY.test(key)) return false;
	return !(PAGER_KEY.test(key) && (value === "cat" || value === ""));
}

// Config options (`CONFIG_OPTION` or `CLONE_CONFIG_OPTION` matches) in `text`; a key without `=` is set to true.
function configOptionRisk(text: string, options: RegExp): string | undefined {
	for (const [, option] of text.matchAll(options)) {
		const [key, ...value] = option.replace(/["']/g, "").split("=");
		if (configMayRun(key, value.length ? value.join("=") : "true")) return `git runs a command (-c ${key})`;
	}
	return undefined;
}

// Global options that run a command: `-c` off the safe keys, or `--exec-path` with a value.
function globalsRisk(globals: string): string | undefined {
	return EXEC_PATH.test(globals) ? "git runs a command (--exec-path)" : configOptionRisk(globals, CONFIG_OPTION);
}

// Whether `git config` reads, removes, or edits by hand: a subcommand (`get`, `unset`) or a flag before the key (`--get`,
// `--unset`). After the key, a word is part of the value (`alias.x '!cmd -l'`).
function configLeavesValues(words: string[]): boolean {
	if (CONFIG_NO_SET_SUBCOMMANDS.has(words[0])) return true;
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		if (CONFIG_READS.has(w) || CONFIG_NO_SET.has(w)) return true;
		if (CONFIG_VALUE_OPTIONS.has(w)) i++;
		else if (!w.startsWith("-")) return false;
	}
	return false;
}

// `git config [set] [opts] <key> <value>...`: reads, removals, and `<key>` alone are quiet. Value words are rejoined with
// single spaces, so only a plain `cat` counts as `cat`.
function configWriteRisk(words: string[]): string | undefined {
	if (configLeavesValues(words)) return undefined;
	// Renaming a section can move any keys into place.
	if (words[0] === "rename-section" || words.includes("--rename-section"))
		return "git runs a command (git config rename-section)";
	let key: string | undefined;
	const value: string[] = [];
	const rest = words[0] === "set" ? words.slice(1) : words;
	for (let i = 0; i < rest.length; i++) {
		const w = rest[i];
		if (key !== undefined) value.push(w);
		else if (CONFIG_VALUE_OPTIONS.has(w)) i++;
		else if (!w.startsWith("-")) key = w;
	}
	if (key === undefined || !value.length) return undefined;
	return configMayRun(key, value.join(" ")) ? `git runs a command (git config ${key})` : undefined;
}

// A long option or a prefix git accepts for it (`--u` for `--upload-pack`), with or without `=value`. Any prefix of at
// least one letter counts; one git finds ambiguous fails closed.
function hasLong(words: string[], name: string): boolean {
	return words.some((w) => {
		const option = w.split("=")[0];
		return option.length >= 3 && name.startsWith(option);
	});
}

// Subcommand options that run a user-supplied command. A short cluster holding the letter (`-nO`) matches, even where it
// is another option's glued value, so it fails closed.
function gitRunsCommand(sub: string, words: string[]): string | undefined {
	const label = (what: string) => `git runs a command (${what})`;
	switch (sub) {
		case "submodule":
			return words.includes("foreach") ? label("submodule foreach") : undefined;
		case "clone":
		case "fetch":
		case "pull":
		case "ls-remote":
		case "fetch-pack":
			// `-u` is `--upload-pack` only on clone (`fetch -u` is `--update-head-ok`).
			if (sub === "clone" && words.some((w) => /^-[A-Za-z]*u/.test(w))) return label("clone -u");
			// A template directory's hooks run during the clone.
			if (sub === "clone" && hasLong(words, "--template")) return label("clone --template");
			if (sub === "fetch-pack" && hasLong(words, "--exec")) return label("--exec");
			return hasLong(words, "--upload-pack") ? label("--upload-pack") : undefined;
		case "push":
		case "send-pack":
			if (hasLong(words, "--receive-pack")) return label("--receive-pack");
			return hasLong(words, "--exec") ? label("--exec") : undefined;
		case "archive":
			return hasLong(words, "--exec") ? label("archive --exec") : undefined;
		case "grep":
			return words.some((w) => /^-[A-Za-z]*O/.test(w)) || hasLong(words, "--open-files-in-pager")
				? label("grep --open-files-in-pager")
				: undefined;
		case "difftool":
			return words.some((w) => /^-[A-Za-z]*x/.test(w)) || hasLong(words, "--extcmd")
				? label("difftool --extcmd")
				: undefined;
		case "config":
			return configWriteRisk(words);
		default:
			return undefined;
	}
}

// Command-wide env and options that make any git command run a command.
function envRunsCommand(command: string): string | undefined {
	const env = EXEC_ENV.exec(command) ?? PAGER_ENV.exec(command);
	if (env) return `git runs a command (${env[1]})`;
	if (CONFIG_ENV.test(command)) return "git runs a command (--config-env)";
	return EDITOR_ENV.test(command) ? "git runs a command (editor override)" : undefined;
}

// Rewrites that run a command: `rebase -x`, a `filter-branch` command filter or `--setup`, or an editor override on
// `rebase` or `commit --amend`.
function rewriteRunsCommand(sub: string, words: string[], editorOverride: boolean): string | undefined {
	switch (sub) {
		case "commit":
			return editorOverride && words.includes("--amend") ? "history rewrite (editor override)" : undefined;
		case "rebase":
			// A resumed rebase still opens the editor, so an override asks before the resume check.
			if (editorOverride) return "history rewrite (editor override)";
			if (REBASE_RESUME.some((w) => words.includes(w))) return undefined;
			return words.some((w) => REBASE_EXEC.test(w)) ? "history rewrite (rebase --exec)" : undefined;
		case "filter-branch":
			return words.some((w) => COMMAND_FILTER.test(w))
				? "history rewrite (filter-branch command filter)"
				: undefined;
		default:
			return undefined;
	}
}

function gitRisk(
	sub: string,
	words: string[],
	currentBranch: () => string | undefined,
	elsewhere: boolean,
	historyRewrites: boolean,
): string | undefined {
	// `rewriteRunsCommand` covers rewrites that run a command; `historyRewrites` adds the plain rewrite.
	switch (sub) {
		case "push":
			return pushRisk(words, currentBranch, elsewhere);
		case "commit":
			return historyRewrites && words.includes("--amend") ? "history rewrite (commit --amend)" : undefined;
		case "rebase":
			if (REBASE_RESUME.some((w) => words.includes(w))) return undefined;
			return historyRewrites ? "history rewrite (rebase)" : undefined;
		case "filter-branch":
			return historyRewrites ? "history rewrite (filter-branch)" : undefined;
		case "filter-repo":
			// Always: by default it expires every reflog and prunes, so the old history can't be recovered.
			return "history rewrite (filter-repo)";
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
			return historyRewrites &&
				(hasShort(words, "D") || (hasShort(words, "d", "--delete") && hasShort(words, "f", "--force")))
				? "git branch -D"
				: undefined;
		default:
			return undefined;
	}
}

// A heredoc read by `cat` or `git` (`-m "$(cat <<'EOF'`, `commit -F - <<EOF`): its body is text. The opener line is
// kept; a heredoc fed to a shell (`bash <<EOF`) is still scanned.
const TEXT_HEREDOC = /((?:\bcat|\bgit\s[^;&|\n]*?)\s*<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n\t*\3(?=\n|$)/g;
// A command that opens with a program heredoc: `python3 - <<'EOF'` or `node - <<'EOF'`, optionally after `cd <dir> &&`,
// alone on the first line. Its body is a program guard doesn't police (`python3 -c '…'` isn't scanned either). Being
// the first line, it sits in no quote or other heredoc; being the whole line, its output goes to no pipe, file, or
// substitution. Anything else (a later opener, `cat > f`, a second `<<`, a `\` continuation) keeps the body scanned.
const SCRIPT_OPENER =
	/^\s*(?:cd\s+[\w./~-]+\s*&&\s*)?(?:[\w.~-]*\/)*(?:python3?|node)(?:\s+-)?\s*<<(-?)\s*(['"])(\w+)\2\s*$/;

/**
 * Drops the body of a `SCRIPT_OPENER` heredoc, ending it where bash does: at the first line equal to the word (with
 * `<<-`, after leading tabs). Fails closed, returning the command unchanged, on a carriage return or an unterminated
 * body. Lines after the body stay and are scanned as usual.
 */
function withoutScriptHeredoc(command: string): string {
	if (command.includes("\r")) return command;
	const lines = command.split("\n");
	const opener = SCRIPT_OPENER.exec(lines[0]);
	if (!opener) return command;
	const [, dash, , word] = opener;
	const end = lines.findIndex((line, i) => i > 0 && (dash ? line.replace(/^\t+/, "") : line) === word);
	return end < 0 ? command : [lines[0], ...lines.slice(end + 1)].join("\n");
}

// Empties quoted commit messages, unless they run a command, text heredoc bodies, and an opening script heredoc body.
function withoutMessages(command: string): string {
	return withoutScriptHeredoc(command)
		.replace(TEXT_HEREDOC, "$1")
		.replace(MESSAGE_ARG, (arg, flag: string, message: string) =>
			message.startsWith('"') && /\$\(|\x60/.test(message) ? arg : `${flag}""`,
		);
}

// `V=$(mktemp -d …) && cd "$V"` opening a command: its git commands then run in a fresh temp repo.
const FRESH_TEMP_REPO =
	/^\s*(\w+)=\$\(mktemp -d(?:\s+-t\s+[\w.-]+)?\s*\)\s*(?:&&|;)\s*cd\s+(?:"\$\{?\1\}?"|\$\{?\1\}?)\s*(?:&&|;)/;
// What could take git out of it: any other expansion, an absolute, home, or `..` path, a `cd` that is not one plain
// relative path (bare `cd`, `cd -`), `popd`, or a git-dir override.
const LEAVES_TEMP =
	/[$\x60~]|(?:^|[\s=:"'(])(?:\/|\.\.(?:[/\s"')]|$))|(?:^|[;&|(\s])(?:cd|pushd)(?![\w-])(?!\s+["']?[\w.][^\s;&|]*)|(?:^|[;&|(\s])popd(?![\w-])|(?:^|\s)(?:-C|--git-dir|--work-tree)\b|\bGIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|CONFIG\w*|NAMESPACE)=/;

/**
 * Whether every git command in `command` runs in the fresh temp repo it opens with; reassigning the variable or a path
 * that could leave it keeps the git rules. Only implement workers get this: their git remote protocols are cut. Git
 * options and env that run a command still ask there (see `classify`), since cutting remotes doesn't stop them.
 */
function inFreshTempRepo(command: string): boolean {
	if (!isImplementWorker()) return false;
	const fresh = FRESH_TEMP_REPO.exec(command);
	if (!fresh) return false;
	const name = fresh[1];
	const rest = command.slice(fresh[0].length);
	if (new RegExp(`\\b${name}=`).test(rest)) return false;
	return !LEAVES_TEMP.test(rest.replace(new RegExp(`"\\$\\{?${name}\\}?"|\\$\\{?${name}\\}?(?!\\w)`, "g"), "TEMP"));
}

// A redirect word, read before quotes are dropped (a quoted `">"` is an argument): `2>/dev/null`, `&>log`, `>|log`.
const REDIRECT = /^(?:\d*|&)[<>]/;
// A redirect operator whose file is the next word (`> log`, `2>> log`, `&> log`, `>| log`, `>& log`). `2>&1`, `>&2`,
// and `>file` carry their own operand, so the word after them is a target.
const REDIRECT_OPERATOR = /^(?:\d*|&)[<>]+[&|]?$/;

// Reads `rm`'s arguments once: whether it is recursive, and its targets (not options, `find -exec` placeholders, or
// redirects and their files). A word with a glued redirect (`/tmp/&>log`, `dist>log`) yields both the part before it
// (`/tmp/`, what rm gets) and the whole word, so the redirect can neither hide a temp root nor make a word disposable;
// the redirect never takes the next word as its file. An option with a glued redirect (`-rf&>log`) counts as recursive
// with no trusted targets, so it always asks: main asked for `rm -rf&>/dev/null dist`, and this keeps that.
// Targets are undefined when a word holds `<`, `>`, `&`, or `|` in arguments with quotes or escapes: without a
// tokenizer, a quoted character can't be told from a redirect (`"${TMPDIR:?}/"&>log`).
function rmArgs(args: string): { recursive: boolean; targets: string[] | undefined } {
	const quoted = /["'\\]/.test(args);
	const raw = args.split(/\s+/).filter(Boolean);
	if (raw.some((w) => /^["'\\]*-/.test(w) && /[<>&|]/.test(w))) return { recursive: true, targets: undefined };
	const recursive = hasShort(wordsOf(args), "[rR]", "--recursive");
	const targets: string[] = [];
	for (const [i, w] of raw.entries()) {
		if (REDIRECT.test(w) || (i > 0 && REDIRECT_OPERATOR.test(raw[i - 1]))) continue;
		const cut = w.search(/[<>&|]/);
		if (cut >= 0 && quoted) return { recursive, targets: undefined };
		for (const part of cut > 0 ? [w.slice(0, cut), w] : [w]) {
			const word = part.replace(/["'()\x60]/g, "");
			if (word && !word.startsWith("-") && word !== "{}" && word !== "\\") targets.push(word);
		}
	}
	return { recursive, targets };
}

/**
 * `historyRewrites: false` skips `commit --amend`, `rebase`, `filter-branch`, and `branch -D`: the main session runs
 * them without asking, since the reflog, `refs/original/`, or `git fsck` can recover them. Rewrites that run a command
 * (`rebase -x`, a `filter-branch` command filter or `--setup`, or an editor override on `rebase`/`commit --amend`)
 * count in both modes, and `filter-repo` always does. Git options and env that run a command (`-c` off the safe keys,
 * `--upload-pack`, `GIT_SSH_COMMAND`, a pager other than `cat`, an editor override, `git config` writes) ask in both
 * modes too. Workers pass true.
 */
export function classify(
	command: string,
	currentBranch: () => string | undefined = () => undefined,
	{ historyRewrites = true }: { historyRewrites?: boolean } = {},
): string | undefined {
	// Unstripped: a dropped message or heredoc body could hide a rebinding.
	const tmpdirUnsafe = tmpdirMayChange(command);
	command = withoutMessages(command);
	const gitCommands = [...command.matchAll(GIT_COMMAND)];
	// In a fresh temp repo, only the checks for git running a command apply.
	const freshTemp = inFreshTempRepo(command);
	// The session's branch is read before the command runs, so it says nothing about the target after
	// `cd`, `git checkout`/`switch`, or `git -C`/`--git-dir`/`--work-tree`.
	const branchMayChange = CD.test(command) || gitCommands.some(([, , sub]) => sub === "checkout" || sub === "switch");
	const editorOverride = EDITOR_OVERRIDE.test(command);
	const envRisk = gitCommands.length ? envRunsCommand(command) : undefined;
	for (const [, globals, sub, args] of gitCommands) {
		const elsewhere = branchMayChange || /(?:^|\s)(?:-C|--git-dir|--work-tree)\b/.test(globals);
		for (const words of gitReadings(args)) {
			const risk =
				rewriteRunsCommand(sub, words, editorOverride) ??
				(freshTemp ? undefined : gitRisk(sub, words, currentBranch, elsewhere, historyRewrites)) ??
				gitRunsCommand(sub, words);
			if (risk) return risk;
		}
		const cloneConfig = sub === "clone" ? configOptionRisk(args, CLONE_CONFIG_OPTION) : undefined;
		const risk = globalsRisk(globals) ?? cloneConfig ?? envRisk;
		if (risk) return risk;
	}
	for (const [, args] of command.matchAll(RM_COMMAND)) {
		const { recursive, targets } = rmArgs(args);
		if (!recursive) continue;
		const disposable =
			targets !== undefined &&
			targets.length > 0 &&
			targets.every(
				(t) => DISPOSABLE.test(t) && !/(?:^|\/)\.\.(?:\/|$)/.test(t) && !(t.startsWith(TMPDIR_REF) && tmpdirUnsafe),
			);
		if (!disposable) return "recursive rm";
	}
	return undefined;
}

// Worker-only implement rules: commands that leave the branch or touch shared state are always blocked.
const GH_COMMAND = new RegExp(`${AT_COMMAND}gh(?![\\w.-])`);
const PI_COMMAND = new RegExp(`${AT_COMMAND}pi\\s+(install|remove|uninstall|update|config)(?![\\w-])`);
// `./install.sh`, `/abs/install.sh`, `sh|bash|zsh [opts] install.sh`, or `.`/`source install.sh`; not `install.test.sh`.
// A simple shell `-n install.sh` invocation only parses syntax, so don't classify that filename as an execution.
const INSTALL_SYNTAX_CHECK = String.raw`(?:ba|z)?sh\s+-n\s+(?:[\w.~-]*\/)*install\.sh(?![\w.-])`;
const INSTALL_SH = new RegExp(
	`${AT_COMMAND}(?!${INSTALL_SYNTAX_CHECK})(?:(?:(?:ba|z)?sh|source|\\.)\\s+(?:${SHELL_OPTION}\\s+)*(?:[\\w.~-]*\\/)*)?install\\.sh(?![\\w.-])`,
);
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
		for (const words of gitReadings(args)) {
			const risk = workerGitRisk(sub, words);
			if (risk) return risk;
		}
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

export function gitTreeWrite(command: string): string | undefined {
	for (const [, , sub, args] of withoutMessages(command).matchAll(GIT_COMMAND)) {
		for (const words of gitReadings(args)) {
			// `git stash list|show` only read.
			if (sub === "stash" && ["list", "show"].includes(words[0])) continue;
			// `git branch` writes when it forces, moves, or deletes a branch; listing and creating pass.
			if (
				sub === "branch" &&
				(hasShort(words, "[fmMdD]") || ["--force", "--move", "--delete"].some((w) => words.includes(w)))
			)
				return sub;
			if (TREE_WRITES.has(sub)) return sub;
		}
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
		const risk = classify(command, () => branchIn(ctx.cwd), { historyRewrites: isWorkerProcess() });
		if (!risk) return undefined;
		const block = (reason: string) => {
			if (isWorkerProcess()) {
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
		if (!ctx.hasUI) return block(`Blocked (${risk}): needs explicit user approval; no UI to confirm.`);
		const ok = await ctx.ui.confirm(`Allow ${risk}?`, command);
		return ok ? undefined : block(`Blocked by user (${risk}).`);
	});
}
