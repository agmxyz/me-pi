/**
 * guard's "ask only when really dangerous" policy for a bash command the session is about to run. Pure given its
 * `PolicyEnv` (the disk lookups a live guard makes at classify time); `await initShell()` first.
 *
 * Guard asks in exactly three cases:
 * 1. catastrophic rm: a recursive `rm` whose target is outside every repo and not temp/build (`~`, `/`, `/Users`,
 *    `~/.pi/agent/x`), or a repo root or `.git`. Temp/build is guard's `DISPOSABLE` + `${TMPDIR:?}` rule, plus a
 *    `$(mktemp -d)` value bound earlier in the command;
 * 2. uncommitted work lost: `git reset --hard`, `clean -f`, `checkout --|.|-f`, `restore` (worktree), `switch -f`,
 *    `stash drop|clear`, or a recursive `rm` inside a repo. The verdict is `ask-if-dirty`: each such finding carries the
 *    `DirtyCheck` (repo, paths) the caller runs `git status` on;
 * 3. remote history: a force push (any branch), or a push to main/master, to a network remote.
 * Dropped (reported in `dropped`; workers still block them): `commit --amend`, `rebase`, `filter-branch`/`filter-repo`,
 * `branch -D` (reflog recovers them), and any push to a local path. Any rm/git that is only text (arguments, messages,
 * heredoc bodies written to files) is not a command. An unknown (an expansion, a dynamic body, a command name built at
 * run time) asks only where it could land in case 1-3. A text that doesn't parse takes guard 0.1.3's regex verdict.
 * And never weaker than 0.1.3: a command 0.1.3's `classify` asks about keeps that ask unless every part it matched is
 * proven safe (`unproven`, finding `legacy:0.1.3`).
 *
 * The user's decisions: 1. a bare push after `cd`/`-C` to a literal path reads that directory's branch; 2. a parse
 * failure falls back to 0.1.3's `classify`; 3. TMPDIR is rebound only by what the parser sees rebinding it; 4. every
 * recursive-rm target is placed by the repo containing it; 5. case 3 is network remotes only.
 */

import { posix } from "node:path";
import {
	GIT_COMMAND_ENV,
	GIT_SUBCOMMANDS,
	gitCommandOption,
	gitConfigCodeWrite,
	gitDataKey,
	gitDiscards,
	gitLongOption,
	gitRefIsProtected,
	gitRunsString,
} from "./guard-git.ts";
import {
	classify,
	DISPOSABLE,
	gitRisk,
	hasShort,
	PROTECTED_BRANCHES,
	PUSH_VALUE_OPTIONS,
	TMPDIR_REF,
} from "./guard-regex.ts";
import {
	ENV,
	expandBraces,
	GLOBCH,
	HOME,
	MARK,
	NOTMP,
	PWD,
	resolveWord,
	type Scope,
	TEMP,
	TMPROOT,
} from "./guard-resolve.ts";
import {
	type Bindings,
	GLOB,
	isWrapper,
	parseShell,
	RUNS_IN_NEW_SHELL,
	SHELLS,
	type SimpleCommand,
	tmpdirRebinds,
	type Word,
} from "./guard-shell.ts";

export type Level = "allow" | "ask-if-dirty" | "ask";
/**
 * What a case-2 finding puts at risk, for the caller's `git status --porcelain`: changes under `paths` (absolute;
 * undefined = the whole tree) in the work tree `repo` (undefined = unknown, so ask). `untracked`: untracked files count
 * too (`clean`, `rm`). `ignored`: so do gitignored ones (`clean -x`/`-X` deletes them; a recursive `rm` of a named
 * path is judged by guard's build-dir rule instead). `always`: the work at risk isn't in the tree (`stash
 * drop|clear`), so ask without a check.
 */
export interface DirtyCheck {
	repo: string | undefined;
	paths: string[] | undefined;
	untracked: boolean;
	ignored: boolean;
	always: boolean;
}
export interface Finding {
	level: Exclude<Level, "allow">;
	/** Stable bucket for counting: `rm:catastrophic …`, `rm:in-repo`, `git:discard`, `push:…`, `unknown:…`. */
	rule: string;
	detail: string;
	/** Set on every `ask-if-dirty` finding. */
	dirty?: DirtyCheck;
}
/** A rule 0.1.3 asked on that the main session no longer does; `history` rules stay blocked in workers. */
export interface Dropped {
	/** `push:resolved`: a push 0.1.3 called "after changing directory or branch" whose branch the policy resolved. */
	rule: "history" | "push:local" | "push:resolved";
	detail: string;
}
export interface PolicyVerdict {
	verdict: Level;
	findings: Finding[];
	dropped: Dropped[];
	/** Decision 2: texts that failed to parse, judged by guard 0.1.3's regex `classify` (its reason, or null). */
	fallbacks: { text: string; failure: "syntax" | "limit" | "not-loaded"; reason: string | null }[];
}

/** The disk as the live guard reads it when the command is about to run (fakes in tests). */
export interface PolicyEnv {
	/** The session's working directory (absolute); relative paths and a bare `git` resolve against it. */
	cwd: string;
	/** The home directory, for `~` and `$HOME`. */
	home: string | undefined;
	/** The session's branch (read only when a bare push needs it); undefined if not a repo. */
	branch(): string | undefined;
	/** Decision 1: the branch checked out at `dir` (`HEAD` when detached), or undefined if `dir` isn't a repo. */
	branchOf(dir: string): string | undefined;
	/** Decision 4: the work tree root containing `dir`; `null` if none; undefined if unknown (a failed read). */
	repoRootOf(dir: string): string | null | undefined;
	/** Decision 5: remote `name`'s URL in the repo at `dir`, or undefined if unknown. */
	remoteUrlOf(dir: string, name: string): string | undefined;
	/**
	 * Decision 5, as git pushes: every URL `git push NAME` sends to (`pushurl`, `insteadOf`/`pushInsteadOf` applied);
	 * undefined if unknown. Without it, `remoteUrlOf` stands in (test fakes).
	 */
	pushUrlsOf?(dir: string, name: string): string[] | undefined;
	/** URL prefixes git rewrites in the repo at `dir` (`insteadOf`/`pushInsteadOf` values); undefined if unknown. */
	urlRewritesOf?(dir: string): string[] | undefined;
	/**
	 * Whether `git checkout NAME` in `dir` switches to a ref (true) or overwrites path NAME (false); undefined, or no
	 * lookup at all, is unknown (treated as a path: case 2).
	 */
	isCheckoutRef?(dir: string, name: string): boolean | undefined;
}
type Branch = () => string | undefined;
// The env and top-level command text of the `policy` call in progress: set on entry, cleared on exit. `policy` is
// synchronous and doesn't re-enter, so module state is safe and keeps the rule helpers' signatures short.
let E: PolicyEnv = {
	cwd: "/",
	home: undefined,
	branch: () => undefined,
	branchOf: () => undefined,
	repoRootOf: () => undefined,
	remoteUrlOf: () => undefined,
	isCheckoutRef: () => undefined,
};
const NO_ENV = E;
let TOP = "";
interface LevelRule {
	level: Level;
	rule: string;
	dirty?: DirtyCheck;
	/** `git checkout NAME` with one operand: a branch switch if NAME is a ref, else NAME's path is overwritten. */
	refOrPath?: string;
}

const RANK: Record<Level, number> = { allow: 0, "ask-if-dirty": 1, ask: 2 };
const worst = (fs: Finding[]): Level => fs.reduce<Level>((a, f) => (RANK[f.level] > RANK[a] ? f.level : a), "allow");
const worse = (a: LevelRule, b: LevelRule): LevelRule => {
	if (a.level !== "ask-if-dirty" || b.level !== "ask-if-dirty") return RANK[b.level] > RANK[a.level] ? b : a;
	// Two case-2 checks (a target in each directory a `cd` may have left): both must be clean. One repo: the union of
	// their paths; two repos: unknown, so ask.
	const [x, y] = [a.dirty ?? UNKNOWN_REPO, b.dirty ?? UNKNOWN_REPO];
	if (x.repo === undefined || x.repo !== y.repo) return { ...a, dirty: UNKNOWN_REPO };
	const paths = x.paths && y.paths ? [...new Set([...x.paths, ...y.paths])] : undefined;
	return {
		...a,
		dirty: {
			...x,
			paths,
			untracked: x.untracked || y.untracked,
			ignored: x.ignored || y.ignored,
			always: x.always || y.always,
		},
	};
};
const ALLOW: LevelRule = { level: "allow", rule: "rm:temp-or-build" };
const DOTDOT = /(?:^|\/)\.\.(?:\/|$)/;

// ---------------------------------------------------------------------------------------------------------------
// Rules over argv (strings), shared with the bash-truth harness (test/guard-truth).

/** A recursive-rm target by guard's temp/build rule alone (`DISPOSABLE`, never `..`); `${TMPDIR:?}` is checked by `disp`. */
export function disposable(target: string): boolean {
	return DISPOSABLE.test(target) && !DOTDOT.test(target);
}
/** rm's recursion as rm reads its options: a short cluster with `r`/`R`, `--recursive`, or a GNU prefix of it (`--rec`). */
export function rmRecursive(options: string[]): boolean {
	return hasShort(options, "[rR]", "--recursive") || options.some((o) => o.length >= 3 && "--recursive".startsWith(o));
}
/**
 * git's global options before the sub-command (`-C dir`, `-c k=v`, `--git-dir=x`); the rest is the sub-command. Its
 * words have git's unique-prefix long options spelled out (`reset --ha` is `reset --hard`), so every rule reads them.
 */
export function gitSplit(args: string[]): { globals: string[]; sub: string | undefined; words: string[] } {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		const a = args[i];
		if (a === "-C" || a === "-c" || /^--(?:git-dir|work-tree|namespace|super-prefix|exec-path|config-env)$/.test(a))
			i += 2;
		else i++;
	}
	return { globals: args.slice(0, i), sub: args[i], words: args.slice(i + 1).map(gitLongOption) };
}

/** The `-c KEY=VALUE` (and `--config-env=KEY=ENV`) keys among git's global options. */
function gitConfigKeys(globals: string[]): string[] {
	const keys: string[] = [];
	for (let i = 0; i < globals.length; i++) {
		if (globals[i] === "-c" || globals[i] === "--config-env") keys.push((globals[i + 1] ?? "").split("=")[0]);
		else if (globals[i].startsWith("--config-env=")) keys.push(globals[i].slice(13).split("=")[0]);
	}
	return keys;
}
export const movesGit = (globals: string[]) =>
	globals.some((g) => g === "-C" || /^--(?:git-dir|work-tree)(?:=|$)/.test(g));

/**
 * guard's temp/build rule. `${TMPDIR:?}` is trusted only if nothing in the whole command (not just the inner script
 * being judged) can rebind TMPDIR: guard's textual `tmpdirMayChange`, or with decision 3 the parse.
 */
function disp(t: string, src: string): boolean {
	if (!disposable(t)) return false;
	if (!t.startsWith(TMPDIR_REF)) return true;
	return !tmpdirMayChangeIn(src);
}
function tmpdirMayChangeIn(src: string): boolean {
	const texts = TOP && TOP !== src ? [TOP, src] : [src];
	return texts.some(rebinds);
}
const rebindMemo = new Map<string, boolean>();
function rebinds(src: string): boolean {
	let r = rebindMemo.get(src);
	if (r === undefined) {
		r = tmpdirRebinds(src);
		if (rebindMemo.size > 10_000) rebindMemo.clear();
		rebindMemo.set(src, r);
	}
	return r;
}

/** One recursive-rm target, as rm receives it (a path relative to the session's repo, or absolute). */
export function rmTargetLevel(target: string, src: string): LevelRule {
	const t = target.replace(/\/{2,}/g, "/");
	if (disp(t, src)) return ALLOW;
	if (t.startsWith("/") || t.startsWith("~")) return { level: "ask", rule: "rm:catastrophic (outside the repo)" };
	if (DOTDOT.test(t)) return { level: "ask", rule: "rm:catastrophic (.. leaves the repo)" };
	const norm = t.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
	const parts = norm.split("/");
	if (norm === "" || norm === ".") return { level: "ask", rule: "rm:catastrophic (repo root)" };
	// `*`, `.*`, `./*`: every entry of the working directory, in effect the repo root.
	if (parts.length === 1 && /^\.?\*+$/.test(norm)) return { level: "ask", rule: "rm:catastrophic (repo root glob)" };
	if (parts.some((part) => part.toLowerCase() === ".git")) return { level: "ask", rule: "rm:catastrophic (.git)" };
	return { level: "ask-if-dirty", rule: "rm:in-repo", dirty: UNKNOWN_REPO };
}
// A case-2 finding whose repo isn't known: the caller asks.
const UNKNOWN_REPO: DirtyCheck = { repo: undefined, paths: undefined, untracked: true, ignored: false, always: false };

/** A git call's level from guard's own `gitRisk`, re-mapped to the three cases. */
export function gitLevel(
	sub: string,
	words: string[],
	branch: Branch,
	elsewhere: boolean,
): LevelRule & { risk?: string } {
	// A push of the current branch where that branch can't be read (not a repo, git failing or timing out) could be
	// main: the target is unknown, which asks (an unknown read never means "not protected").
	const unread = sub === "push" && !elsewhere && branch() === undefined;
	const risk = gitRisk(sub, words, branch, elsewhere || unread);
	// A refspec with a glob (`refs/heads/*:refs/heads/*`, `*:*`, `refs/heads/m*`) pushes a set of branches that may
	// include main/master: case 3 (decision 5 still drops it for a local remote). Tag-only globs are not branches.
	if (
		!risk &&
		sub === "push" &&
		words.some((w) => !w.startsWith("-") && /[*?[]/.test(w) && !/^\+?refs\/tags\//.test(w))
	)
		return { level: "ask", rule: "push:main", risk: "push of a glob refspec (may include main/master)" };
	// Refspec destinations git resolves to main/master that 0.1.3's list missed: `heads/main`, `X:heads/main`, and
	// `@` (HEAD) on main (confirmed in a scratch repo).
	if (!risk && sub === "push") {
		const positional = words.filter((w) => !w.startsWith("-"));
		const dsts = positional.slice(1).map((r) => r.replace(/^\+/, "").split(":").pop() ?? "");
		const current = () => branch();
		const hit = dsts.some((d) =>
			d === "@"
				? elsewhere
					? true
					: PROTECTED_BRANCHES.has(current() ?? "")
				: gitRefIsProtected(d, PROTECTED_BRANCHES),
		);
		if (hit) return { level: "ask", rule: "push:main", risk: "push to main/master" };
	}
	// More commands that discard uncommitted work (case 2), each confirmed to lose a modified file in a scratch repo.
	if (!risk) {
		const discard = gitDiscards(sub, words);
		if (discard)
			return { level: "ask-if-dirty", rule: "git:discard", risk: discard.risk, refOrPath: discard.refOrPath };
	}
	if (!risk) return { level: "allow", rule: "git:none" };
	if (risk === "force push") return { level: "ask", rule: "push:force", risk };
	if (risk === "push to main/master") return { level: "ask", rule: "push:main", risk };
	if (risk.startsWith("push after changing")) return { level: "ask", rule: "push:target-unknown", risk };
	if (/^history rewrite|^git branch -D/.test(risk)) return { level: "allow", rule: `dropped:${risk}`, risk };
	return { level: "ask-if-dirty", rule: "git:discard", risk };
}

// ---------------------------------------------------------------------------------------------------------------
// Parser side.

/** The policy verdict for a command the session is about to run. */
export function policy(command: string, env: PolicyEnv): PolicyVerdict {
	E = env;
	TOP = command;
	let branchRead = false;
	let sessionBranch: string | undefined;
	const branch: Branch = () => {
		if (!branchRead) [branchRead, sessionBranch] = [true, env.branch()];
		return sessionBranch;
	};
	const findings: Finding[] = [];
	const dropped: Dropped[] = [];
	const fallbacks: PolicyVerdict["fallbacks"] = [];
	try {
		const p = parseShell(command);
		if (!p.ok) parseFailed(command, p.reason, branch, findings, fallbacks, "the command doesn't parse");
		else {
			judge(command, p.commands, branch, findings, dropped, 0, p.bindings, fallbacks);
			// Already an ask: 0.1.3's verdict can't make it stricter.
			const legacy = worst(findings) === "ask" ? undefined : unproven(command, p, branch);
			if (legacy)
				findings.push({ level: "ask", rule: "legacy:0.1.3", detail: `${legacy} (guard 0.1.3; not proven safe)` });
		}
		return { verdict: worst(findings), findings, dropped, fallbacks };
	} finally {
		E = NO_ENV;
		TOP = "";
		rebindMemo.clear();
		OWNERS.clear();
	}
}

// The top-level command each finding or drop of the `policy` call in progress came from (a resolved `bash -c "$c"`
// script's findings belong to the command that runs it). Findings in a written-then-run heredoc body have none.
const OWNERS = new Map<Finding | Dropped, SimpleCommand>();

/** Commands whose arguments only print, send, or search text (S1), when the command runs no script file. */
const TEXT_CONSUMERS = new Set(["echo", "printf", "print", "grep", "egrep", "fgrep", "rg", "ag"]);
/** `herdr agent prompt` sends text to an agent; `herdr pane run` would run it, so only the listed forms. */
const textConsumer = (c: SimpleCommand, writes: boolean): boolean => {
	const [, a, b] = c.argv.map((w) => (w.kind === "literal" ? w.value : ""));
	if (c.name === "herdr") return a === "agent" && b === "prompt";
	// `node -e '…'`, `python3 -c '…'`: the program text, when it can't run a command (`interpreterText`).
	if (c.name !== undefined && HEREDOC_PROGRAM.has(c.name)) {
		// Only plain options before the program (`--input-type=module`), and no shell-run words around it.
		const flag = c.name === "node" ? /^(?:-e|--eval|-p|--print)$/ : /^-c$/;
		const k = c.argv.findIndex((w) => w.kind !== "expansion" && flag.test(w.value));
		const program = k > 0 ? c.argv[k + 1] : undefined;
		// Options that load no code (not `--require`/`--import`/`--loader`/`-r`, review r2).
		const plainOptions = c.argv
			.slice(1, k)
			.every(
				(w) =>
					w.kind === "literal" &&
					/^(?:--input-type=(?:module|commonjs)|--no-warnings|--experimental-strip-types|--no-deprecation|-I|-B|-u|-S|-E|-s|-q)$/.test(
						w.value,
					),
			);
		return (
			plainOptions &&
			program !== undefined &&
			program.kind !== "expansion" &&
			interpreterText(program.value, !writes)
		);
	}
	if (c.name === "gh") return ["pr", "issue"].includes(a) && ["create", "comment", "edit", "view"].includes(b);
	if (c.name === "sed") return sedText(c.argv.slice(1));
	// `perl -pi -e 's/a/b/g'`: one plain substitution (no `e` flag, no code in the replacement: `@{[…]}`, `${\…}`).
	if (c.name === "perl") {
		const k = c.argv.findIndex((w) => w.kind !== "expansion" && /^-[a-zA-Z]*e$/.test(w.value));
		const opts = c.argv.slice(1, k);
		const prog = k > 0 ? c.argv[k + 1] : undefined;
		const plain = /^s(.)(?:\\.|(?!\1)[^\n@$])*\1(?:\\.|(?!\1)[^\n@$])*\1[gimsx]*;?$/;
		// One program only: a later `-e`/`-E`/`-M`/`-x`/`-I` adds code (review r2); `(?{…})` runs code in the pattern.
		const rest = c.argv.slice(k + 2);
		return (
			prog !== undefined &&
			prog.kind !== "expansion" &&
			plain.test(prog.value) &&
			!prog.value.includes("(?") &&
			rest.every((w) => !w.value.startsWith("-")) &&
			/^-[pnil]*e$/.test(c.argv[k].value) &&
			opts.every((w) => w.kind === "literal" && /^-[pnil]+$/.test(w.value)) &&
			c.argv.slice(k + 2).every((w) => w.kind !== "expansion")
		);
	}
	// `rg --pre CMD` / `--hostname-bin CMD` run a program on every file searched (review r2).
	if ((c.name === "rg" || c.name === "ag") && c.argv.some((w) => /^--(?:pre|hostname-bin)(?:=|$)/.test(w.value)))
		return false;
	return c.name !== undefined && TEXT_CONSUMERS.has(c.name);
};
/**
 * `sed` whose every script is substitutions and prints (`s|a|b|g`, `-n '/x/p'`, line ranges): text in, text out. Not
 * `e` (runs the pattern space), `w`/`W`/`r`/`R` (files), or GNU's `s///e`; a script from `-f` or an expansion isn't
 * known. Options: `-i[SUFFIX]`, `-n`, `-E`, `-r`, `-e SCRIPT`.
 */
function sedText(args: Word[]): boolean {
	const sub = String.raw`s(.)(?:\\.|(?!\1)[^\n])*\1(?:\\.|(?!\1)[^\n])*\1[gpiI0-9]*`;
	const addr = String.raw`(?:\d+|\$|/(?:\\.|[^/\n])*/)(?:,(?:\d+|\$|/(?:\\.|[^/\n])*/))?`;
	const one = new RegExp(`^\\s*(?:${addr})?\\s*(?:${sub}|p|d)\\s*$`);
	const ok = (script: string) => script.split(/;|\n/).every((x) => x.trim() === "" || one.test(x));
	let scripts = 0;
	let files = false;
	for (let i = 0; i < args.length; i++) {
		const w = args[i];
		if (w.kind === "expansion") return false;
		// GNU sed reads options anywhere (`sed p file -e 'e cmd'`): a later option is checked too (review r2).
		if (files && !w.value.startsWith("-")) continue;
		if (w.value === "-e") {
			const s = args[++i];
			if (!s || s.kind === "expansion" || !ok(s.value)) return false;
			scripts++;
		} else if (/^-(?:i.*|[nErsu]+)$|^--(?:in-place(?:=.*)?|quiet|silent|regexp-extended|posix)$/.test(w.value))
			continue;
		else if (w.value.startsWith("-")) return false;
		else if (scripts === 0) {
			if (!ok(w.value)) return false;
			scripts++;
			files = true;
		} else files = true;
	}
	return scripts > 0;
}
/** Commands whose heredoc body is text written to a file or a message (S1), when the command runs no script file. */
const HEREDOC_TEXT = new Set(["cat", "tee", "git"]);
/** Interpreters whose program (a heredoc, `node -e`, `python3 -c`) holds rm/git only as text when it can't run one. */
const HEREDOC_PROGRAM = new Set(["python", "python3", "node"]);
/**
 * What lets a JavaScript or Python program run a command, or code the text doesn't show: process and shell APIs,
 * `eval`/`exec`, a computed member (`m["exec"+"Sync"]`), a non-literal or process-related import. A program with none
 * of these can't run the rm/git its strings mention (it may still delete through file APIs: neither 0.1.3 nor the
 * policy polices program bodies).
 */
const RUNS_PROCESS =
	/child_process|worker_threads|\bvm\b|\bexec\w*|\bspawn\w*|\bfork\b|\bsystem\b|\bpopen\b|subprocess|multiprocessing|\bpty\b|\bctypes\b|\bos\b|\bshutil\b|\beval\b|\bcompile\s*\(|Function\s*\(|\bBun\b|\bDeno\b|\$`|\bzx\b|__import__|importlib|\bgetattr\b|\bglobals\s*\(|\b(?:process|globalThis|global|module|require|Reflect)\s*(?:\[|\.(?:binding|_linkedBinding|dlopen|mainModule|main|cache|constructor|get|apply))|\bconstructor\b|__(?:builtins|subclasses|globals|class|bases|mro|code|loader|dict)__|\bsys\.modules\b|\bprocess\b|\bglobalThis\b|\bvars\s*\(|\bimport\s+\*|\b(?:require|import)\s*\(\s*[^"'\s]/;
// The modules a program may load: node's file and text modules, and (`local`) a relative path: a file already on disk,
// which runs what it runs whether or not this text names rm/git (`node x.mjs` isn't policed either).
const IMPORT = /\b(?:require|import)\s*\(\s*(["'])(.*?)\1|\bfrom\s+(["'])(.*?)\3/g;
const SAFE_MODULE =
	/^(?:node:)?(?:fs|fs\/promises|path|url|util|assert|assert\/strict|json|re|sys|pathlib|textwrap|difflib)$/;
// A plain string literal (no prefix letter, so no Python f-string; a template only without `${`): its contents are
// text, so a word in it (`"use eval here"`) doesn't count as code. Imports are still read from the whole program.
const STRING_LITERAL =
	/(?<![\w$])[rRbB]{0,2}(?:'''[\s\S]*?'''|"""[\s\S]*?""")|(?<![\w$])(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`)/g;
// Python's `import x` / `from x import y`: the module must be a safe one too.
const PY_IMPORT = /^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import\b|import[ \t]+([\w., \t]+))/gm;
function interpreterText(program: string, local: boolean): boolean {
	if (RUNS_PROCESS.test(program.replace(STRING_LITERAL, '""'))) return false;
	for (const m of program.matchAll(PY_IMPORT)) {
		// `import a, b as c`: each comma part's first word is a module (`as c` names it).
		const names = m[1] !== undefined ? [m[1]] : (m[2] ?? "").split(",").map((x) => x.trim().split(/\s+/)[0]);
		if (names.some((n) => n && !SAFE_MODULE.test(n.split(".")[0]))) return false;
	}
	if (/\bimport[ \t]+["']/.test(program)) return false;
	for (const m of program.matchAll(IMPORT)) {
		const name = m[2] ?? m[4] ?? "";
		if (!SAFE_MODULE.test(name) && !(local && /^\.{1,2}\//.test(name))) return false;
	}
	return true;
}

/**
 * Step 1 of the method: guard 0.1.3's reason to ask about `src`, if the policy can't prove every match safe; undefined
 * when 0.1.3 doesn't ask or every match is proven. The policy's findings never get weaker for this: it only adds an ask.
 *
 * A match is proven by blanking the source it sits in and re-running 0.1.3's `classify`: lifted only if nothing is
 * left. Blanked: comments; values of plain assignments that run nothing (S1: the policy resolves their uses); and each
 * top-level command's range whose commands (its own, the ones unwrapped or
 * re-parsed from it, and any `$(…)` inside it) are each neutral (0.1.3 finds nothing in its words, or a wrapper whose
 * program is those commands) or proven, and at least one proven:
 * - S1 text: a text consumer's words, top level and unwrapped, in a command that runs no script file;
 * - S2 disposable: an `rm`/`find` the policy judged and found nothing in (every recursive target temp, build, mktemp);
 * - S3 clean tree / new asks: a command with a policy finding (`ask-if-dirty` is checked against `git status`);
 * - S4 local push and S5 history: a command with a `push:local` or `history` drop (workers still block history);
 * - S6 resolved branch: a bare push after `cd`/`-C` or `checkout -b` whose branch the policy read (`push:resolved`).
 * A heredoc body is also blanked when it is text: read only by `cat`/`tee`/`git` (or a program run directly by
 * `python`/`python3`/`node`, as 0.1.3 already did for an opening one), in a command that runs no script file. Not blanked: neutral commands outside a proven range (`cd` keeps 0.1.3's
 * "after changing directory" rule), and everything when the offsets aren't exact. 0.1.3 reason → what lifts it:
 * recursive rm → S1/S2/S3; reset --hard, clean -f, checkout/switch/restore discards, stash drop|clear → S1/S3 (stash
 * always asks); force push, push to main/master → S1/S4; push after changing directory → S1/S4/S6; history rewrite and
 * branch -D → S1/S5.
 */
function unproven(
	src: string,
	p: Extract<ReturnType<typeof parseShell>, { ok: true }>,
	branch: Branch,
): string | undefined {
	const old = classify(src, branch);
	if (!old || !p.exact) return old;
	const cmds = p.commands;
	const owned = new Set(OWNERS.values());
	const runs = ranFiles(cmds).length > 0;
	// The command writes a program file (a redirect or `tee` to `.js`/`.ts`/`.py`…): a relative import may load it.
	const code = (v: string) => /\.(?:[cm]?[jt]sx?|py)$/.test(v);
	// A redirect's file: `>&1`, `2>&-` move descriptors; an expansion target could be any file.
	const file = (r: { op: string; target?: Word }) =>
		/>/.test(r.op) && r.target !== undefined && !/^(?:\d+|-)$/.test(r.target.value);
	const writes = cmds.some(
		(c) =>
			c.redirects.some((r) => file(r) && (r.target!.kind === "expansion" || code(r.target!.value))) ||
			(c.name === "tee" && c.argv.some((w) => code(w.value))) ||
			c.name === "cp" ||
			c.name === "mv" ||
			c.name === "ln",
	);
	const proof = (c: SimpleCommand): boolean => {
		if (owned.has(c)) return true;
		if ((c.name === "rm" || c.name === "find") && !c.openArgs && !c.remote) return true;
		return !runs && c.argvSpans !== undefined && textConsumer(c, writes);
	};
	// A wrapper's own words are its program, judged through the commands unwrapped or re-parsed from it (same range).
	const neutral = (c: SimpleCommand) =>
		(c.name !== undefined && isWrapper(c.name)) || !classify(c.argv.map((w) => w.raw).join(" "), branch);
	const blank = new Uint8Array(src.length);
	const mark = ([a, b]: [number, number], v: number) => blank.fill(v, a, b);
	for (const s of [...p.comments, ...p.data]) mark(s, 1);
	const inside = (x: [number, number], s: [number, number]) => x[0] >= s[0] && x[1] <= s[1];
	const spans = new Map(cmds.map((c) => [`${c.span[0]},${c.span[1]}`, c.span]));
	for (const s of spans.values()) {
		const within = cmds.filter((c) => inside(c.span, s));
		if (within.some(proof) && within.every((c) => proof(c) || neutral(c))) mark(s, 1);
	}
	// A heredoc body is text when every command reading it is a plain text reader (not a shell or other wrapper: their
	// bodies run, and count only through their command's proven range), and nothing in the command runs a script file.
	const bodies = new Map<string, { span: [number, number]; text: boolean }>();
	for (const c of cmds)
		for (const h of c.heredocs) {
			if (!h.span) continue;
			// Under an unquoted delimiter a command substitution in the body runs: then its text is never data.
			const expands = h.literal !== true && /\$\(|`/.test(h.body);
			// Not when the command runs a script file: the program may print rm/git into it (`python3 - <<EOF > a.sh; bash a.sh`).
			const text =
				!expands &&
				!runs &&
				c.name !== undefined &&
				(HEREDOC_TEXT.has(c.name) ||
					(HEREDOC_PROGRAM.has(c.name) && c.via.length === 0 && !c.reparsed && interpreterText(h.body, !writes)));
			const key = `${h.span[0]},${h.span[1]}`;
			const b = bodies.get(key);
			bodies.set(key, { span: h.span, text: (b?.text ?? true) && text });
		}
	for (const b of bodies.values()) if (b.text) mark(b.span, 1);
	// By UTF-16 unit, as tree-sitter's offsets are.
	let left = "";
	for (let i = 0; i < src.length; i++) left += blank[i] && src[i] !== "\n" ? " " : src[i];
	return classify(left, branch, src);
}

/** Decision 2: a text that doesn't parse (or hits a parser limit) takes guard 0.1.3's regex verdict on that text. */
function parseFailed(
	text: string,
	failure: "syntax" | "limit" | "not-loaded",
	branch: Branch,
	findings: Finding[],
	fallbacks: PolicyVerdict["fallbacks"],
	what: string,
): void {
	const reason = classify(text, branch);
	fallbacks.push({ text, failure, reason: reason ?? null });
	if (reason) findings.push({ level: "ask", rule: "fallback:0.1.3", detail: `${what}; guard 0.1.3: ${reason}` });
}

/** Whether nothing in the command can rebind TMPDIR (see `disp`). */
const tmpdirStable = (src: string) => !tmpdirMayChangeIn(src);

function judge(
	src: string,
	cmds: SimpleCommand[],
	branch: Branch,
	findings: Finding[],
	dropped: Dropped[],
	depth: number,
	outerB: Bindings | null,
	fallbacks: PolicyVerdict["fallbacks"],
): void {
	const stable = tmpdirStable(src);
	// Each finding and drop a top-level command (with any resolved script it runs) adds is owned by it (see `unproven`).
	let prev: SimpleCommand | undefined;
	let [f0, d0] = [0, 0];
	const own = () => {
		if (depth === 0 && prev)
			for (const x of [...findings.slice(f0), ...dropped.slice(d0)]) if (!OWNERS.has(x)) OWNERS.set(x, prev);
		[f0, d0] = [findings.length, dropped.length];
	};
	for (const c of cmds) {
		own();
		prev = c;
		// A re-parsed string run by another shell (`sh -c '…'`, `bash <<EOF`) doesn't see this shell's variables;
		// `trap` and `eval` strings run in this shell and do.
		const newShell = c.via.some((v) => RUNS_IN_NEW_SHELL.has(v));
		const scope: Scope = { b: c.reparsed && newShell ? null : outerB, tmpdirStable: stable };
		// Remote commands (`ssh host 'rm -rf ~'`) are judged like local ones; their dirtiness can't be checked here.
		const add: Add = (level, rule, detail, dirty) =>
			findings.push(
				c.remote && level === "ask-if-dirty"
					? { level: "ask", rule, detail }
					: { level, rule, detail, ...(level === "ask-if-dirty" ? { dirty: dirty ?? UNKNOWN_REPO } : {}) },
			);
		if (c.dynamicBody !== undefined) {
			// `bash -c "$c"` / `eval "$x"` with every value bound in this command: judge each resulting script.
			// No words (`<stdin>`, a `{}` placeholder string under xargs/find): nothing to resolve; unknown, so ask.
			const scripts = depth < 2 && c.argv.length ? resolveScripts(c.argv, scope, c.at) : undefined;
			if (!scripts) {
				add("ask", "unknown:dynamic-body", `${c.via.at(-1)} runs a string or stdin not known statically`);
				continue;
			}
			for (const s of scripts) {
				const inner = parseShell(s);
				if (!inner.ok)
					parseFailed(s, inner.reason, branch, findings, fallbacks, "a resolved command string doesn't parse");
				else {
					const marked = inner.commands.map((x) => ({ ...x, remote: x.remote || c.remote }));
					judge(s, marked, branch, findings, dropped, depth + 1, inner.bindings, fallbacks);
				}
			}
			continue;
		}
		if (c.name === undefined) {
			// `~/.local/bin/herdr`, `$S/run.sh`: asks only if the name could be rm, git, or a command runner.
			// A literal last path part names the program whatever the directory (`"$L/measure.sh"`).
			const tail = /\/([\w.+-]+)"?$/.exec(c.argv[0].raw)?.[1];
			const names = tail ? [tail] : resolveWord(c.argv[0], scope, c.at)?.map((v) => basename(v));
			const risky = (n: string) =>
				n === "rm" || n === "git" || n === "" || n.includes(MARK) || n.includes(GLOBCH) || isWrapper(n);
			if (!names || names.some(risky)) add("ask", "unknown:command-name", "command name is an expansion");
			continue;
		}
		// `source <(node …)`, `bash <(curl …)`: the script is a program's output, as unknown as `eval "$(…)"`.
		if ((c.name === "source" || c.name === "." || SHELLS.has(c.name)) && runsSubstitution(c)) {
			add("ask", "unknown:dynamic-body", `${c.name} runs the output of a process substitution`);
			continue;
		}
		if (c.name === "rm") rmFindings(c, src, add, scope, cwdAt(cmds, c, scope));
		else if (c.name === "find") findFindings(c, src, add, scope, cwdAt(cmds, c, scope));
		else if (c.name === "git") gitFindings(c, cmds, branch, add, dropped, scope);
	}
	own();
	// A heredoc written to a file, in a command that also runs any script file (`sh x`, `bash x`, `. x`, `./x`, `make`):
	// every written body is judged as a program. Files aren't traced through `cp`/`mv`/`ln` or names (fail closed: the
	// run may be the written file under another name), so the name doesn't have to match.
	if (depth > 0) return;
	const written = writtenHeredocs(cmds);
	if (!written.length) return;
	const runs = ranFiles(cmds);
	if (!runs.length) return;
	for (const w of written) {
		const body = parseShell(w.body);
		if (!body.ok) {
			parseFailed(w.body, body.reason, branch, findings, fallbacks, "a script written by a heredoc doesn't parse");
			continue;
		}
		judge(w.body, body.commands, branch, findings, dropped, depth + 1, body.bindings, fallbacks);
	}
}

/** Whether the script a `source`/`.` or a shell runs is a process substitution (`<(…)`), not a file or a `-c` string. */
function runsSubstitution(c: SimpleCommand): boolean {
	const args = c.argv.slice(1);
	let i = 0;
	if (c.name !== "source" && c.name !== ".")
		while (i < args.length && args[i].kind !== "expansion" && /^[-+]/.test(args[i].value)) {
			if (/^-[A-Za-z]*c/.test(args[i].value)) return false;
			i += /^[-+]o$/.test(args[i].value) ? 2 : 1;
		}
	return args[i]?.kind === "expansion" && args[i].raw.startsWith("<(");
}

const values = (ws: Word[]) => ws.map((w) => w.value);
const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

type Add = (level: Exclude<Level, "allow">, rule: string, detail: string, dirty?: DirtyCheck) => void;

function rmFindings(c: SimpleCommand, src: string, add: Add, s: Scope, cwd: Cwd): void {
	const args = c.argv.slice(1);
	const end = args.findIndex((w) => w.kind !== "expansion" && w.value === "--");
	const before = end < 0 ? args : args.slice(0, end);
	const after = end < 0 ? [] : args.slice(end + 1);
	const options = before.filter((w) => w.kind !== "expansion" && w.value.startsWith("-") && w.value !== "-");
	const operands = [
		...before.filter((w) => w.kind === "expansion" || !w.value.startsWith("-") || w.value === "-"),
		...after,
	];
	const recursive = rmRecursive(values(options));
	// An expansion before `--` that starts the word could be an option (`rm $flags x`, `rm "$f" x` with f=-r), unless
	// every value is known and none starts with `-`.
	const candidates = before.filter((w) => {
		if (w.kind !== "expansion" || !/^"?[$`]/.test(w.raw)) return false;
		// `"$X/f"`, `"$X"/f`: whatever X holds, the word has a `/` after it, which no rm option (short cluster or
		// `--long[=WHEN]`) accepts, so rm would reject it rather than recurse.
		if (/^"\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)"?\//.test(w.raw)) return false;
		const vals = resolveWord(w, s, c.at);
		return vals === undefined || vals.some((v) => v.startsWith("-") || v.startsWith(ENV));
	});
	if (!recursive && !candidates.length && !c.openArgs) return;
	if (c.openArgs) {
		add("ask", "unknown:rm-runtime-args", `rm via ${c.via.join(" > ")}: targets arrive at run time`);
		return;
	}
	if (!operands.length) return; // `rm -rf` with no operand removes nothing
	// Not recursive: a single quoted plain variable (`"$f"`) is either the `-r` (then not a target) or a target of a
	// non-recursive rm; `"${a[@]}"`, `$@`, or an unquoted one can be `-r` and targets at once.
	const oneWord = candidates.length === 1 && /^"\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)"$/.test(candidates[0].raw);
	const judged = recursive || !oneWord ? operands : operands.filter((w) => w !== candidates[0]);
	for (const w of judged) {
		const r = targetLevel(w, src, s, c.at, cwd);
		if (r.level === "allow") continue;
		add(r.level, recursive ? r.rule : `${r.rule} (if an expansion holds -r)`, `rm target ${w.raw}`, r.dirty);
	}
}

// `find` options before the start paths (BSD and GNU): flag letters, and the ones that take the next word.
const FIND_FLAG_LETTERS = /^-[HLPEXdsx]+$/;
const FIND_OPT_VALUE = new Set(["-D", "-f"]);

/**
 * `find`'s argv as it reads it: leading options (`-H -L -P -E -X -d -s -x`, `-O<n>`, `-D <debug>`, `-f <start>` whose
 * operand is a start path, `--`), then start paths up to the first expression word (`-name`, `(`, `!`, `)`); none is
 * `.`. `unknownStart`: a leading `-` word that isn't a known option, so where find starts can't be told (fails closed).
 * `deletes`: the expression has `-delete` (it removes what it matches below each start path). Whatever else the
 * expression says (`-type f`, `! -name keep`), it is judged as a recursive rm of each start path: at or above a repo
 * root it can reach `.git`, so it is case 1 like `rm -rf .`; proving that it spares `.git` is not attempted. `words`:
 * which argv indexes are starts and which the expression. Shared by the parse side and the bash side.
 */
export function findSplit(args: string[]): {
	starts: number[];
	expr: number[];
	unknownStart: boolean;
	deletes: boolean;
} {
	const starts: number[] = [];
	let i = 0;
	let unknownStart = false;
	for (; i < args.length; i++) {
		const a = args[i];
		if (a === "--") {
			i++;
			break;
		}
		if (FIND_FLAG_LETTERS.test(a) || /^-O\d*$/.test(a)) continue;
		if (FIND_OPT_VALUE.has(a)) {
			if (a === "-f" && i + 1 < args.length) starts.push(i + 1);
			i++;
			continue;
		}
		// The first word that isn't a known option: an expression primary (`-name`, `-type`, `-delete`, …), so find
		// starts at `.` (or the paths `-f` named). A single-letter or capital dash word that isn't a known option may be
		// one this list lacks (`-Y` on some find): fail closed.
		if (/^-[A-Z]$|^-[a-z]$/.test(a)) unknownStart = true;
		break;
	}
	// Start paths: every word before the first expression word (also after `--`).
	for (; i < args.length && !/^[-(!]/.test(args[i]) && args[i] !== ")"; i++) starts.push(i);
	const expr: number[] = [];
	for (; i < args.length; i++) expr.push(i);
	return { starts, expr, unknownStart, deletes: expr.some((k) => args[k] === "-delete") };
}

// Expression primaries whose next word is their operand (a pattern, a type, a number), not another expression word.
const FIND_TAKES_VALUE = new Set([
	"-name",
	"-iname",
	"-path",
	"-ipath",
	"-wholename",
	"-iwholename",
	"-regex",
	"-iregex",
	"-lname",
	"-ilname",
	"-type",
	"-xtype",
	"-user",
	"-group",
	"-uid",
	"-gid",
	"-perm",
	"-size",
	"-newer",
	"-anewer",
	"-cnewer",
	"-mtime",
	"-atime",
	"-ctime",
	"-mmin",
	"-amin",
	"-cmin",
	"-maxdepth",
	"-mindepth",
	"-links",
	"-inum",
	"-samefile",
	"-fstype",
	"-printf",
	"-fprint",
	"-fprint0",
	"-fprintf",
	"-fls",
	"-context",
]);

/**
 * `find START… -delete`: each start path is judged like the target of a recursive rm (case 1 or 2, temp/build
 * allowed). `find -exec rm …` is already the rm it runs (guard-shell unwraps it). An expansion in the expression that
 * doesn't resolve could be `-delete` or `-exec`, and one in the option position could hide where find starts: then the
 * start paths are judged as for `-delete`, and an unknown start asks.
 */
function findFindings(c: SimpleCommand, src: string, add: Add, s: Scope, cwd: Cwd): void {
	const args = c.argv.slice(1);
	// Each word's values (one per possibility); an unresolvable expansion is undefined.
	const vals = args.map((w) => (w.kind === "expansion" ? resolveWord(w, s, c.at) : [w.value]));
	// The literal shape, with every expansion standing for a non-option word (a start, or an expression operand).
	const shape = args.map((w, k) =>
		w.kind === "expansion" ? (vals[k]?.length === 1 ? (vals[k] as string[])[0] : "x") : w.value,
	);
	const split = findSplit(shape);
	// An expansion find reads as a start or an expression word could be `-delete` or `-exec …` unless its value is
	// known: unresolvable (`$D`, `$(printf -- -delete)`), or one that holds an action. The operand of a primary that
	// takes one (`-name "$N"`) is not an action, if quoted (unquoted, it may split into more words).
	const operandOf = (k: number) => FIND_TAKES_VALUE.has(shape[k - 1] ?? "") && split.expr.includes(k - 1);
	// A value is risky if it isn't known text (an `ENV:` session value could be anything), could be read as an option
	// or action (`-delete`, `-exec`), or splits into more words. Path markers (`~`, `$PWD`, mktemp) are known paths.
	const risky = (x: string) => x.includes(ENV) || x.startsWith("-") || /\s/.test(x);
	// Which words could still be read as an action: every expansion in the expression, and an unquoted expansion among
	// the start paths (it may split into `x -delete`). A quoted start (`"$d"`, `"$HOME/x"`) is one start path whatever
	// it holds; its value is judged as a target only if the expression deletes.
	const quoted = (w: Word) => /^"[^"]*"$/.test(w.raw);
	const unknownExpr = args.some((w, k) => {
		if (w.kind !== "expansion") return false;
		const inExpr = split.expr.includes(k);
		if (!inExpr && (!split.starts.includes(k) || quoted(w))) return false;
		const v = vals[k];
		if (inExpr && operandOf(k) && quoted(w) && v) return false;
		// A start path's own blanks split only if they came from an unquoted expansion's value (`~/A\ B` is one word):
		// an unresolved value (`ENV:`), or none at all, could hold ` -delete`.
		if (!inExpr) return !v || v.some((x) => x.includes(ENV));
		return !v || v.some(risky);
	});
	// An expansion before the expression may hold options (`find $OPTS ~ -delete`): where find starts is unknown.
	const unknownLead = args
		.slice(0, split.starts[0] ?? split.expr[0] ?? args.length)
		.some((w) => w.kind === "expansion");
	if (!split.deletes && !unknownExpr) return;
	if (split.unknownStart || unknownLead) {
		add(
			"ask",
			"unknown:find-start",
			"find with an option or expansion before its start paths: where it deletes is unknown",
		);
		return;
	}
	const targets = split.starts.length
		? split.starts.map((k) => args[k])
		: [{ value: ".", kind: "literal", raw: "." } as Word];
	for (const w of targets) {
		const r = targetLevel(w, src, s, c.at, cwd);
		if (r.level !== "allow")
			add(
				r.level,
				r.rule,
				`find ${split.deletes ? "-delete" : "with an unknown expression"} under ${w.raw}`,
				r.dirty,
			);
	}
}

/**
 * The working directory a command runs in, as resolve.ts values: `[""]` is the session's (the repo); a `cd` to a
 * fresh temp dir gives `[TEMP]`; to a path, that path; unknown gives undefined. Each `cd` before the command counts
 * if it surely ran before it (a top-level sequence item, or earlier in the command's own `&&` chain); one that may or
 * may not have run makes the directory unknown.
 */
type Cwd = string[] | undefined;
function cwdAt(cmds: SimpleCommand[], c: SimpleCommand, s: Scope): Cwd {
	let cwd: Cwd = [""];
	// A command in a function body, a loop, or a trap may run after any later `cd` too (at a call, a second pass,
	// exit): it is judged in every directory the whole script can reach, its own text position ignored.
	const upTo = c.outOfOrder ? cmds.length : cmds.indexOf(c);
	for (const [k, x] of cmds.entries()) {
		if (k >= upTo) break;
		if (x === c) continue;
		if (x.name !== "cd" && x.name !== "pushd" && x.name !== "popd") continue;
		const before: Cwd = cwd;
		cwd = cdTarget(x, cwd, s);
		// `changedBefore`: a `cd` moves this command only if it surely succeeded first, in the same `&&` chain. After `;`,
		// a newline, `||`, `&`, in a pipe, a subshell, or a branch, the command may run in either directory: both count.
		if (c.outOfOrder || !changedBefore(x, c))
			cwd = cwd === undefined || before === undefined ? undefined : [...new Set([...before, ...cwd])];
	}
	return cwd;
}

/**
 * Whether an earlier command `x` surely changed state (the working directory, a remote's URL, the branch) before `c`
 * runs: `x` is in `c`'s own `&&` chain ahead of it, in the foreground of this shell. `cd x; …` may fail, `cd x & …`
 * runs in a background subshell, `cd x || …` runs `…` only if it failed. One rule for every "state set earlier".
 */
function changedBefore(x: SimpleCommand, c: SimpleCommand): boolean {
	return !x.reparsed && !c.reparsed && x.after.some(([a, e]) => c.at >= a && c.at < e);
}

/** The working directory after a `cd`/`pushd`/`popd` from `cwd` (as if it succeeded); undefined if unknown. */
function cdTarget(x: SimpleCommand, cwd: Cwd, s: Scope): Cwd {
	{
		const arg = x.argv.slice(1).find((w) => !(w.kind !== "expansion" && w.value.startsWith("-")));
		const opts = x.argv.slice(1).filter((w) => w.kind !== "expansion" && w.value.startsWith("-") && w.value !== "--");
		if (x.name === "popd" || !arg || opts.length || arg.value === "-") return undefined;
		const vals = resolveWord(arg, s, x.at);
		// An absolute target resets an unknown directory (`cd x && …; cd /tmp && rm -rf y`); `$PWD`/`~+` is relative to
		// the directory so far, never absolute.
		const absolute = vals?.every(
			(v) => v.startsWith("/") || (v.startsWith(MARK) && !v.startsWith(ENV) && !v.startsWith(PWD)),
		);
		if (!vals || (!cwd && !absolute)) return undefined;
		const from = cwd ?? [""];
		const next: string[] = [];
		for (const raw of vals)
			for (const base of from) {
				const v = raw.startsWith(PWD) ? `.${raw.slice(PWD.length)}` : raw;
				next.push(v.startsWith("/") || v.startsWith(MARK) ? v : base === "" ? v : `${base}/${v}`);
			}
		return next;
	}
}

/**
 * A relative target after `cd` to `base` (not a temp dir): the directory is some project, so a target inside it is
 * case 2 there; a shallow base (`/`, `/Users`, `~`, `/Users/me`) makes it case 1.
 */
function afterCd(base: string, rel: string, src: string): LevelRule | undefined {
	const b = base.replace(/\/+$/, "");
	const shallow = b === "" || b === HOME || (b.startsWith("/") && b.split("/").filter(Boolean).length <= 2);
	if (shallow || b.startsWith(TEMP) || b.startsWith(TMPROOT) || (b.startsWith("/") && disposable(`${b}/x`)))
		return undefined;
	const r = rmTargetLevel(rel, src);
	return r.rule === "rm:in-repo" ? { ...r, rule: "rm:in-repo (after cd)" } : r;
}

// ---------------------------------------------------------------------------------------------------------------
// Decisions 1, 4, 5: what the disk says (through `PolicyEnv` lookups).

/**
 * An absolute directory for a resolve.ts value relative to the session cwd: `""` is the cwd, `HOME…` the home dir, a
 * relative path joins the cwd. Undefined for a fresh mktemp dir, an unknown value, or a missing cwd/home.
 */
function absOf(v: string): string | undefined {
	if (v === "") return E.cwd;
	if (v.startsWith(HOME)) return E.home ? posix.normalize(E.home + v.slice(HOME.length)) : undefined;
	if (v.includes(MARK) || v.includes(GLOBCH)) return undefined;
	if (v.startsWith("/")) return posix.normalize(v);
	return posix.normalize(`${E.cwd}/${v}`);
}
const stripSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

/**
 * Decision 4: an absolute recursive-rm target by the repo containing it. Temp (guard's rule) is allowed; outside every
 * repo is case 1; the repo root itself and `.git` are case 1; inside a repo is case 2 (`ask-if-dirty`), except build
 * dirs at the repo root (guard's `DISPOSABLE` on the path from the root).
 */
function repoLevel(abs: string, src: string, at = abs): LevelRule {
	const p = stripSlash(posix.normalize(abs));
	const temp = disp(p, src);
	const root = E.repoRootOf(p);
	// A failed read could hide a repo, even under a temp dir (scratch worktrees live there): unknown asks.
	if (root === undefined) return { level: "ask", rule: "unknown:repo-root (lookup failed)" };
	if (root === null) return temp ? ALLOW : { level: "ask", rule: "rm:catastrophic (not in a repo)" };
	// Compare with the root without case too: `rm -rf /W/App` is `/w/app` on a case-insensitive disk.
	const under = (a: string, b: string) =>
		a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(`${b.toLowerCase()}/`);
	const whole = (rule: string): LevelRule => ({
		level: "ask-if-dirty",
		rule,
		dirty: { repo: root, paths: undefined, untracked: true, ignored: false, always: false },
	});
	// A repo under a temp dir is still someone's work: case 2 there, never case 1 (removing it whole loses its tree).
	if (p.toLowerCase() === root.toLowerCase() || !under(p, root))
		return temp ? whole("rm:temp-repo") : { level: "ask", rule: "rm:catastrophic (repo root)" };
	const rel = p.slice(root.length + 1);
	if (rel.split("/").some((part) => part.toLowerCase() === ".git"))
		return { level: "ask", rule: "rm:catastrophic (.git)" };
	if (disp(rel, src)) return ALLOW;
	return {
		level: "ask-if-dirty",
		rule: "rm:in-repo",
		dirty: { repo: root, paths: [stripSlash(posix.normalize(at))], untracked: true, ignored: false, always: false },
	};
}

/**
 * Decision 4 for one resolve.ts value `v` (braces expanded; may hold `HOME`/`PWD` markers and `GLOBCH` globs) in the
 * working dir `base` (a cwdAt value: `""` is the session's cwd). The caller handles fresh mktemp and TMPDIR values.
 *   1. Make it absolute; unknown (an `ENV:` value, an unknown cwd) asks.
 *   2. guard's temp rule on the absolute path (no glob in a temp entry name) allows.
 *   3. A glob is judged by the directory it globs in (`<dir>/x`); `<repo root>/*` is case 1.
 *   4. `repoLevel`: not in a repo → case 1; repo root or `.git` → case 1; a build dir at the repo root → allow;
 *      else case 2.
 */
function diskLevel(v: string, src: string, base: string): LevelRule {
	const relative = !v.startsWith("/") && !v.startsWith(MARK);
	const full = relative ? (base === "" ? v : `${base}/${v}`) : v;
	const baseAbs = absOf(relative && base !== "" ? base : "");
	// guard's rule: `..` may climb out through a symlink; never resolve it away.
	if (DOTDOT.test(full.replaceAll(GLOBCH, ""))) return { level: "ask", rule: "rm:catastrophic (.. leaves the dir)" };
	const expanded = full.startsWith(PWD) ? `${E.cwd}${full.slice(PWD.length)}` : full;
	const globAt = expanded.indexOf(GLOBCH);
	const abs = absOf(expanded.replaceAll(GLOBCH, ""));
	if (abs === undefined || (relative && baseAbs === undefined))
		return { level: "ask", rule: "unknown:rm-target-expansion" };
	if (globAt < 0) return repoLevel(abs, src);
	const dir = absOf(
		expanded
			.slice(0, globAt)
			.replace(/[^/]*$/, "")
			.replaceAll(GLOBCH, "") || "",
	);
	if (dir === undefined) return { level: "ask", rule: "unknown:rm-target-expansion" };
	const d = stripSlash(dir);
	// A glob inside a named temp entry (`/tmp/x/*`) is temp unless it's in a repo (`repoLevel`); one at a temp root
	// (`/tmp/*`, `/tmp/a*`) is not (guard).
	if (!disp(d, src) && disp(`${d}/x`, src)) return { level: "ask", rule: "rm:catastrophic (glob at a temp root)" };
	const globRoot = E.repoRootOf(d);
	if (typeof globRoot === "string" && globRoot.toLowerCase() === d.toLowerCase())
		return { level: "ask", rule: "rm:catastrophic (repo root glob)" };
	return repoLevel(`${d}/x`, src, d);
}

/**
 * A variable that git, or a program it runs, reads as a command or config source (`GIT_EDITOR`, `GIT_SSH_COMMAND`,
 * `GIT_CONFIG_*`, `EDITOR`, …), set for this git: as its prefix assignment, an `env X=…` wrapping it, or an
 * `export`/`declare -x`/plain assignment in a command before it. Read from the parsed commands, so text in quotes,
 * messages, and heredocs doesn't count. Returns its name, or undefined.
 */
function gitCommandEnv(c: SimpleCommand, cmds: SimpleCommand[], s: Scope): string | undefined {
	// `export X=…`, `declare -x X=…`, `X=…` earlier in this shell: the bindings see declaration commands too. A bound
	// name that git reads counts whatever its value (exported before, it changes git's environment).
	if (s.b && !c.reparsed)
		for (const [name, at] of s.b.firstAt) if (at < c.at && GIT_COMMAND_ENV.test(name)) return name;
	const named = (text: string) => /^([A-Za-z_]\w*)(?:\+?=|$)/.exec(text)?.[1];
	const hit = (names: (string | undefined)[]) => names.find((n) => n !== undefined && GIT_COMMAND_ENV.test(n));
	const own = hit(c.assignments);
	if (own) return own;
	for (const x of cmds) {
		if (x === c) break;
		const operands = x.argv.slice(1).map((w) => (w.kind === "expansion" ? undefined : named(w.value)));
		// `env X=… git`: env is an earlier command here (git is unwrapped from it); `export X=…`, `X=…` alone.
		const binds = x.name === "env" || DECLARES.has(x.name ?? "") ? hit(operands) : undefined;
		if (binds) return binds;
		if (x.argv.length === 0 || x.name === undefined) continue;
		if (!x.reparsed && x.assignments.length && x.argv.length <= 1) {
			const a = hit(x.assignments);
			if (a) return a;
		}
	}
	return undefined;
}
const DECLARES = new Set(["export", "declare", "typeset", "local", "readonly"]);

/**
 * Whether something in the command may point git at another repository or work tree than the directory it runs in:
 * `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` (prefix, `export`, `env`) or `--git-dir`/`--work-tree`/`core.worktree`
 * anywhere in it. The text is the whole top-level command, so wrappers and earlier `export`s count too.
 */
const GIT_ELSEWHERE = /\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)\b|--(?:git-dir|work-tree)\b|\bcore\.worktree\b/;

/**
 * Directories (absolute) a git command runs in, or undefined if any isn't a literal path on disk, or git may be pointed
 * at another repo or work tree (`GIT_ELSEWHERE`): then where it acts is unknown, and every disk read about it asks.
 */
function gitDirs(c: SimpleCommand, cmds: SimpleCommand[], globals: string[], s: Scope): string[] | undefined {
	if (GIT_ELSEWHERE.test(TOP) || GIT_ELSEWHERE.test(c.script)) return undefined;
	const cwd = cwdAt(cmds, c, s);
	if (!cwd) return undefined;
	const args = c.argv.slice(1);
	// git applies every `-C` in order, each relative to the one before (`git -C . -C ../x` runs in `../x`).
	let dirs = cwd;
	for (const k of dashCs(globals)) {
		const vals = resolveWord(args[k + 1], s, c.at);
		if (!vals) return undefined;
		const next: string[] = [];
		for (const base of dirs)
			for (const d of vals)
				next.push(d === "" ? base : d.startsWith("/") || d.startsWith(MARK) || base === "" ? d : `${base}/${d}`);
		dirs = next;
	}
	const out: string[] = [];
	for (const v of dirs) {
		const abs = absOf(v);
		if (abs === undefined) return undefined;
		out.push(abs);
	}
	return out;
}

/** Indexes of every `-C` among git's global options (each takes the next word). */
function dashCs(globals: string[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < globals.length; i++) {
		if (globals[i] === "-C") out.push(i);
		if (
			globals[i] === "-C" ||
			globals[i] === "-c" ||
			/^--(?:git-dir|work-tree|namespace|super-prefix|exec-path|config-env)$/.test(globals[i])
		)
			i++;
	}
	return out;
}

/** A git remote URL or path that is on this machine: `/x`, `./x`, `../x`, `~/x`, `file://…`. */
const isLocalUrl = (u: string) => /^(?:file:\/\/|\.{1,2}\/|\/|~\/)/.test(u);
const isNetworkUrl = (u: string) => /^[\w+.-]+:\/\//.test(u) || /^(?:[\w.-]+@)?[\w.-]+:/.test(u);

/** `git push`'s remote word, or undefined when it's the default (none given). */
function pushRemote(words: string[]): string | undefined {
	const repo = words.find((w) => w.startsWith("--repo="));
	if (repo) return repo.slice(7);
	const i = words.indexOf("--repo");
	if (i >= 0) return words[i + 1];
	return words.find((w, j) => !w.startsWith("-") && !PUSH_VALUE_OPTIONS.has(words[j - 1]));
}

/**
 * Decision 5: whether every place a push could go is a local path. A path given as the remote; or a remote name added
 * earlier in the command (`git remote add NAME URL`, `set-url`), or else configured on disk (`remoteUrlOf`). The
 * default remote (none given) and an unknown name are not local.
 */
function pushIsLocal(remote: string | undefined, addedUrl: string | undefined, dirs: string[] | undefined): boolean {
	if (remote === undefined) return false;
	if (remote.includes(MARK) || /[$`"']/.test(remote)) return false;
	if (!isLocalUrl(remote) && isNetworkUrl(remote)) return false;
	// A local URL given or added in this command still goes elsewhere if a configured `insteadOf`/`pushInsteadOf` prefix
	// matches it: each repo the push may run in must be read and have none that does.
	const unrewritten = (url: string) =>
		!E.urlRewritesOf ||
		(!!dirs?.length &&
			dirs.every((d) => {
				const prefixes = E.urlRewritesOf!(d);
				return prefixes !== undefined && !prefixes.some((p) => url.startsWith(p));
			}));
	if (isLocalUrl(remote)) return unrewritten(remote);
	// `git remote set-url` changes `url` only: a `pushurl` already on disk still wins, so the remote's push URLs on disk
	// (when it exists there) must be just its fetch URL.
	const noPushUrl = () =>
		!E.pushUrlsOf ||
		(!!dirs?.length &&
			dirs.every((d) => {
				const fetch = E.remoteUrlOf(d, remote);
				if (fetch === undefined) return true;
				const push = E.pushUrlsOf!(d, remote);
				return push !== undefined && push.length === 1 && push[0] === fetch;
			}));
	if (addedUrl !== undefined) return isLocalUrl(addedUrl) && unrewritten(addedUrl) && noPushUrl();
	if (!dirs?.length) return false;
	return dirs.every((d) => {
		if (E.pushUrlsOf) {
			const urls = E.pushUrlsOf(d, remote);
			return urls !== undefined && urls.every(isLocalUrl);
		}
		const u = E.remoteUrlOf(d, remote);
		return u !== undefined && isLocalUrl(u);
	});
}

/**
 * The URL the last `git remote add|set-url NAME URL` before `c` gave remote `name`, and whether it surely took effect
 * for `c`: it ran first (`changedBefore`), in the same repo (the same `gitDirs`, no other `-C`/`--git-dir`), and the
 * disk agrees (for `add`, the remote doesn't exist yet; for `set-url`, it does). Undefined if no command set it.
 */
function remoteChangedBefore(
	c: SimpleCommand,
	cmds: SimpleCommand[],
	name: string,
	dirs: string[] | undefined,
	s: Scope,
): { url: string; sure: boolean } | undefined {
	let out: { url: string; sure: boolean } | undefined;
	for (const x of cmds.slice(0, cmds.indexOf(c))) {
		if (x.name !== "git") continue;
		const { globals, sub, words } = gitSplit(values(x.argv.slice(1)));
		if (sub !== "remote") continue;
		const ops = words.filter((w) => !w.startsWith("-"));
		// `remote rename A name`, `rename name B`, `remove name` / `rm name` change what `name` points to in ways the URL
		// table doesn't model: from here its URL is unknown (it may be a network remote, so a push to it can be case 3).
		const renamed = ops[0] === "rename" && (ops[1] === name || ops[2] === name);
		const removed = (ops[0] === "remove" || ops[0] === "rm") && ops[1] === name;
		if (renamed || removed) {
			out = { url: "unknown://renamed-or-removed", sure: true };
			continue;
		}
		if (!((ops[0] === "add" || ops[0] === "set-url") && ops[1] === name && ops[2])) continue;
		// Same repo: the same working directory as `c` (as the parse places both) and the same git-dir options; a fresh
		// `mktemp -d` dir can't be placed on disk, so the parse's own values are compared.
		const here = cwdAt(cmds, c, s);
		const there = cwdAt(cmds, x, s);
		const { globals: cGlobals } = gitSplit(values(c.argv.slice(1)));
		const sameRepo =
			here !== undefined &&
			there !== undefined &&
			here.join("\0") === there.join("\0") &&
			cGlobals.join("\0") === globals.join("\0") &&
			!GIT_ELSEWHERE.test(TOP);
		// The disk must agree that the change could happen: `add` only if the remote doesn't exist yet (a repo made in a
		// fresh mktemp dir by this command has none), `set-url` only if it does.
		const fresh = here?.every((v) => v.startsWith(TEMP)) ?? false;
		const onDisk = fresh ? undefined : dirs?.length === 1 ? E.remoteUrlOf(dirs[0], name) : undefined;
		const known = fresh || dirs?.length === 1;
		const agrees = known && (ops[0] === "add" ? onDisk === undefined : onDisk !== undefined);
		out = { url: ops[2], sure: changedBefore(x, c) && sameRepo && agrees };
	}
	return out;
}

/** The URL an earlier `git remote add|set-url NAME URL` in argv lists gave remote `name` (last one wins). */
function addedRemote(gitArgvs: string[][], name: string): string | undefined {
	let url: string | undefined;
	for (const argv of gitArgvs) {
		const { sub, words } = gitSplit(argv);
		if (sub !== "remote") continue;
		const ops = words.filter((w) => !w.startsWith("-"));
		if ((ops[0] === "add" || ops[0] === "set-url") && ops[1] === name && ops[2]) url = ops[2];
	}
	return url;
}

/** A resolved rm target (resolve.ts markers), relative to the working directory `base`. */
function valueLevel(v: string, src: string, base: string): LevelRule {
	// Unquoted globs and brace alternatives: judge each alternative, and a glob by the directory it globs in.
	const alts = expandBraces(v);
	if (!alts) return { level: "ask", rule: "unknown:rm-target-expansion" };
	if (alts.length > 1) return alts.map((a) => valueLevel(a, src, base)).reduce(worse, ALLOW);
	v = alts[0];
	// Decision 4 for paths that live on disk; fresh mktemp dirs, the session temp dir, and unset-TMPDIR keep the rules
	// below.
	const special = (x: string) => x.startsWith(TEMP) || x.startsWith(TMPROOT) || x.startsWith(NOTMP);
	const relative = !v.startsWith("/") && !v.startsWith(MARK);
	if (!special(v) && !(relative && special(base))) return diskLevel(v, src, base);
	if (relative && base !== "" && !v.includes(GLOBCH)) {
		const r = afterCd(base, v, src);
		if (r) return r;
	}
	const path = relative && base !== "" ? `${base}/${v}` : v;
	const plain = (p: string) => p.replaceAll(GLOBCH, "");
	if (path.startsWith(TEMP)) {
		// The fresh mktemp dir itself or anything in it (a glob included) is temp.
		const rest = plain(path.slice(TEMP.length));
		return DOTDOT.test(rest) ? { level: "ask", rule: "rm:catastrophic (.. leaves the temp dir)" } : ALLOW;
	}
	if (path.startsWith(TMPROOT)) {
		// The session temp dir: guard's own `${TMPDIR:?}/<named entry>` rule (no glob in the entry name). An unknown
		// value in it (`${TMPDIR:?}/$n`) may be empty or `..`.
		if (path.slice(TMPROOT.length).includes(MARK)) return { level: "ask", rule: "unknown:rm-target-expansion" };
		const t = `\${TMPDIR:?}${plain(path.slice(TMPROOT.length))}`;
		return disposable(t) ? ALLOW : { level: "ask", rule: "rm:catastrophic (temp root or glob in it)" };
	}
	if (path.startsWith(HOME)) return { level: "ask", rule: "rm:catastrophic (outside the repo)" };
	if (path.startsWith(NOTMP)) return { level: "ask", rule: "rm:catastrophic (unset TMPDIR gives /…)" };
	if (path.startsWith(PWD)) return valueLevel(`.${path.slice(PWD.length)}`, src, "");
	if (path.includes(MARK)) return { level: "ask", rule: "unknown:rm-target-expansion" };
	if (path.includes(GLOBCH)) {
		// The directory the glob runs in decides: a glob of the repo root (`*`) is case 1, inside the repo case 2. An
		// absolute glob (`/tmp/x*`) keeps guard's literal rule (no glob in a temp entry's name).
		const dir = path.slice(0, path.indexOf(GLOBCH)).replace(/\/?[^/]*$/, "");
		if (path.startsWith("/")) return rmTargetLevel(plain(path), src);
		if (dir === "" || dir === ".") return { level: "ask", rule: "rm:catastrophic (repo root glob)" };
		return disposable(`${dir}/x`) && !DOTDOT.test(dir) ? ALLOW : rmTargetLevel(dir, src);
	}
	return rmTargetLevel(path, src);
}

/** A parser word as an rm target: literal paths by `rmTargetLevel`; expansions by what they could become. */
function targetLevel(w: Word, src: string, s: Scope, at: number, cwd: Cwd): LevelRule {
	const vals = w.kind === "expansion" ? resolveWord(w, s, at) : [w.value];
	if (!vals) return { level: "ask", rule: "unknown:rm-target-expansion" };
	let out = ALLOW;
	for (const raw of vals) {
		// `$PWD`/`~+` is the working directory at this command, not the session's: `cd ~ && rm -rf "$PWD/x"`.
		if (raw.startsWith(PWD)) {
			if (cwd === undefined) {
				out = worse(out, { level: "ask", rule: "unknown:rm-cwd ($PWD after an unknown cd)" });
				continue;
			}
			const rest = raw.slice(PWD.length);
			for (const base of cwd) out = worse(out, valueLevel(base === "" ? `.${rest}` : `${base}${rest}`, src, ""));
			continue;
		}
		const v = raw;
		const relative = !v.startsWith("/") && !v.startsWith(MARK);
		// guard's rule: a relative build-dir name (`dist`, `node_modules/x`) is disposable, when the cwd is the session's
		// or inside a repo (step 1 asked `cd / && rm -rf dist`; that stays).
		const inProject = (b: string) => {
			const abs = b === "" ? E.cwd : absOf(b);
			return abs !== undefined && typeof E.repoRootOf(abs) === "string";
		};
		if (relative && cwd?.every(inProject) && !v.includes(GLOBCH) && disp(v, src)) continue;
		// Decision 4: a relative target in an unknown working dir can't be placed on disk.
		if (relative && cwd === undefined) {
			out = worse(out, { level: "ask", rule: "unknown:rm-cwd (cd target unknown)" });
			continue;
		}
		for (const base of relative ? (cwd ?? [""]) : [""]) out = worse(out, valueLevel(v, src, base));
	}
	return out;
}

function gitFindings(
	c: SimpleCommand,
	cmds: SimpleCommand[],
	branch: Branch,
	add: Add,
	dropped: Dropped[],
	s: Scope,
): void {
	const args = c.argv.slice(1);
	const { globals, sub, words } = gitSplit(values(args));
	if (!sub) return;
	const subWord = args[globals.length];
	// An expansion in a global option's value (`git -C "$T"`) only changes where git runs.
	const globalWords = args.slice(0, globals.length);
	if (globalWords.some((w) => w.kind === "expansion" && /^"?[$`]/.test(w.raw) && globals.indexOf(w.value) % 2 === 0)) {
		const opt = globalWords.findIndex((w) => w.kind === "expansion");
		if (opt === 0 || !/^-[Cc]$|^--(?:git-dir|work-tree|namespace)$/.test(globalWords[opt - 1]?.value ?? "")) {
			add("ask", "unknown:git-sub-expansion", "a git global option is itself an expansion");
			return;
		}
	}
	if (subWord?.kind === "expansion") {
		const subs = resolveWord(subWord, s, c.at);
		const risky = (v: string) =>
			GUARDED_SUBS.has(v) || v.startsWith("-") || v.includes(MARK) || /\s/.test(v) || !GIT_SUBCOMMANDS.has(v);
		if (!subs || subs.some(risky))
			add("ask", "unknown:git-sub-expansion", "git sub-command is an expansion that could be a guarded one");
		return;
	}
	// Code git runs that the text doesn't trace (fail closed: case 1-3 could be inside): a `-c` key that isn't plain
	// data (`alias.x=!rm …`, `core.fsmonitor=…`), a sub-command git doesn't have (an alias from config), or one that
	// runs a shell string (`rebase -x`, `filter-branch --tree-filter`, `bisect run`, `submodule foreach`).
	const codeKey = gitConfigKeys(globals).find((k) => !gitDataKey(k));
	if (codeKey !== undefined) {
		add("ask", "unknown:git-config-code", `git -c ${codeKey}=… may run a command`);
		return;
	}
	// The same through the environment: a variable git (or a program it runs) reads as a command or config source,
	// set anywhere in the command (a prefix, `env X=… git`, `export X=…;` before it).
	const codeEnv = gitCommandEnv(c, cmds, s);
	if (codeEnv !== undefined) {
		add("ask", "unknown:git-env-code", `${codeEnv}=… may make git run a command`);
		return;
	}
	// A config written earlier in the command (`git config core.editor … && git commit`) is code for what follows; the
	// write itself is judged here, whatever comes after it.
	if (sub === "config") {
		const key = gitConfigCodeWrite(words);
		if (key !== undefined) {
			add("ask", "unknown:git-config-code", `git config ${key} … may make git run a command`);
			return;
		}
	}
	const cmdOpt = gitCommandOption(sub, words);
	if (cmdOpt !== undefined) {
		add("ask", "unknown:git-option-code", `git ${sub} ${cmdOpt} runs a command`);
		return;
	}
	if (!GIT_SUBCOMMANDS.has(sub)) {
		add("ask", "unknown:git-alias", `git ${sub} is not a git command (an alias runs whatever config says)`);
		return;
	}
	const runs = gitRunsString(sub, words);
	if (runs) {
		add("ask", "unknown:git-runs-string", runs);
		return;
	}
	// `worktree remove --force` deletes that work tree with its uncommitted changes: judged as a recursive rm of the tree
	// (case 2 in that tree's own repo: a dirty check there; outside temp, a repo root asks; an unknown path asks).
	if (sub === "worktree" && words[0] === "remove" && words.some((w) => /^-[A-Za-z]*f|^--force$/.test(w))) {
		const k = words.findIndex((w, i) => i > 0 && !w.startsWith("-"));
		const target = k < 0 ? undefined : args[globals.length + 1 + k];
		if (!target) {
			add("ask", "git:discard", "git worktree remove --force of a tree guard can't place");
			return;
		}
		const r = targetLevel(target, TOP, s, c.at, cwdAt(cmds, c, s));
		if (r.level !== "allow") add(r.level, r.rule, `git worktree remove --force ${target.raw}`, r.dirty);
		return;
	}
	const where = gitWhere(c, cmds, globals, s);
	let r = gitLevel(sub, words, branch, where !== "session");
	if (r.rule.startsWith("dropped:")) dropped.push({ rule: "history", detail: r.rule.slice("dropped:".length) });
	// Commands that may run before this one: those ahead of it in the text, or (in a function, loop or trap) any other.
	const before = c.outOfOrder ? cmds.filter((x) => x !== c) : cmds.slice(0, cmds.indexOf(c));
	// Decision 1: a bare push after `cd`/`-C` to literal paths pushes the branch checked out there (read from disk, as
	// the live guard would at classify time). Not after a checkout/switch in the same command (the disk shows the
	// branch before it), and not where a path isn't a repo.
	// Not when git may be pointed at another repo (`gitDirs` is then undefined).
	if (r.rule === "push:target-unknown" && where === "elsewhere" && !switchedBefore(before)) {
		const dirs = gitDirs(c, cmds, globals, s);
		if (dirs) {
			let best: LevelRule & { risk?: string } = { level: "allow", rule: "git:none" };
			for (const d of dirs) {
				const b = E.branchOf(d);
				const x: LevelRule & { risk?: string } =
					b === undefined || b === "HEAD"
						? {
								level: "ask",
								rule: "push:target-unknown",
								risk: "push from a path that isn't a repo (or detached)",
							}
						: gitLevel(sub, words, () => b, false);
				if (RANK[x.level] > RANK[best.level]) best = x;
			}
			r = best;
			if (r.level === "allow")
				dropped.push({ rule: "push:resolved", detail: "git push of the branch read from disk" });
		}
	}
	// Decision 5: case 3 is about network remotes; a push to a local path (given, added in this command, or configured)
	// doesn't ask, forced or not.
	if (sub === "push" && r.level !== "allow") {
		const remote = pushRemote(words);
		const dirs = gitDirs(c, cmds, globals, s);
		const changed = remote ? remoteChangedBefore(c, cmds, remote, dirs, s) : undefined;
		// A URL set earlier counts only if it surely took effect (`changedBefore`, same repo, and the disk agrees the
		// remote was missing for `add`/present for `set-url`); otherwise the push may go to either URL: both must be local.
		const local =
			changed === undefined
				? pushIsLocal(remote, undefined, dirs)
				: changed.sure
					? pushIsLocal(remote, changed.url, dirs)
					: pushIsLocal(remote, changed.url, dirs) && pushIsLocal(remote, undefined, dirs);
		if (local) {
			dropped.push({ rule: "push:local", detail: `git push to the local path or remote ${remote}` });
			return;
		}
	}
	if (r.level !== "allow") {
		// A bare push after `git checkout -b x`/`switch -c x` in the same repo (no `cd` or `-C` between) pushes x. A push
		// from a temp repo is not exempt: a clone there still pushes to its real remote.
		if (r.rule === "push:target-unknown" && where === "switched") {
			const target = newBranchBefore(cmds, c, s);
			if (target !== undefined && !PROTECTED_BRANCHES.has(target)) {
				dropped.push({ rule: "push:resolved", detail: `git push of the new branch ${target}` });
				return;
			}
		}
		// `git checkout NAME` (one operand, no `-f`): a plain branch switch keeps local changes, so it is allowed when NAME
		// is a ref in the repo it runs in. Not a ref, an unknown lookup, or an unplaced repo: NAME is a path (case 2).
		if (r.refOrPath !== undefined) {
			const dirs = gitDirs(c, cmds, globals, s);
			const forced = words.some((w) => /^-[A-Za-z]*f[A-Za-z]*$|^--force$/.test(w));
			if (!forced && dirs?.length === 1 && E.isCheckoutRef?.(dirs[0], r.refOrPath) === true) return;
		}
		let dirty = r.level === "ask-if-dirty" ? discardCheck(sub, words, gitDirs(c, cmds, globals, s)) : undefined;
		// A path operand that is an expansion (`git checkout -- $T`): which paths isn't in the text, so the whole tree.
		if (dirty?.paths && args.slice(globals.length + 1).some((w) => w.kind === "expansion"))
			dirty = { ...dirty, paths: undefined };
		add(r.level, r.rule, `git ${sub}: ${r.risk}`, dirty);
		return;
	}
	// A push whose remote or refspec is an expansion could name main or carry `+`, unless its values are known.
	if (sub === "push" && args.slice(globals.length + 1).some((w) => w.kind === "expansion")) {
		const resolved = args
			.slice(globals.length + 1)
			.map((w) => (w.kind === "expansion" ? resolveWord(w, s, c.at) : [w.value]));
		if (resolved.some((v) => v === undefined || v.some((x) => x.includes(MARK)))) {
			add("ask", "unknown:push-target-expansion", "push remote or refspec is an expansion");
			return;
		}
		for (const ws of product(resolved as string[][])) {
			const r2 = gitLevel(sub, ws, branch, where !== "session");
			if (r2.level !== "allow" && pushIsLocal(pushRemote(ws), undefined, gitDirs(c, cmds, globals, s))) {
				dropped.push({ rule: "push:local", detail: `git push to the local path or remote ${pushRemote(ws)}` });
				continue;
			}
			if (r2.level !== "allow") {
				add(r2.level, r2.rule, `git push: ${r2.risk}`);
				return;
			}
		}
	}
}

/**
 * Case 2 for a discarding git command run in `dirs`: the repo and the paths it discards. `reset --hard` and
 * `switch -f` lose tracked changes in the whole tree; `checkout`/`restore` the named paths (all of them for `.` or
 * none named); `clean` untracked files under its paths; `stash drop|clear` the stash itself.
 */
function discardCheck(sub: string, words: string[], dirs: string[] | undefined): DirtyCheck {
	if (sub === "stash") return { repo: undefined, paths: undefined, untracked: false, ignored: false, always: true };
	const dir = dirs?.length === 1 ? dirs[0] : undefined;
	const repo = dir === undefined ? undefined : E.repoRootOf(dir);
	if (dir === undefined || typeof repo !== "string") return UNKNOWN_REPO;
	const untracked = sub === "clean";
	const ignored = sub === "clean" && hasShort(words, "[xX]");
	// Which paths the discard touches: `checkout`/`restore`/`rm`/`clean` name them (a `checkout` tree-ish before them,
	// or anything before `--`, isn't a path: the whole tree is checked then); `reset`, `switch`, `read-tree`,
	// `checkout-index`, `apply -R`, `submodule deinit` touch the whole tree (or the submodules in it).
	const WHOLE = new Set(["reset", "switch", "read-tree", "checkout-index", "apply", "submodule"]);
	// `checkout -f <branch>` / `--force` overwrites every modified file, whatever the operand names.
	const forced = sub === "checkout" && words.some((w) => /^-[A-Za-z]*f[A-Za-z]*$|^--force$/.test(w));
	// Paths read from a file or stdin (`--pathspec-from-file`, any sub-command): which ones isn't in the text, so the
	// whole tree is checked.
	const fromFile = words.some((w) => /^--pathspec-from-file(?:=|$)/.test(w));
	// `checkout -p [<tree-ish>] [-- <paths>]`: a lone operand may be the tree-ish (`HEAD`), so without `--` the whole tree.
	const patch =
		sub === "checkout" && words.some((w) => /^-[A-Za-z]*p[A-Za-z]*$|^--patch$/.test(w)) && !words.includes("--");
	const named = sub === "checkout" && words.includes("--") ? words.slice(words.indexOf("--") + 1) : words;
	const positional = named.filter(
		(w, i) => !w.startsWith("-") && !(sub === "clean" && /^-[eE]$|^--exclude$/.test(named[i - 1] ?? "")),
	);
	const paths =
		WHOLE.has(sub) ||
		forced ||
		fromFile ||
		patch ||
		(sub === "checkout" && !words.includes("--") && positional.length !== 1)
			? []
			: positional;
	// Anything that isn't a plain path (an expansion marker, a glob, a pathspec) checks the whole tree.
	if (!paths.length || paths.some((p) => /[\u0000\u0001*?[:]/.test(p)))
		return { repo, paths: undefined, untracked, ignored, always: false };
	return { repo, paths: paths.map((p) => posix.resolve(dir, p)), untracked, ignored, always: false };
}

/**
 * Where a git command runs: the session's repo; a fresh temp repo (`-C "$T"` or after `cd "$T"` with T from mktemp);
 * or elsewhere (any other `cd`, `-C`, GIT_DIR, or an earlier checkout/switch).
 */
function gitWhere(
	c: SimpleCommand,
	cmds: SimpleCommand[],
	globals: string[],
	s: Scope,
): "session" | "temp" | "switched" | "elsewhere" {
	const args = c.argv.slice(1);
	const cs = dashCs(globals);
	if (cs.length) {
		// Temp only if the last `-C` is a fresh temp dir and none after it moves out (an absolute or `..` path).
		const vals = resolveWord(args[cs.at(-1)! + 1], s, c.at);
		return cs.length === 1 && vals?.every((v) => v.startsWith(TEMP) && !DOTDOT.test(v)) ? "temp" : "elsewhere";
	}
	if (movesGit(globals) || c.assignments.some((a) => a === "GIT_DIR" || a === "GIT_WORK_TREE")) return "elsewhere";
	const cwd = cwdAt(cmds, c, s);
	if (cwd?.every((v) => v.startsWith(TEMP) && !DOTDOT.test(v))) return "temp";
	if (cwd === undefined || cwd.some((v) => v !== "")) return "elsewhere";
	return switchedBefore(c.outOfOrder ? cmds.filter((x) => x !== c) : cmds.slice(0, cmds.indexOf(c)))
		? "switched"
		: "session";
}

/**
 * Whether a command before may have changed which branch is checked out: `checkout`/`switch`, a branch rename
 * (`branch -m`/`-M`, which can rename the current branch to main), or `symbolic-ref HEAD …`. The disk then shows the
 * branch from before it.
 */
const switchedBefore = (before: SimpleCommand[]) =>
	before.some((x) => {
		if (x.name !== "git") return false;
		const { sub, words } = gitSplit(values(x.argv.slice(1)));
		if (sub === "checkout" || sub === "switch") return true;
		if (sub === "branch") return words.some((w) => /^-[A-Za-z]*[mM]|^--move$|^--copy$|^-[A-Za-z]*[cC]/.test(w));
		return sub === "symbolic-ref" && words.filter((w) => !w.startsWith("-")).length >= 2;
	});

/**
 * The branch the last `git checkout -b|-B X` / `switch -c|-C X` before `c` created, resolved through the command's
 * variables (`B=x; git checkout -B "$B"`); undefined if any checkout/switch before `c` doesn't name one plain, known
 * branch (`checkout main`, `-B "$B"` with B unknown, `--orphan`, `-b=x`).
 */
function newBranchBefore(cmds: SimpleCommand[], c: SimpleCommand, s: Scope): string | undefined {
	let last: string | undefined;
	for (const x of cmds.slice(0, cmds.indexOf(c))) {
		if (x.name !== "git") continue;
		const args = x.argv.slice(1);
		const { globals, sub, words } = gitSplit(values(args));
		if (sub !== "checkout" && sub !== "switch") continue;
		const i = words.findIndex((w) => /^-[bBcC]$/.test(w));
		const word = i < 0 ? undefined : args[globals.length + 1 + i + 1];
		const vals = word ? resolveWord(word, s, x.at) : undefined;
		if (vals?.length !== 1 || /[\u0000\u0001\s]/.test(vals[0]) || vals[0].startsWith("-")) return undefined;
		// The new branch is the one pushed only if the checkout surely ran first (`changedBefore`); after `;`, `&`, or
		// `||` the push may push the branch from before it, which the disk can't show here.
		if (!changedBefore(x, c)) return undefined;
		last = vals[0];
	}
	return last;
}

// Sub-commands whose risk the policy checks (case 2 and 3).
const GUARDED_SUBS = new Set(["push", "reset", "clean", "checkout", "restore", "switch", "stash"]);

function product(xs: string[][]): string[][] {
	let out: string[][] = [[]];
	for (const x of xs) {
		out = out.flatMap((o) => x.map((v) => [...o, v]));
		if (out.length > 64) return out.slice(0, 64);
	}
	return out;
}

/** Every script a dynamic body could be, if each of its words resolves to known plain text. */
function resolveScripts(words: Word[], s: Scope, at: number): string[] | undefined {
	const vals: string[][] = [];
	for (const w of words) {
		const r = resolveWord(w, s, at);
		if (!r || r.some((v) => v.includes(MARK))) return undefined;
		vals.push(r);
	}
	return product(vals).map((ws) => ws.join(" "));
}

/** Files a heredoc body is written to: `cat > f <<EOF`, `cat <<EOF >> f`, `tee f <<EOF`. */
function writtenHeredocs(cmds: SimpleCommand[]): { file: string; body: string }[] {
	const out: { file: string; body: string }[] = [];
	for (const c of cmds) {
		if (!c.heredocs.length) continue;
		const files = c.redirects.flatMap((r) => (/^(?:\d*>>?\|?|&>>?)$/.test(r.op) && r.target ? [r.target.value] : []));
		if (c.name === "tee") files.push(...values(c.argv.slice(1)).filter((v) => !v.startsWith("-")));
		for (const file of files) for (const h of c.heredocs) out.push({ file, body: h.body });
	}
	return out;
}

/**
 * Files the command runs as a program: `./x`, `/p/x`, `sh x`, `bash -e x`, `source x`, `. x`, and the makefile `make`
 * reads (its recipes are shell); `*` if unknowable.
 */
function ranFiles(cmds: SimpleCommand[]): string[] {
	const out: string[] = [];
	for (const c of cmds) {
		const a0 = c.argv[0];
		if (!a0) continue;
		if (a0.kind === "expansion") {
			out.push("*");
			continue;
		}
		if (a0.value.includes("/")) out.push(GLOB.test(a0.value) ? "*" : a0.value);
		if ((c.name === "source" || c.name === ".") && c.argv[1])
			out.push(c.argv[1].kind === "expansion" ? "*" : c.argv[1].value);
		if (c.name === "make" || c.name === "gmake") {
			const f = c.argv.findIndex((w) => w.value === "-f" || w.value === "--file" || w.value === "--makefile");
			const file = f > 0 ? c.argv[f + 1] : undefined;
			if (file) out.push(file.kind === "expansion" ? "*" : file.value);
			else if (c.argv.some((w) => /^-f.|^--(?:make)?file=/.test(w.value))) out.push("*");
			else out.push("GNUmakefile", "makefile", "Makefile");
		}
		if (c.name !== undefined && SHELLS.has(c.name)) {
			const args = c.argv.slice(1);
			let i = 0;
			let dashC = false;
			while (i < args.length && args[i].kind !== "expansion" && /^[-+]/.test(args[i].value)) {
				if (/^-[A-Za-z]*c/.test(args[i].value)) dashC = true;
				i += /^[-+]o$/.test(args[i].value) ? 2 : 1;
			}
			if (!dashC && args[i]) out.push(args[i].kind === "expansion" ? "*" : args[i].value);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The same rules over what `rm` and `git` really received (test/guard-truth runs commands in a sandboxed bash with
// argv-recording stubs): the harness judges bash's argv with these, and `policy` must never allow less.
// Named consumer: test/guard-truth (run.ts, sessions.ts). It shares this module's private rules (repoLevel, disp, the
// env), so it lives here; delete it with the harness.

/** A logged rm/git call: its argv, where `cd` had gone (`""` the start dir, an absolute path, or `?`), and git's env. */
export interface ArgvCall {
	name: string;
	argv: string[];
	/** The call ran after a `cd`/`pushd`/`popd`. */
	moved: boolean;
	cwdArg: string;
	gitDir: string;
	gitWorkTree: string;
}

/** rm's argv split as getopt does it (GNU permutes: options may follow operands; `--` ends them). */
export function rmSplit(args: string[]): { options: string[]; operands: string[] } {
	const end = args.indexOf("--");
	const before = end < 0 ? args : args.slice(0, end);
	const after = end < 0 ? [] : args.slice(end + 1);
	return {
		options: before.filter((a) => a.startsWith("-") && a !== "-"),
		operands: [...before.filter((a) => !a.startsWith("-") || a === "-"), ...after],
	};
}

/**
 * The policy verdict for the calls bash made. `toDisk` maps a sandbox path to the disk path it stands for (the row's
 * start dir is `env.cwd`, the stub home is `env.home`); undefined for an unknown place.
 */
export function argvPolicy(
	calls: ArgvCall[],
	env: PolicyEnv,
	toDisk: (p: string) => string | undefined,
): PolicyVerdict {
	E = env;
	TOP = "";
	try {
		return judgeArgv(calls, toDisk);
	} finally {
		E = NO_ENV;
		rebindMemo.clear();
	}
}

function judgeArgv(calls: ArgvCall[], toDisk: (p: string) => string | undefined): PolicyVerdict {
	const findings: Finding[] = [];
	const dropped: Dropped[] = [];
	const dirOf = (c: ArgvCall): string | undefined => {
		if (c.cwdArg === "") return E.cwd;
		if (c.cwdArg === "?") return undefined;
		if (c.cwdArg.startsWith("/")) return toDisk(c.cwdArg);
		return posix.normalize(`${E.cwd}/${c.cwdArg}`);
	};
	let branchMoved = false;
	let newBranch: string | undefined;
	const gitSoFar: string[][] = [];
	for (const c of calls) {
		const find = c.name === "find" ? findSplit(c.argv) : undefined;
		if (find?.deletes && find.unknownStart) {
			findings.push({ level: "ask", rule: "unknown:find-start", detail: `find ${c.argv.join(" ")}` });
			continue;
		}
		if (c.name === "rm" || find?.deletes) {
			const starts = find?.starts.length ? find.starts.map((k) => c.argv[k]) : ["."];
			const { options, operands } = find ? { options: ["-r"], operands: starts } : rmSplit(c.argv);
			if (!rmRecursive(options)) continue;
			const dir = dirOf(c);
			for (const o of operands) {
				let r: LevelRule;
				if (DOTDOT.test(o)) r = { level: "ask", rule: "rm:catastrophic (.. leaves the dir)" };
				else if (!o.startsWith("/") && disp(o, "")) r = ALLOW;
				else {
					const abs = o.startsWith("/")
						? toDisk(o)
						: dir !== undefined
							? posix.normalize(`${dir}/${o}`)
							: undefined;
					r =
						abs === undefined ? { level: "ask", rule: "unknown:rm-cwd (cd target unknown)" } : repoLevel(abs, "");
				}
				if (r.level !== "allow")
					findings.push({ level: r.level, rule: r.rule, detail: `rm ${c.argv.join(" ")}`, dirty: r.dirty });
			}
		} else if (c.name === "git") {
			const { globals, sub, words } = gitSplit(c.argv);
			gitSoFar.push(c.argv);
			if (!sub) continue;
			const moved = c.moved || movesGit(globals) || c.gitDir !== "" || c.gitWorkTree !== "";
			const made = newBranch;
			let r =
				!moved && branchMoved && made !== undefined
					? gitLevel(sub, words, () => made, false)
					: gitLevel(sub, words, E.branch, branchMoved || moved);
			let dir = dirOf(c);
			for (const k of dashCs(globals)) {
				if (dir === undefined) break;
				const v = globals[k + 1] ?? "";
				dir = v.startsWith("/") ? toDisk(v) : posix.normalize(`${dir}/${v}`);
			}
			const hidden = c.gitDir !== "" || c.gitWorkTree !== "" || /--(?:git-dir|work-tree)/.test(globals.join(" "));
			// Decision 1, on what bash ran.
			if (r.rule === "push:target-unknown" && !branchMoved && !hidden && dir !== undefined) {
				const b = E.branchOf(dir);
				r =
					b === undefined || b === "HEAD"
						? { level: "ask", rule: "push:target-unknown" }
						: gitLevel(sub, words, () => b, false);
			}
			// Decision 5, on what bash ran.
			if (sub === "push" && r.level !== "allow") {
				const remote = pushRemote(words);
				const added = remote ? addedRemote(gitSoFar.slice(0, -1), remote) : undefined;
				if (pushIsLocal(remote, added, dir !== undefined && !hidden ? [dir] : undefined)) {
					dropped.push({ rule: "push:local", detail: `git push to the local path or remote ${remote}` });
					r = { level: "allow", rule: "git:none" };
				}
			}
			// `git checkout NAME` (one operand, no `-f`): a branch switch when NAME is a ref there, as on the parse side.
			if (r.refOrPath !== undefined && dir !== undefined && !hidden) {
				const forced = words.some((w) => /^-[A-Za-z]*f[A-Za-z]*$|^--force$/.test(w));
				if (!forced && E.isCheckoutRef?.(dir, r.refOrPath) === true) r = { level: "allow", rule: "git:none" };
			}
			if (r.rule.startsWith("dropped:")) dropped.push({ rule: "history", detail: r.rule.slice("dropped:".length) });
			if (r.level !== "allow") findings.push({ level: r.level, rule: r.rule, detail: `git ${c.argv.join(" ")}` });
			if (sub === "checkout" || sub === "switch") {
				const i = words.findIndex((w) => /^-[bBcC]$/.test(w));
				newBranch =
					!moved && i >= 0 && words[i + 1] && (!branchMoved || newBranch !== undefined) ? words[i + 1] : undefined;
				branchMoved = true;
			}
		}
	}
	return { verdict: worst(findings), findings, dropped, fallbacks: [] };
}
