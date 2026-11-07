/**
 * Prototype "ask only when really dangerous" policy (main session; measurement only, not wired into guard).
 * `await initShellAst()` once, then `policy(command, branch)` is a pure function.
 *
 * Guard asks in exactly three cases:
 * 1. catastrophic rm: a recursive `rm` of a target outside the repo, temp, and build dirs (`~`, `/`, `/Users`, the
 *    repo root, `.git`); temp/build is guard's own `DISPOSABLE` + `${TMPDIR:?}` rule;
 * 2. uncommitted work lost: `git reset --hard`, `clean -f`, `checkout --|.|-f`, `restore` (worktree), `switch -f`,
 *    `stash drop|clear`, or a recursive `rm` of a path inside the repo. Asking depends on `git status`, unknown here:
 *    the verdict is `ask-if-dirty`;
 * 3. remote history: a force push (any branch), or a push to main/master.
 * Dropped: `commit --amend`, `rebase`, `filter-branch`/`filter-repo`, `branch -D` (reflog recovers them), and any rm/git
 * that is only text (arguments, messages, heredoc bodies written to files). An unknown (an expansion, a dynamic body,
 * a parse failure) asks only where it could land in case 1-3: an unknown rm target asks only for a recursive rm whose
 * value could fall outside temp/build/the repo; an unknown git sub-command only if it could be a guarded one; a push
 * only if its target could be main/master or forced.
 *
 * The rules over argv (`rmTargetLevel`, `gitLevel`) take plain strings too, so bash-truth's logged argv is judged by
 * the same rules (`truthPolicy`).
 */
import { disposable, gitSplit, guard, movesGit, rmRecursive, rmSplit } from "../guard-parser/guard-rules.ts";
import {
	type Bindings,
	bindings,
	commands,
	type SimpleCommand,
	type Word,
	WRAPPERS,
} from "../guard-parser/shell-ast.ts";
import { ENV, expandBraces, GLOBCH, HOME, NOTMP, PWD, resolveWord, type Scope, TEMP, TMPROOT } from "./resolve.ts";

export type Level = "allow" | "ask-if-dirty" | "ask";
export interface Finding {
	level: Exclude<Level, "allow">;
	/** Stable bucket for counting: `rm:catastrophic …`, `rm:in-repo`, `git:discard`, `push:…`, `unknown:…`. */
	rule: string;
	detail: string;
}
export interface PolicyVerdict {
	verdict: Level;
	findings: Finding[];
	/** Rules the old guard would have asked on that this policy drops (amend, rebase, branch -D, …). */
	dropped: string[];
}
interface LevelRule {
	level: Level;
	rule: string;
}

const RANK: Record<Level, number> = { allow: 0, "ask-if-dirty": 1, ask: 2 };
const worst = (fs: Finding[]): Level => fs.reduce<Level>((a, f) => (RANK[f.level] > RANK[a] ? f.level : a), "allow");
const worse = (a: LevelRule, b: LevelRule) => (RANK[b.level] > RANK[a.level] ? b : a);
const ALLOW: LevelRule = { level: "allow", rule: "rm:temp-or-build" };
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash"]);
const DOTDOT = /(?:^|\/)\.\.(?:\/|$)/;
const GLOB = /[*?[]/;
const MARK = "\u0000";

// ---------------------------------------------------------------------------------------------------------------
// Rules over argv (strings), shared by the parser side and the bash-truth side.

/** One recursive-rm target, as rm receives it (a path relative to the session's repo, or absolute). */
export function rmTargetLevel(target: string, src: string): LevelRule {
	const t = target.replace(/\/{2,}/g, "/");
	if (disposable(t, src)) return ALLOW;
	if (t.startsWith("/") || t.startsWith("~")) return { level: "ask", rule: "rm:catastrophic (outside the repo)" };
	if (DOTDOT.test(t)) return { level: "ask", rule: "rm:catastrophic (.. leaves the repo)" };
	const norm = t.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
	const parts = norm.split("/");
	if (norm === "" || norm === ".") return { level: "ask", rule: "rm:catastrophic (repo root)" };
	// `*`, `.*`, `./*`: every entry of the working directory, in effect the repo root.
	if (parts.length === 1 && /^\.?\*+$/.test(norm)) return { level: "ask", rule: "rm:catastrophic (repo root glob)" };
	if (parts.includes(".git")) return { level: "ask", rule: "rm:catastrophic (.git)" };
	return { level: "ask-if-dirty", rule: "rm:in-repo" };
}

/** A git call's level from guard's own `gitRisk`, re-mapped to the three cases. */
export function gitLevel(
	sub: string,
	words: string[],
	branch: string,
	elsewhere: boolean,
): LevelRule & { risk?: string } {
	const risk = guard.gitRisk(sub, words, () => branch, elsewhere);
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
export function policy(command: string, branch: string): PolicyVerdict {
	const findings: Finding[] = [];
	const dropped: string[] = [];
	const cmds = commands(command);
	if (cmds === null) {
		findings.push({ level: "ask", rule: "unknown:parse", detail: "parse error or limit (fails closed)" });
		return { verdict: "ask", findings, dropped };
	}
	judge(command, cmds, branch, findings, dropped, 0, bindings(command));
	return { verdict: worst(findings), findings, dropped };
}

/** Whether nothing in the command can rebind TMPDIR (guard's own `tmpdirMayChange`, on the whole text). */
const tmpdirStable = (src: string) => !guard.tmpdirMayChange(src);

function judge(
	src: string,
	cmds: SimpleCommand[],
	branch: string,
	findings: Finding[],
	dropped: string[],
	depth: number,
	outerB: Bindings | null,
): void {
	const stable = tmpdirStable(src);
	for (const c of cmds) {
		// A re-parsed string run by another shell (`sh -c '…'`, `bash <<EOF`) doesn't see this shell's variables;
		// `trap` and `eval` strings run in this shell and do.
		const newShell = c.via.some((v) => RUNS_STRING.has(v));
		const scope: Scope = { b: c.reparsed && newShell ? null : outerB, tmpdirStable: stable };
		// Remote commands (`ssh host 'rm -rf ~'`) are judged like local ones; their dirtiness can't be checked here.
		const add = (level: Exclude<Level, "allow">, rule: string, detail: string) =>
			findings.push({ level: c.remote && level === "ask-if-dirty" ? "ask" : level, rule, detail });
		if (c.dynamicBody !== undefined) {
			// `bash -c "$c"` / `eval "$x"` with every value bound in this command: judge each resulting script.
			const scripts = depth < 2 && c.dynamicBody !== "<stdin>" ? resolveScripts(c.argv, scope, c.at) : undefined;
			if (!scripts) {
				add("ask", "unknown:dynamic-body", `${c.via.at(-1)} runs a string or stdin not known statically`);
				continue;
			}
			for (const s of scripts) {
				const inner = commands(s);
				if (inner === null) add("ask", "unknown:parse", "a resolved command string doesn't parse");
				else {
					const marked = inner.map((x) => ({ ...x, remote: x.remote || c.remote }));
					judge(s, marked, branch, findings, dropped, depth + 1, bindings(s));
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
				n === "rm" ||
				n === "git" ||
				n === "" ||
				n.includes(MARK) ||
				n.includes(GLOBCH) ||
				Object.hasOwn(WRAPPERS, n);
			if (!names || names.some(risky)) add("ask", "unknown:command-name", "command name is an expansion");
			continue;
		}
		if (c.name === "rm") rmFindings(c, src, add, scope, cwdAt(cmds, c, scope));
		else if (c.name === "git") gitFindings(c, cmds, branch, add, dropped, scope);
	}
	// A heredoc written to a file that the same command then runs (`cat > run.sh <<'EOF' … EOF; bash run.sh`): the body
	// is a program after all. A run file the parser can't name (`./r*.sh`, `bash "$f"`) matches every written file.
	if (depth > 0) return;
	const written = writtenHeredocs(cmds);
	if (!written.length) return;
	const runs = ranFiles(cmds);
	for (const w of written) {
		if (!runs.some((r) => r === "*" || basename(r) === basename(w.file))) continue;
		const body = commands(w.body);
		if (body === null) {
			findings.push({ level: "ask", rule: "unknown:parse", detail: "script written by a heredoc doesn't parse" });
			continue;
		}
		judge(w.body, body, branch, findings, dropped, depth + 1, bindings(w.body));
	}
}

const values = (ws: Word[]) => ws.map((w) => w.value);
const basename = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;

type Add = (level: Exclude<Level, "allow">, rule: string, detail: string) => void;

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
		add(r.level, recursive ? r.rule : `${r.rule} (if an expansion holds -r)`, `rm target ${w.raw}`);
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
	for (const x of cmds) {
		if (x === c) break;
		if (x.name !== "cd" && x.name !== "pushd" && x.name !== "popd") continue;
		const surely = !x.reparsed && (x.certain || x.after.some(([a, e]) => c.at >= a && c.at < e));
		// A `cd` inside a subshell or pipeline doesn't move this shell; any other one that may not run leaves it unknown.
		if (!surely && !inSubshell(x)) {
			cwd = undefined;
			continue;
		}
		if (!surely) continue;
		const arg = x.argv.slice(1).find((w) => !(w.kind !== "expansion" && w.value.startsWith("-")));
		const opts = x.argv.slice(1).filter((w) => w.kind !== "expansion" && w.value.startsWith("-") && w.value !== "--");
		if (x.name === "popd" || !arg || opts.length || arg.value === "-") {
			cwd = undefined;
			continue;
		}
		const vals = resolveWord(arg, s, x.at);
		if (!vals || !cwd) {
			cwd = undefined;
			continue;
		}
		const next: string[] = [];
		for (const v of vals)
			for (const base of cwd)
				next.push(v.startsWith("/") || v.startsWith(MARK) ? v : base === "" ? v : `${base}/${v}`);
		cwd = next;
	}
	return cwd;
}
// The parser doesn't keep subshell nesting; a `cd` that isn't certain is treated as possibly in this shell.
const inSubshell = (_: SimpleCommand) => false;

/**
 * A relative target after `cd` to `base` (not a temp dir): the directory is some project, so a target inside it is
 * case 2 there; a shallow base (`/`, `/Users`, `~`, `/Users/me`) makes it case 1.
 */
export function afterCd(base: string, rel: string, src: string): LevelRule | undefined {
	const b = base.replace(/\/+$/, "");
	const shallow = b === "" || b === HOME || (b.startsWith("/") && b.split("/").filter(Boolean).length <= 2);
	if (shallow || b.startsWith(TEMP) || b.startsWith(TMPROOT) || (b.startsWith("/") && disposable(`${b}/x`, "")))
		return undefined;
	const r = rmTargetLevel(rel, src);
	return r.rule === "rm:in-repo" ? { ...r, rule: "rm:in-repo (after cd)" } : r;
}

/** A resolved rm target (resolve.ts markers), relative to the working directory `base`. */
function valueLevel(v: string, src: string, base: string): LevelRule {
	// Unquoted globs and brace alternatives: judge each alternative, and a glob by the directory it globs in.
	const alts = expandBraces(v);
	if (!alts) return { level: "ask", rule: "unknown:rm-target-expansion" };
	if (alts.length > 1) return alts.map((a) => valueLevel(a, src, base)).reduce(worse, ALLOW);
	v = alts[0];
	const relative = !v.startsWith("/") && !v.startsWith(MARK);
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
		// The session temp dir: guard's own `${TMPDIR:?}/<named entry>` rule (no glob in the entry name).
		const t = `\${TMPDIR:?}${plain(path.slice(TMPROOT.length))}`;
		return disposable(t, "") ? ALLOW : { level: "ask", rule: "rm:catastrophic (temp root or glob in it)" };
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
		return disposable(`${dir}/x`, src) && !DOTDOT.test(dir) ? ALLOW : rmTargetLevel(dir, src);
	}
	return rmTargetLevel(path, src);
}

/** A parser word as an rm target: literal paths by `rmTargetLevel`; expansions by what they could become. */
function targetLevel(w: Word, src: string, s: Scope, at: number, cwd: Cwd): LevelRule {
	const vals = w.kind === "expansion" ? resolveWord(w, s, at) : [w.value];
	if (!vals) return { level: "ask", rule: "unknown:rm-target-expansion" };
	let out = ALLOW;
	for (const v of vals) {
		const relative = !v.startsWith("/") && !v.startsWith(MARK);
		if (relative && cwd === undefined) {
			// Somewhere unknown: in a repo (maybe another one) at best.
			out = worse(out, worse(valueLevel(v, src, ""), { level: "ask-if-dirty", rule: "rm:in-repo (after cd)" }));
			continue;
		}
		for (const base of relative ? (cwd ?? [""]) : [""]) out = worse(out, valueLevel(v, src, base));
	}
	if (out.rule === "rm:in-repo" && cwd !== undefined && cwd.some((b) => b !== ""))
		return { ...out, rule: "rm:in-repo (after cd)" };
	return out;
}

function gitFindings(
	c: SimpleCommand,
	cmds: SimpleCommand[],
	branch: string,
	add: Add,
	dropped: string[],
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
		if (!subs || subs.some((v) => GUARDED_SUBS.has(v) || v.startsWith("-") || v.includes(MARK) || /\s/.test(v)))
			add("ask", "unknown:git-sub-expansion", "git sub-command is an expansion that could be a guarded one");
		return;
	}
	const where = gitWhere(c, cmds, globals, s);
	const r = gitLevel(sub, words, branch, where !== "session");
	if (r.rule.startsWith("dropped:")) dropped.push(r.rule.slice("dropped:".length));
	if (r.level !== "allow") {
		// A bare push after `git checkout -b x`/`switch -c x` in the same repo (no `cd` or `-C` between) pushes x. A push
		// from a temp repo is not exempt: a clone there still pushes to its real remote.
		if (r.rule === "push:target-unknown" && where === "switched") {
			const target = newBranchBefore(cmds, c);
			if (target !== undefined && !PROTECTED.has(target)) return;
		}
		add(r.level, r.rule, `git ${sub}: ${r.risk}`);
		return;
	}
	// A push whose remote or refspec is an expansion could name main or carry `+`, unless its values are known.
	if (sub === "push") {
		const resolved = args
			.slice(globals.length + 1)
			.map((w) => (w.kind === "expansion" ? resolveWord(w, s, c.at) : [w.value]));
		if (resolved.some((v) => v === undefined || v.some((x) => x.includes(MARK)))) {
			add("ask", "unknown:push-target-expansion", "push remote or refspec is an expansion");
			return;
		}
		for (const ws of product(resolved as string[][])) {
			const r2 = gitLevel(sub, ws, branch, where !== "session");
			if (r2.level !== "allow") {
				add(r2.level, r2.rule, `git push: ${r2.risk}`);
				return;
			}
		}
	}
}
const PROTECTED = new Set(["main", "master"]);

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
	const cIdx = globals.indexOf("-C");
	if (cIdx >= 0) {
		const vals = resolveWord(args[cIdx + 1], s, c.at);
		return vals?.every((v) => v.startsWith(TEMP) && !DOTDOT.test(v)) ? "temp" : "elsewhere";
	}
	if (movesGit(globals) || c.assignments.some((a) => a === "GIT_DIR" || a === "GIT_WORK_TREE")) return "elsewhere";
	const cwd = cwdAt(cmds, c, s);
	const before = cmds.slice(0, cmds.indexOf(c));
	const switched = before.some(
		(x) => x.name === "git" && ["checkout", "switch"].includes(gitSplit(values(x.argv.slice(1))).sub ?? ""),
	);
	if (cwd?.every((v) => v.startsWith(TEMP) && !DOTDOT.test(v))) return "temp";
	if (cwd === undefined || cwd.some((v) => v !== "")) return "elsewhere";
	return switched ? "switched" : "session";
}

/** The branch an earlier `git checkout -b X` / `switch -c X` in this command created, if exactly one. */
function newBranchBefore(cmds: SimpleCommand[], c: SimpleCommand): string | undefined {
	const names: string[] = [];
	for (const x of cmds.slice(0, cmds.indexOf(c))) {
		if (x.name !== "git") continue;
		const { sub, words } = gitSplit(values(x.argv.slice(1)));
		if (sub !== "checkout" && sub !== "switch") continue;
		const i = words.findIndex((w) => /^-[bBcC]$/.test(w));
		if (i < 0 || !words[i + 1]) return undefined;
		names.push(words[i + 1]);
	}
	return names.length ? names.at(-1) : undefined;
}

// Wrappers that run a string or stdin in a new shell process (shell-ast.ts `WRAPPERS`); `trap`/`eval` strings run in
// this shell.
const RUNS_STRING = new Set([
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
	"mksh",
	"ash",
	"su",
	"runuser",
	"sudo",
	"doas",
	"env",
	"flock",
	"ssh",
	"watch",
]);

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
		const files = c.redirects
			.filter((r) => /^(?:\d*>>?\|?|&>>?)$/.test(r.op) && r.target)
			.map((r) => r.target!.value);
		if (c.name === "tee") files.push(...values(c.argv.slice(1)).filter((v) => !v.startsWith("-")));
		for (const file of files) for (const h of c.heredocs) out.push({ file, body: h.body });
	}
	return out;
}

/** Files the command runs as a program: `./x`, `/p/x`, `sh x`, `bash -e x`, `source x`, `. x`; `*` if unknowable. */
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
// bash-truth side: what rm and git really received, by the same rules.

export interface TruthCall {
	name: string;
	argv: string[];
	moved: boolean;
	/** Where `cd` went: an absolute path, `./rel` from the start dir, or "?" (bash-truth.ts). */
	cwdArg: string;
	gitDir: string;
	gitWorkTree: string;
}

/** `startDir`: the row's start directory, standing for the session's repo (absolute paths into it are in-repo). */
export function truthPolicy(calls: TruthCall[], branch: string, startDir = ""): PolicyVerdict {
	const findings: Finding[] = [];
	const dropped: string[] = [];
	let branchMoved = false;
	// The branch the command switched to, when it made a new one (`checkout -b x`) and nothing else moved it.
	let newBranch: string | undefined;
	// An absolute path under the start dir is the repo (`$PWD/x`); `/private/var` and `/var` are one place on macOS.
	const inRepo = (p: string) => {
		const n = p.replace(/^\/private(?=\/var\/)/, "");
		const r = startDir.replace(/^\/private(?=\/var\/)/, "");
		return r !== "" && (n === r || n.startsWith(`${r}/`)) ? `.${n.slice(r.length)}` : undefined;
	};
	for (const c of calls) {
		if (c.name === "rm") {
			const { options, operands } = rmSplit(c.argv);
			if (!rmRecursive(options)) continue;
			const cwd = c.cwdArg === "" ? "" : c.cwdArg;
			for (const o of operands) {
				// A literal `${TMPDIR:?}/x` reaching rm is a relative path: guard's TMPDIR rule doesn't apply.
				const abs = o.startsWith("/") ? o : cwd.startsWith("/") ? `${cwd}/${o}` : undefined;
				const rel = abs !== undefined ? inRepo(abs) : undefined;
				let r: LevelRule;
				const cdBase =
					cwd.startsWith("/") && !o.startsWith("/") && rel === undefined ? afterCd(cwd, o, "") : undefined;
				if (cwd === "?" && !o.startsWith("/"))
					r = worse(rmTargetLevel(o, ""), { level: "ask-if-dirty", rule: "rm:in-repo (after cd)" });
				else if (cdBase) r = cdBase;
				else if (rel !== undefined) r = rmTargetLevel(rel, "");
				else if (abs !== undefined) r = rmTargetLevel(abs, "");
				else r = rmTargetLevel(cwd === "" ? o : `${cwd}/${o}`, "");
				if (r.rule === "rm:in-repo" && cwd !== "") r = { ...r, rule: "rm:in-repo (after cd)" };
				if (r.level !== "allow") findings.push({ level: r.level, rule: r.rule, detail: `rm ${c.argv.join(" ")}` });
			}
		} else if (c.name === "git") {
			const { globals, sub, words } = gitSplit(c.argv);
			if (!sub) continue;
			const moved = c.moved || movesGit(globals) || c.gitDir !== "" || c.gitWorkTree !== "";
			const sameRepoNewBranch = !moved && branchMoved && newBranch !== undefined;
			const r = sameRepoNewBranch
				? gitLevel(sub, words, newBranch!, false)
				: gitLevel(sub, words, branch, branchMoved || moved);
			if (r.rule.startsWith("dropped:")) dropped.push(r.rule.slice("dropped:".length));
			if (r.level !== "allow") findings.push({ level: r.level, rule: r.rule, detail: `git ${c.argv.join(" ")}` });
			if (sub === "checkout" || sub === "switch") {
				const i = words.findIndex((w) => /^-[bBcC]$/.test(w));
				newBranch =
					!moved && i >= 0 && words[i + 1] && (!branchMoved || newBranch !== undefined) ? words[i + 1] : undefined;
				branchMoved = true;
			}
		}
	}
	return { verdict: worst(findings), findings, dropped };
}
