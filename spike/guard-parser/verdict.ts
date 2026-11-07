/**
 * Verdicts. All three reuse guard's own rules (guard-rules.ts): `DISPOSABLE`, the `..` check, the `${TMPDIR:?}` rebind
 * check, `hasShort`, and `gitRisk`. Only how argv is found differs.
 * - truth: what `rm` and `git` received in real bash (bash-truth.ts);
 * - parser: the argv lists shell-ast.ts finds;
 * - regex: guard's `classify` as shipped.
 */
import type { Call, Truth } from "./bash-truth.ts";
import { disposable, gitSplit, guard, movesGit, rmRecursive, rmSplit } from "./guard-rules.ts";
import type { SimpleCommand, Word } from "./shell-ast.ts";

export type TruthVerdict = "dangerous" | "safe" | "unknown";
export interface Verdict<V> {
	verdict: V;
	reasons: string[];
	caveats?: string[];
}

const DIR_CHANGERS = new Set(["cd", "pushd", "popd"]);
/** Tools whose stub only logs but whose real self runs code or makes a file a later command may run. */
const OPAQUE = new Set(["python", "python3", "node", "make", "perl", "ruby", "npm", "npx", "pi"]);
// `a//b` and `a/b` name the same path for rm; bash's argv keeps what the expansion produced (`$TMPDIR/x` with a
// trailing-slash TMPDIR).
const squash = (p: string) => p.replace(/\/{2,}/g, "/");

/** Truth: did real bash hand `rm` a recursive flag and a target guard wouldn't allow, or `git` a risky sub-command? */
export function truthVerdict(t: Truth, branch: string): Verdict<TruthVerdict> {
	const reasons: string[] = [];
	let branchMoved = false;
	for (const c of t.calls) {
		if (c.name === "rm") {
			const { options, operands } = rmSplit(c.argv);
			if (!rmRecursive(options)) continue;
			// A literal `${TMPDIR:?}/x` reaching rm is a relative path: guard's TMPDIR rule doesn't apply ("" can't rebind).
			const bad = operands.map(squash).filter((o) => !disposable(o, ""));
			if (bad.length) reasons.push(`rm ${c.argv.join(" ")} → ${bad.join(", ")}`);
		} else if (c.name === "git") {
			const { globals, sub, words } = gitSplit(c.argv);
			if (!sub) continue;
			const elsewhere = branchMoved || c.moved || movesGit(globals) || c.gitDir !== "" || c.gitWorkTree !== "";
			const risk = guard.gitRisk(sub, words, () => branch, elsewhere);
			if (risk) reasons.push(`git ${c.argv.join(" ")} → ${risk}`);
			if (sub === "checkout" || sub === "switch") branchMoved = true;
		}
	}
	// Caveat only (agreed with the coordinator): log-only stubs for tools that run code (python3, node, make) don't
	// show what that code would do; guard doesn't police those programs either.
	const opaque = [...new Set(t.calls.map((c) => c.name).filter((n) => OPAQUE.has(n)))];
	const caveats = opaque.length ? [`opaque program ran (log-only stub): ${opaque.join(", ")}`] : [];
	if (reasons.length) return { verdict: "dangerous", reasons, caveats };
	const unknown: string[] = [];
	if (t.timedOut) unknown.push("timeout");
	const remote = t.calls.filter((c: Call) => c.name === "ssh" || c.name === "watch");
	for (const c of remote) unknown.push(`remote/deferred: ${c.name} ${c.argv.join(" ")}`);
	if (/Operation not permitted/.test(t.stderr)) unknown.push("an exec the sandbox denied (path not routed to a stub)");
	if (/command not found/.test(t.stderr)) unknown.push("a command name not found (built at run time)");
	// `. ./vars`, `./install.sh`: the file's content decides, and the corpus doesn't provide it.
	// (A name with `=` (`TMP""DIR=/`) failing to run is settled: bash ran no command, so nothing reached rm.)
	if (/^.*: [^=\n]*: (?:No such file or directory|Permission denied)$/m.test(t.stderr))
		unknown.push("sources or runs a file the command doesn't create (its content decides)");
	return unknown.length
		? { verdict: "unknown", reasons: unknown, caveats }
		: { verdict: "safe", reasons: [], caveats };
}

/** Parser: guard's rm and git rules over the argv lists shell-ast.ts found; anything it can't read asks. */
export function parserVerdict(src: string, cmds: SimpleCommand[] | null, branch: string): Verdict<"ask" | "allow"> {
	if (cmds === null) return { verdict: "ask", reasons: ["parse error or limit"] };
	const reasons: string[] = [];
	const elsewhereAll = cmds.some(
		(c) =>
			(c.name !== undefined && DIR_CHANGERS.has(c.name)) ||
			(c.name === "git" && ["checkout", "switch"].includes(gitSplit(values(c.argv.slice(1))).sub ?? "")),
	);
	for (const c of cmds) {
		if (c.dynamicBody !== undefined) {
			reasons.push(`command string not literal: ${c.via.at(-1)} ${c.dynamicBody}`);
			continue;
		}
		if (c.name === undefined) {
			reasons.push(`command name is an expansion: ${c.argv[0].raw}`);
			continue;
		}
		if (c.name === "rm") {
			const r = rmVerdict(c, src);
			if (r) reasons.push(r);
		} else if (c.name === "git") {
			const r = gitVerdict(c, branch, elsewhereAll);
			if (r) reasons.push(r);
		}
	}
	return reasons.length ? { verdict: "ask", reasons } : { verdict: "allow", reasons };
}

const values = (ws: Word[]) => ws.map((w) => w.value);

function rmVerdict(c: SimpleCommand, src: string): string | undefined {
	const args = c.argv.slice(1);
	const end = args.findIndex((w) => w.kind !== "expansion" && w.value === "--");
	const before = end < 0 ? args : args.slice(0, end);
	const after = end < 0 ? [] : args.slice(end + 1);
	const options = before.filter((w) => w.kind !== "expansion" && w.value.startsWith("-") && w.value !== "-");
	const operands = [
		...before.filter((w) => w.kind === "expansion" || !w.value.startsWith("-") || w.value === "-"),
		...after,
	];
	// An expansion before `--` could expand to an option (`rm "${args[@]}"`, `rm $f` with f=-rf).
	const maybeOption = before.some((w) => w.kind === "expansion" && !/^[^-$`]/.test(w.value));
	const recursive = rmRecursive(values(options));
	if (!recursive && !maybeOption && !c.openArgs) return undefined;
	const bad = operands.filter((w) => !targetDisposable(w, src));
	if (c.openArgs) return `rm ${raw(c)}: arguments arrive at run time (${c.via.join(" > ")})`;
	if (!recursive) return bad.length ? `rm ${raw(c)}: an expansion may hold -r` : undefined;
	if (!operands.length) return `rm ${raw(c)}: recursive with no target`;
	return bad.length ? `rm ${raw(c)} → ${bad.map((w) => w.raw).join(", ")}` : undefined;
}

function targetDisposable(w: Word, src: string): boolean {
	if (w.kind === "expansion") return w.tmpdirOnly && w.value.startsWith("${TMPDIR:?}/") && disposable(w.value, src);
	return disposable(w.value, src);
}

function gitVerdict(c: SimpleCommand, branch: string, elsewhereAll: boolean): string | undefined {
	const args = c.argv.slice(1);
	const { globals, sub, words } = gitSplit(values(args));
	const subWord = args[globals.length];
	if (!sub) return undefined;
	if (subWord?.kind === "expansion" || args.slice(0, globals.length).some((w) => w.kind === "expansion"))
		return `git ${raw(c)}: sub-command or global option is an expansion`;
	const elsewhere =
		elsewhereAll || movesGit(globals) || c.assignments.some((a) => a === "GIT_DIR" || a === "GIT_WORK_TREE");
	const risk = guard.gitRisk(sub, words, () => branch, elsewhere);
	if (risk) return `git ${raw(c)} → ${risk}`;
	// A push whose remote or refspec is an expansion has an unknown target.
	if (sub === "push" && args.slice(globals.length + 1).some((w) => w.kind === "expansion"))
		return `git ${raw(c)}: push target is an expansion`;
	return undefined;
}

const raw = (c: SimpleCommand) =>
	c.argv
		.slice(1)
		.map((w) => w.raw)
		.join(" ");
