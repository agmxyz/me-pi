/**
 * #78 stage 1 harness (report-only). One command: `node spike/guard-parser/run.ts` from the repo root.
 * Writes spike/guard-parser/results.json (one record per corpus row) and results.md (the per-row table and the
 * A-F lists). Exits non-zero if a self-check fails or the union verdict misses a row bash-truth calls dangerous.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepare, ROW_TIMEOUT_MS, STUB_HOME, STUB_TMPDIR, type Truth, truth } from "./bash-truth.ts";
import { type CorpusRow, corpus } from "./corpus.ts";
import { guard } from "./guard-rules.ts";
import { SELF_CHECKS } from "./rows.ts";
import { parserVerdict, truthVerdict } from "./verdict.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");

// D: load cost, measured cold in this process (module import, WASM runtime init, grammar load).
const tImport = performance.now();
const ast = await import("./shell-ast.ts");
const importMs = performance.now() - tImport;
const tInit = performance.now();
await ast.initShellAst();
const initMs = performance.now() - tInit;

// E: what a missing grammar WASM does.
let initFailure = "";
{
	const probe = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { initShellAst, commands } from ${JSON.stringify(join(here, "shell-ast.ts"))};
			 try { commands("true"); } catch (e) { console.log("commands() before init: " + e.message); }
			 try { await initShellAst(new URL("file:///nonexistent/tree-sitter-bash.wasm")); } catch (e) { console.log("initShellAst(missing wasm): " + e.constructor.name + ": " + e.message); }
			 try { commands("true"); } catch (e) { console.log("commands() after failed init: " + e.message); }`,
		],
		{ encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" },
	);
	initFailure = (probe.stdout + probe.stderr).trim();
}

const rows: CorpusRow[] = corpus();
const allCommands = [...rows.map((r) => r.command), ...SELF_CHECKS.map((s) => s.command)];
const run = prepare(allCommands);

async function pool<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: n }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await f(items[i]);
			}
		}),
	);
	return out;
}

// Self-checks: rows whose rm/git argv is known by hand. A broken stub or sandbox fails here, not silently.
const selfResults = await pool(SELF_CHECKS, 8, async (s) => {
	const t = await truth(run, s.command, { tmpdir: s.tmpdir });
	const got = (name: string) => t.calls.filter((c) => c.name === name).map((c) => c.argv);
	const problems: string[] = [];
	for (const name of ["rm", "git"] as const) {
		const want = s[name];
		if (want && JSON.stringify(got(name)) !== JSON.stringify(want))
			problems.push(`${name}: want ${JSON.stringify(want)}, got ${JSON.stringify(got(name))}`);
	}
	if (t.timedOut) problems.push("timed out");
	return { command: s.command, ok: problems.length === 0, problems };
});

const truths: Truth[] = await pool(rows, 8, (r) => truth(run, r.command, { tmpdir: r.tmpdir }));

const parseTimes: number[] = [];
const results = rows.map((row, i) => {
	const t = truths[i];
	const branch = row.branch ?? "feature/x";
	const regexRisk = guard.classify(row.command, () => branch);
	const t0 = performance.now();
	const cmds = ast.commands(row.command);
	parseTimes.push(performance.now() - t0);
	const parser = parserVerdict(row.command, cmds, branch);
	const truthV = truthVerdict(t, branch);
	const regex = regexRisk ? "ask" : "allow";
	const union = regex === "ask" || parser.verdict === "ask" ? "ask" : "allow";
	const bashArgv = t.calls.filter((c) => c.name === "rm" || c.name === "git").map((c) => [c.name, ...c.argv]);
	const parserArgv =
		cmds
			?.filter((c) => (c.name === "rm" || c.name === "git") && !c.remote)
			.map((c) => ({ argv: c.argv.map((w) => ({ v: w.value, k: w.kind })), open: c.openArgs })) ?? null;
	return {
		id: i,
		source: row.source,
		command: row.command,
		branch,
		tmpdir: row.tmpdir ?? STUB_TMPDIR,
		envRow: row.tmpdir !== undefined,
		regex,
		regexRisk: regexRisk ?? null,
		parser: parser.verdict,
		parserReasons: parser.reasons,
		union,
		truth: truthV.verdict,
		truthReasons: truthV.reasons,
		truthCaveats: truthV.caveats ?? [],
		bashArgv,
		parserArgv,
		bashExit: t.exit,
		timedOut: t.timedOut,
		stderr: t.stderr.slice(0, 500),
		allCalls: t.calls.map((c) => [c.name, ...c.argv]),
		argvMismatch: argvMismatch(bashArgv, parserArgv),
		parserExtra: parserExtra(bashArgv, parserArgv),
	};
});

/**
 * B: does the parser's rm/git argv list match bash's? An expansion word matches any run of words (including none);
 * an `openArgs` command (xargs, find -exec) may get extra words at its end and `{}` replaced.
 */
function argvMismatch(
	bash: string[][],
	parser: { argv: { v: string; k: string }[]; open: boolean }[] | null,
): string | undefined {
	if (parser === null) return bash.length ? "parser failed closed (null); bash ran rm/git" : undefined;
	// A parser command may run many times (loops, find -exec per file); bash's argv[0] is the stub's basename.
	const base = parser.map((p) => ({
		...p,
		argv: p.argv.map((w, i) => (i === 0 ? { ...w, v: w.v.split("/").pop()! } : w)),
	}));
	const missing = [
		...new Set(bash.filter((b) => !base.some((p) => matches(p.argv, b, p.open))).map((b) => b.join(" "))),
	];
	return missing.length
		? `bash ran, parser has no matching argv: ${missing.map((m) => JSON.stringify(m)).join("; ")}`
		: undefined;
}

/** Informational: argv the parser found that bash never ran (branches not taken, bash syntax errors, stdin). */
function parserExtra(
	bash: string[][],
	parser: { argv: { v: string; k: string }[]; open: boolean }[] | null,
): string | undefined {
	if (!parser) return undefined;
	const extra = parser.filter((p) => {
		const argv = p.argv.map((w, i) => (i === 0 ? { ...w, v: w.v.split("/").pop()! } : w));
		return !bash.some((b) => matches(argv, b, p.open));
	});
	return extra.length ? extra.map((p) => JSON.stringify(p.argv.map((w) => w.v).join(" "))).join("; ") : undefined;
}

function matches(p: { v: string; k: string }[], b: string[], open: boolean): boolean {
	const go = (i: number, j: number): boolean => {
		if (i === p.length) return j === b.length || open;
		const w = p[i];
		if (w.k === "expansion") {
			for (let k = j; k <= b.length; k++) if (go(i + 1, k)) return true;
			return false;
		}
		if (j >= b.length) return false;
		if (open && w.v.includes("{}")) return go(i + 1, j + 1);
		return w.v === b[j] && go(i + 1, j + 1);
	};
	return go(0, 0);
}

// D: parse cost over the corpus (warm), plus a 200-line script.
parseTimes.sort((a, b) => a - b);
const pct = (q: number) => parseTimes[Math.min(parseTimes.length - 1, Math.floor(q * parseTimes.length))];
const big = Array.from({ length: 200 }, (_, i) => `git status && rm -rf dist${i} 2>&1 | tail -2`).join("\n");
const tBig = performance.now();
for (let i = 0; i < 20; i++) ast.commands(big);
const bigMs = (performance.now() - tBig) / 20;
const du = (p: string): number =>
	statSync(p).isDirectory() ? readdirSync(p).reduce((s, f) => s + du(join(p, f)), 0) : statSync(p).size;
const cost = {
	grammarWasmBytes: statSync(join(here, "vendor/tree-sitter-bash.wasm")).size,
	webTreeSitterPackageBytes: du(join(root, "node_modules/web-tree-sitter")),
	webTreeSitterRuntimeBytes:
		statSync(join(root, "node_modules/web-tree-sitter/web-tree-sitter.js")).size +
		statSync(join(root, "node_modules/web-tree-sitter/web-tree-sitter.wasm")).size,
	importMs,
	initMs,
	parseP50Ms: pct(0.5),
	parseP99Ms: pct(0.99),
	parseMaxMs: parseTimes.at(-1),
	parse200LineScriptMs: bigMs,
	rows: rows.length,
};

const by = <T>(f: (r: (typeof results)[number]) => T) => results.filter(f as any);
const dangerous = by((r) => r.truth === "dangerous");
const summary = {
	rows: results.length,
	truth: {
		dangerous: dangerous.length,
		safe: by((r) => r.truth === "safe").length,
		unknown: by((r) => r.truth === "unknown").length,
	},
	A: {
		regexMisses: dangerous.filter((r) => r.regex === "allow").map((r) => r.id),
		parserMisses: dangerous.filter((r) => r.parser === "allow").map((r) => r.id),
		unionMisses: dangerous.filter((r) => r.union === "allow").map((r) => r.id),
		// Rows run with a test-given TMPDIR (fix/guard-temp-rm passes classify a third argument main ignores): they test
		// the session's environment, not the command text.
		unionMissesEnv: dangerous.filter((r) => r.union === "allow" && r.envRow).map((r) => r.id),
		unionMissesCommandText: dangerous.filter((r) => r.union === "allow" && !r.envRow).map((r) => r.id),
	},
	B: by((r) => r.argvMismatch !== undefined).map((r) => r.id),
	C: by((r) => r.regex === "ask" && r.truth === "safe").map((r) => r.id),
	F: by((r) => r.truth === "unknown").map((r) => r.id),
	selfChecks: selfResults,
	issue78ParserMisses: by((r) => /#78/.test(r.source) && r.parser === "allow").map((r) => r.id),
};

// C: why the regex asked on a row bash-truth calls safe. First match wins; the first category is stage 3's proposal.
const C_CATEGORIES: [string, RegExp][] = [
	[
		"quoted-delimiter heredoc into plain cat/tee writing a file (proposed allow)",
		/^(?:cat\s*>\s*[\w.]+|tee\s+[\w.]+)\s*<<-?\s*(?:'\w+'|"\w+"|\\\w+)[^\n]*\n[\s\S]*\n\w+$/,
	],
	[
		"program heredoc (python/node/make); truth safe only because the stub doesn't run the program",
		/\b(?:python3?|node|make)\b/,
	],
	["TMPDIR may be rebound before ${TMPDIR:?} (guard's fail-closed tmpdirMayChange)", /\$\{TMPDIR:\?\}/],
	["$TMPDIR / ${TMPDIR} without :? (guard trusts only ${TMPDIR:?})", /\$\{?TMPDIR\}?/],
	["mktemp -d variable (guard doesn't track it on main)", /mktemp/],
	["xargs/find: arguments arrive at run time (none in the sandbox)", /\b(?:xargs|find)\b/],
	["bash 3.2 syntax error (&>> and |& are bash 4)", /&>>|\|&/],
	["other expansion in a target ($DIR, `…`)", /[$`]/],
];
const cCategories = new Map<string, number[]>();
for (const id of summary.C) {
	const name = C_CATEGORIES.find(([, re]) => re.test(results[id].command))?.[0] ?? "uncategorised";
	cCategories.set(name, [...(cCategories.get(name) ?? []), id]);
}
const cSummary = Object.fromEntries(cCategories);

writeFileSync(
	join(here, "results.json"),
	`${JSON.stringify({ env: { bash: "/bin/bash", HOME: STUB_HOME, TMPDIR: STUB_TMPDIR, rowTimeoutMs: ROW_TIMEOUT_MS }, cost, initFailure, summary: { ...summary, cCategories: cSummary }, results })}\n`,
);

// results.md: the per-row table and every list the report cites, regenerated on each run.
const cell = (s: string) => `\`${s.replaceAll("\n", "⏎").replaceAll("|", "\\|").replaceAll("`", "ˋ")}\``;
const argvCell = (a: string[][]) => (a.length ? a.map((x) => cell(JSON.stringify(x))).join("<br>") : "—");
const list = (ids: number[], extra: (r: (typeof results)[number]) => string) =>
	ids.length ? ids.map((id) => `- #${id} ${cell(results[id].command)}: ${extra(results[id])}`).join("\n") : "- none";
const md = [
	"# #78 spike results (generated by `node spike/guard-parser/run.ts`; do not edit)",
	"",
	`Rows: ${results.length}. Bash truth: ${summary.truth.dangerous} dangerous, ${summary.truth.safe} safe, ${summary.truth.unknown} unknown.`,
	"",
	"## A. Misses (bash truth dangerous, verdict allows)",
	"",
	`- regex: ${summary.A.regexMisses.length}; parser: ${summary.A.parserMisses.length}; union: ${summary.A.unionMisses.length} (command-text rows ${summary.A.unionMissesCommandText.length}; A-env: TMPDIR model ${summary.A.unionMissesEnv.length})`,
	"",
	"### Union misses, command text",
	list(summary.A.unionMissesCommandText, (r) => r.truthReasons.join("; ")),
	"",
	"### A-env: TMPDIR model (the test's session TMPDIR, not the command, decides)",
	list(summary.A.unionMissesEnv, (r) => `TMPDIR=${cell(r.tmpdir)}: ${r.truthReasons.join("; ")}`),
	"",
	"### Parser misses",
	list(summary.A.parserMisses, (r) => `regex ${r.regex}; ${r.truthReasons.join("; ")}`),
	"",
	"### Regex misses",
	list(summary.A.regexMisses, (r) => `parser ${r.parser}; ${r.truthReasons.join("; ")}`),
	"",
	"## B. Parser argv differs from bash argv",
	list(summary.B, (r) => `${r.argvMismatch} (parser ${r.parser})`),
	"",
	"## C. Candidate false alarms (regex asks, bash truth safe)",
	...[...cCategories].flatMap(([name, ids]) => [
		"",
		`### ${name}: ${ids.length}`,
		list(ids, (r) => `parser ${r.parser}`),
	]),
	"",
	"## F. Unknowns",
	list(summary.F, (r) => r.truthReasons.join("; ")),
	"",
	"## Self-checks",
	...selfResults.map((s) => `- ${s.ok ? "ok" : "FAIL"} ${cell(s.command)}${s.ok ? "" : `: ${s.problems.join("; ")}`}`),
	"",
	"## All rows",
	"",
	"| # | source | command | branch | regex | parser | union | truth | bash rm/git argv | exit |",
	"|---|---|---|---|---|---|---|---|---|---|",
	...results.map(
		(r) =>
			`| ${r.id} | ${r.source} | ${cell(r.command)} | ${r.branch}${r.envRow ? ` TMPDIR=${cell(r.tmpdir)}` : ""} | ${r.regex} | ${r.parser} | ${r.union} | ${r.truth} | ${argvCell(r.bashArgv)} | ${r.timedOut ? "timeout" : r.bashExit} |`,
	),
	"",
].join("\n");
writeFileSync(join(here, "results.md"), md);
rmSync(run.dir, { recursive: true, force: true });

const failedSelf = selfResults.filter((s) => !s.ok);
console.log(
	JSON.stringify(
		{
			rows: summary.rows,
			truth: summary.truth,
			A: {
				regex: summary.A.regexMisses.length,
				parser: summary.A.parserMisses.length,
				union: summary.A.unionMisses.length,
				unionCommandText: summary.A.unionMissesCommandText.length,
				unionEnv: summary.A.unionMissesEnv.length,
			},
			B: summary.B.length,
			C: summary.C.length,
			cCategories: Object.fromEntries([...cCategories].map(([k, v]) => [k, v.length])),
			F: summary.F.length,
			issue78ParserMisses: summary.issue78ParserMisses,
			selfChecks: `${selfResults.length - failedSelf.length}/${selfResults.length} ok`,
			cost,
		},
		null,
		1,
	),
);
for (const s of failedSelf) console.error(`SELF-CHECK FAILED: ${JSON.stringify(s.command)}: ${s.problems.join("; ")}`);
for (const id of summary.A.unionMissesCommandText) console.error(`UNION MISS: ${JSON.stringify(results[id].command)}`);
for (const id of summary.A.unionMissesEnv)
	console.error(
		`UNION MISS (A-env, TMPDIR=${JSON.stringify(results[id].tmpdir)}): ${JSON.stringify(results[id].command)}`,
	);
process.exitCode = failedSelf.length || summary.A.unionMissesCommandText.length ? 1 : 0;
