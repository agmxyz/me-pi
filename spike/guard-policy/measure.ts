/**
 * Measures the prototype policy (policy.ts) against guard 0.1.3 (`classify` on origin/main) on real session commands,
 * and checks it against the #78 spike corpus. `node spike/guard-policy/measure.ts` after `extract.ts`.
 *
 * Privacy: real commands and per-command results stay in /tmp/guard-measure/ (0700 dir, 0600 files). This script
 * prints and writes into the repo only aggregate counts.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepare, type Truth, truth } from "../guard-parser/bash-truth.ts";
import { corpus } from "../guard-parser/corpus.ts";
import { guard } from "../guard-parser/guard-rules.ts";
import { initShellAst } from "../guard-parser/shell-ast.ts";
import { truthVerdict } from "../guard-parser/verdict.ts";
import { COMMANDS_FILE, type Extracted, OUT_DIR } from "./extract.ts";
import { type Level, type PolicyVerdict, policy, truthPolicy } from "./policy.ts";

await initShellAst();

/** The session's branch at the time isn't recorded; judge on a feature branch and, separately, on main. */
const BRANCHES = ["feature/x", "main"] as const;

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

const { commands: real } = JSON.parse(readFileSync(COMMANDS_FILE, "utf8")) as { commands: Extracted[] };

interface RealResult {
	i: number;
	count: number;
	main: boolean;
	worker: boolean;
	old: Record<string, string | null>;
	neu: Record<string, PolicyVerdict>;
	truth?: { policy: PolicyVerdict; truth: string; truthReasons: string[]; exit: number | null; timedOut: boolean };
}

const realResults: RealResult[] = real.map((e, i) => ({
	i,
	count: e.count,
	main: e.main,
	worker: e.worker,
	old: Object.fromEntries(BRANCHES.map((b) => [b, guard.classify(e.command, () => b) ?? null])),
	neu: Object.fromEntries(BRANCHES.map((b) => [b, policy(e.command, b)])),
}));

// Every command 0.1.3 asks about (on either branch) that the new policy allows (on both): run it in bash-truth.
const toConfirm = realResults.filter(
	(r) => BRANCHES.some((b) => r.old[b] !== null) && BRANCHES.every((b) => r.neu[b].verdict === "allow"),
);
const run = prepare(toConfirm.map((r) => real[r.i].command));
await pool(toConfirm, 8, async (r) => {
	const t = await truth(run, real[r.i].command);
	// Worst over both branches.
	const ps = BRANCHES.map((b) => truthPolicy(t.calls, b, t.startDir));
	const p = ps.find((x) => x.verdict === "ask") ?? ps.find((x) => x.verdict === "ask-if-dirty") ?? ps[0];
	const tv = truthVerdict(t, "main");
	r.truth = {
		policy: { ...p, dropped: [...new Set(ps.flatMap((x) => x.dropped))] },
		truth: tv.verdict,
		truthReasons: tv.reasons,
		exit: t.exit,
		timedOut: t.timedOut,
	};
});
rmSync(run.dir, { recursive: true, force: true });

// Spike corpus (782 rows): bash truth under the old rules (`truthVerdict`) and under the new ones (`truthPolicy`).
const rows = corpus();
const srun = prepare(rows.map((r) => r.command));
const truths: Truth[] = await pool(rows, 8, (r) => truth(srun, r.command, { tmpdir: r.tmpdir }));
rmSync(srun.dir, { recursive: true, force: true });
const spike = rows.map((row, i) => {
	const branch = row.branch ?? "feature/x";
	const t = truths[i];
	const old = truthVerdict(t, branch);
	const want = truthPolicy(t.calls, branch, t.startDir);
	const got = policy(row.command, branch);
	return { id: i, branch, envRow: row.tmpdir !== undefined, oldTruth: old.verdict, want, got, command: row.command };
});

const RANK: Record<Level, number> = { allow: 0, "ask-if-dirty": 1, ask: 2 };
const spikeDangerous = spike.filter((s) => s.oldTruth === "dangerous");
const stillAsk = spikeDangerous.filter((s) => s.got.verdict !== "allow");
const droppedOnly = spikeDangerous.filter((s) => s.got.verdict === "allow" && s.want.verdict === "allow");
const notCaught = spikeDangerous.filter((s) => s.got.verdict === "allow" && s.want.verdict !== "allow");
// The new policy's own truth: a row bash shows needs `ask` (or `ask-if-dirty`) and the parser gives less.
const downgraded = spike.filter((s) => RANK[s.got.verdict] < RANK[s.want.verdict]);
const spikeOut = {
	rows: spike.length,
	oldTruthDangerous: spikeDangerous.length,
	stillAsk: stillAsk.length,
	stillAskByLevel: countBy(stillAsk, (s) => s.got.verdict),
	intentionallyDropped: droppedOnly.length,
	intentionallyDroppedByCategory: countBy(droppedOnly, (s) => [...new Set(s.want.dropped)].join(" + ") || "?"),
	notCaught: notCaught.map((s) => ({ id: s.id, envRow: s.envRow, want: s.want })),
	newTruthDowngraded: downgraded.map((s) => ({
		id: s.id,
		envRow: s.envRow,
		want: s.want.verdict,
		got: s.got.verdict,
		wantRules: s.want.findings.map((f) => f.rule),
	})),
};

function countBy<T>(xs: T[], key: (x: T) => string, weight: (x: T) => number = () => 1): Record<string, number> {
	const m: Record<string, number> = {};
	for (const x of xs) m[key(x)] = (m[key(x)] ?? 0) + weight(x);
	return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
}

// Aggregates over real commands, per scope (main-session commands; all incl. workers) and branch.
const scopes = { "main session": realResults.filter((r) => r.main), "all (incl. workers)": realResults };
const agg = Object.fromEntries(
	Object.entries(scopes).map(([scope, rs]) => [
		scope,
		{
			unique: rs.length,
			total: rs.reduce((a, r) => a + r.count, 0),
			byBranch: Object.fromEntries(
				BRANCHES.map((b) => {
					const oldAsk = rs.filter((r) => r.old[b] !== null);
					const newBy = (v: Level) => rs.filter((r) => r.neu[b].verdict === v);
					const sum = (xs: RealResult[]) => xs.reduce((a, r) => a + r.count, 0);
					return [
						b,
						{
							old_ask: { unique: oldAsk.length, total: sum(oldAsk) },
							new_ask: { unique: newBy("ask").length, total: sum(newBy("ask")) },
							new_ask_if_dirty: { unique: newBy("ask-if-dirty").length, total: sum(newBy("ask-if-dirty")) },
							old_reasons: countBy(oldAsk, (r) => r.old[b]!),
							new_rules: countBy(
								rs.filter((r) => r.neu[b].verdict !== "allow"),
								(r) => [...new Set(r.neu[b].findings.map((f) => f.rule))].sort().join(" + "),
							),
							newOnly: rs.filter((r) => r.old[b] === null && r.neu[b].verdict !== "allow").length,
						},
					];
				}),
			),
		},
	]),
);
const confirm = {
	ran: toConfirm.length,
	byTruthPolicy: countBy(toConfirm, (r) => r.truth!.policy.verdict),
	failures: toConfirm.filter((r) => r.truth!.policy.verdict !== "allow").map((r) => r.i),
	byOldTruth: countBy(toConfirm, (r) => r.truth!.truth),
	droppedCategories: countBy(toConfirm, (r) => {
		const old = BRANCHES.map((b) => r.old[b]).find((x) => x !== null)!;
		return old;
	}),
};

const summary = { real: agg, confirm, spike: spikeOut };
writeFileSync(join(OUT_DIR, "results.json"), JSON.stringify({ summary, realResults, spike }), { mode: 0o600 });
writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 1), { mode: 0o600 });
console.log(JSON.stringify(summary, null, 1));
