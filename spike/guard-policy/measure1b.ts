/**
 * Step 1b: re-measures with the user's five decisions (policy.ts `PolicyEnv`, disk.ts lookups) against step 1 and
 * guard 0.1.3. `node spike/guard-policy/measure1b.ts` after `extract.ts`.
 *
 * - Real sessions: each command judged with the disk read *now* from its session cwd (an approximation), on
 *   `feature/x` and `main`, as step 1. Prompts 0.1.3 asks that 1b allows are run in bash-truth (stubs only) and
 *   judged by the same 1b rules over what rm/git really received.
 * - Spike corpus (782 rows): no disk (decisions 1, 4, 5 have nothing to read for test commands; they get a fake repo
 *   at the row's start dir instead, see `spikeEnv`). Each row is judged with every decision alone, so a changed verdict
 *   is attributed to the decision that changed it.
 *
 * Privacy: real commands and per-command results stay in /tmp/guard-measure/ (0700 dir, 0600 files).
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepare, STUB_HOME, type Truth, truth } from "../guard-parser/bash-truth.ts";
import { corpus } from "../guard-parser/corpus.ts";
import { guard } from "../guard-parser/guard-rules.ts";
import { commands, initShellAst } from "../guard-parser/shell-ast.ts";
import { truthVerdict } from "../guard-parser/verdict.ts";
import { ALL, type DiskStats, diskEnv } from "./disk.ts";
import { COMMANDS_FILE, type Extracted, OUT_DIR } from "./extract.ts";
import { type Level, type PolicyEnv, type PolicyVerdict, policy, truthPolicy } from "./policy.ts";
import { countBy, pool } from "./util.ts";

await initShellAst();
const BRANCHES = ["feature/x", "main"] as const;
const RANK: Record<Level, number> = { allow: 0, "ask-if-dirty": 1, ask: 2 };

const { commands: real } = JSON.parse(readFileSync(COMMANDS_FILE, "utf8")) as { commands: Extracted[] };
const step1 = JSON.parse(readFileSync(join(OUT_DIR, "results-step1.json"), "utf8"));

// ---------------------------------------------------------------------------------------------------------------
// Real sessions.

const stats: DiskStats = { missingDirs: new Set(), branchRead: new Set(), branchMissing: new Set() };
interface Real1b {
	i: number;
	count: number;
	main: boolean;
	old: Record<string, string | null>;
	s1: Record<string, Level>;
	neu: Record<string, PolicyVerdict>;
	/** Which decisions alone change the step-1 verdict on feature/x (attribution). */
	by: number[];
	truth?: { policy: PolicyVerdict; truth: string };
}
const real1b: Real1b[] = real.map((e, i) => {
	const cwd = e.cwds[0];
	const env = diskEnv(cwd, stats);
	const neu = Object.fromEntries(BRANCHES.map((b) => [b, policy(e.command, b, env)]));
	const s1 = Object.fromEntries(BRANCHES.map((b) => [b, step1.realResults[i].neu[b].verdict as Level]));
	// Attribution: `0` is a code change that needs no decision (the env with none); else each decision alone vs that.
	const by: number[] = [];
	if (neu["feature/x"].verdict !== s1["feature/x"]) {
		const base = policy(e.command, "feature/x", diskEnv(cwd, stats, new Set())).verdict;
		if (base !== s1["feature/x"]) by.push(0);
		for (const d of ALL) {
			const alone = policy(e.command, "feature/x", diskEnv(cwd, stats, new Set([d])));
			if (alone.verdict !== base) by.push(d);
		}
	}
	return {
		i,
		count: e.count,
		main: e.main,
		old: Object.fromEntries(BRANCHES.map((b) => [b, guard.classify(e.command, () => b) ?? null])),
		s1,
		neu,
		by,
	};
});

// Sensitivity only: the same with `/Users/<me>/fun/me-pi` (moved since) read at its current place. Not the headline.
const MOVED: Record<string, string> = { [`${process.env.HOME}/fun/me-pi`]: `${process.env.HOME}/fun/agm/me-pi` };
const aliasStats: DiskStats = { missingDirs: new Set(), branchRead: new Set(), branchMissing: new Set() };
const aliasVerdict = real.map((e) => {
	const env = diskEnv(e.cwds[0], aliasStats, ALL, MOVED);
	return Object.fromEntries(BRANCHES.map((b) => [b, policy(e.command, b, env).verdict]));
});

// Bash-truth for every 0.1.3 prompt that 1b allows on both branches (step 1 confirmed its own drops; re-run all so the
// 1b truth rules judge them).
// Decision 2 risk on real commands: every command whose parse failed and that 1b now allows (0.1.3 allowed it too, so
// it isn't a dropped prompt) is run as well.
const toConfirm = real1b.filter(
	(r) =>
		BRANCHES.every((b) => r.neu[b].verdict === "allow") &&
		(BRANCHES.some((b) => r.old[b] !== null) || BRANCHES.some((b) => r.neu[b].fallbacks.length > 0)),
);
const run = prepare(toConfirm.map((r) => real[r.i].command));
await pool(toConfirm, 8, async (r) => {
	const t = await truth(run, real[r.i].command);
	const env = diskEnv(real[r.i].cwds[0], stats);
	const ps = BRANCHES.map((b) => truthPolicy(t.calls, b, t.startDir, env, STUB_HOME));
	const p = ps.reduce((a, x) => (RANK[x.verdict] > RANK[a.verdict] ? x : a));
	r.truth = { policy: p, truth: truthVerdict(t, "main").verdict };
});
rmSync(run.dir, { recursive: true, force: true });

// ---------------------------------------------------------------------------------------------------------------
// Spike corpus: a fake disk. The row's start dir (the session's cwd) is a repo on the row's branch with a network
// `origin`; nothing else is a repo. That is the setting the test rows assume.

const rows = corpus();
const srun = prepare(rows.map((r) => r.command));
const truths: Truth[] = await pool(rows, 8, (r) => truth(srun, r.command, { tmpdir: r.tmpdir }));
rmSync(srun.dir, { recursive: true, force: true });
const SPIKE_CWD = "/w/repo";
function spikeEnv(branch: string, decisions: ReadonlySet<number>): PolicyEnv {
	const inRepo = (d: string) => d === SPIKE_CWD || d.startsWith(`${SPIKE_CWD}/`);
	const env: PolicyEnv = { cwd: SPIKE_CWD, home: STUB_HOME };
	if (decisions.has(1)) env.branchOf = (d) => (inRepo(d) ? branch : undefined);
	if (decisions.has(4)) env.repoRootOf = (d) => (inRepo(d) ? SPIKE_CWD : undefined);
	if (decisions.has(5))
		env.remoteUrlOf = (d, n) => (inRepo(d) && n === "origin" ? "git@github.com:me/repo.git" : undefined);
	if (decisions.has(2)) env.fallback = (t, b) => guard.classify(t, () => b);
	if (decisions.has(3)) env.parserTmpdir = true;
	if (decisions.has(6)) env.operandFix = true;
	return env;
}
const spike = rows.map((row, i) => {
	const branch = row.branch ?? "feature/x";
	const t = truths[i];
	const env = spikeEnv(branch, ALL);
	// The sandbox's start dir stands for SPIKE_CWD.
	const want = truthPolicy(t.calls, branch, t.startDir, env, STUB_HOME);
	const got = policy(row.command, branch, env);
	const s1 = step1.spike[i].got.verdict as Level;
	const by: number[] = [];
	if (got.verdict !== s1) {
		const base = policy(row.command, branch, spikeEnv(branch, new Set())).verdict;
		if (base !== s1) by.push(0);
		for (const d of ALL) if (policy(row.command, branch, spikeEnv(branch, new Set([d]))).verdict !== base) by.push(d);
	}
	return {
		id: i,
		branch,
		envRow: row.tmpdir !== undefined,
		oldTruth: truthVerdict(t, branch).verdict,
		s1,
		want,
		got,
		by,
		parseFails: commands(row.command) === null,
		command: row.command,
	};
});
const dangerous = spike.filter((s) => s.oldTruth === "dangerous");
const notCaught = dangerous.filter((s) => s.got.verdict === "allow" && s.want.verdict !== "allow");
const dropped = dangerous.filter((s) => s.got.verdict === "allow" && s.want.verdict === "allow");
const downgraded = spike.filter((s) => RANK[s.got.verdict] < RANK[s.want.verdict]);
// Decision 2 risk: a row that fails to parse, where the 0.1.3 fallback allows, and bash-truth calls dangerous.
const d2risk = spike.filter(
	(s) => (s.parseFails || s.got.fallbacks.length > 0) && s.got.verdict === "allow" && s.oldTruth === "dangerous",
);
const changed = spike.filter((s) => s.got.verdict !== s.s1);

const sumC = (xs: Real1b[]) => xs.reduce((a, r) => a + r.count, 0);
const mainRs = real1b.filter((r) => r.main);
const realAgg = Object.fromEntries(
	BRANCHES.map((b) => {
		const by = (rs: Real1b[], f: (r: Real1b) => boolean) => {
			const xs = rs.filter(f);
			return { unique: xs.length, total: sumC(xs) };
		};
		return [
			b,
			{
				old_ask: by(mainRs, (r) => r.old[b] !== null),
				step1_ask: by(mainRs, (r) => r.s1[b] === "ask"),
				step1_ask_if_dirty: by(mainRs, (r) => r.s1[b] === "ask-if-dirty"),
				new_ask: by(mainRs, (r) => r.neu[b].verdict === "ask"),
				new_ask_if_dirty: by(mainRs, (r) => r.neu[b].verdict === "ask-if-dirty"),
				newOnly: mainRs.filter((r) => r.old[b] === null && r.neu[b].verdict !== "allow").length,
				fallbacks: mainRs.filter((r) => r.neu[b].fallbacks.length > 0).length,
				fallbackAsk: mainRs.filter((r) => r.neu[b].findings.some((f) => f.rule === "fallback:0.1.3")).length,
			},
		];
	}),
);
const summary = {
	real: {
		unique: mainRs.length,
		total: sumC(mainRs),
		byBranch: realAgg,
		changedFromStep1: countBy(
			mainRs.filter((r) => r.neu["feature/x"].verdict !== r.s1["feature/x"]),
			(r) =>
				`${r.s1["feature/x"]} → ${r.neu["feature/x"].verdict} by ${r.by.map((d) => (d === 0 ? "code fix" : `decision ${d === 6 ? "#2625 fix" : d}`)).join(" + ") || "combination"}`,
		),
		disk: {
			missingDirs: stats.missingDirs.size,
			branchRead: stats.branchRead.size,
			branchMissing: stats.branchMissing.size,
			branchAskedMissing: mainRs.filter((r) =>
				r.neu["feature/x"].findings.some((f) => f.rule === "push:target-unknown" && /isn't a repo/.test(f.detail)),
			).length,
			branchResolvedAllow: mainRs.filter(
				(r) => r.s1["feature/x"] !== "allow" && r.neu["feature/x"].verdict === "allow" && r.by.includes(1),
			).length,
		},
		movedRepoSensitivity: Object.fromEntries(
			BRANCHES.map((b) => [
				b,
				{
					ask: mainRs.filter((r) => aliasVerdict[r.i][b] === "ask").length,
					askIfDirty: mainRs.filter((r) => aliasVerdict[r.i][b] === "ask-if-dirty").length,
					branchRead: aliasStats.branchRead.size,
				},
			]),
		),
	},
	confirm: {
		ran: toConfirm.length,
		byTruthPolicy: countBy(toConfirm, (r) => r.truth!.policy.verdict),
		failures: toConfirm.filter((r) => r.truth!.policy.verdict !== "allow").map((r) => r.i),
		newlyDropped: toConfirm.filter(
			(r) => BRANCHES.some((b) => r.s1[b] !== "allow") && BRANCHES.some((b) => r.old[b] !== null),
		).length,
		fallbackAllowed: toConfirm.filter((r) => BRANCHES.some((b) => r.neu[b].fallbacks.length > 0)).length,
		fallbackAllowedFailures: toConfirm
			.filter((r) => BRANCHES.some((b) => r.neu[b].fallbacks.length > 0) && r.truth!.policy.verdict !== "allow")
			.map((r) => r.i),
	},
	spike: {
		rows: spike.length,
		oldTruthDangerous: dangerous.length,
		stillAsk: dangerous.length - notCaught.length - dropped.length,
		intentionallyDropped: dropped.length,
		intentionallyDroppedByCategory: countBy(dropped, (s) => [...new Set(s.want.dropped)].join(" + ") || "?"),
		notCaught: notCaught.map((s) => ({ id: s.id, envRow: s.envRow })),
		newTruthDowngraded: downgraded.map((s) => ({
			id: s.id,
			envRow: s.envRow,
			want: s.want.verdict,
			got: s.got.verdict,
		})),
		changedFromStep1: changed.map((s) => ({
			id: s.id,
			from: s.s1,
			to: s.got.verdict,
			by: s.by,
			oldTruth: s.oldTruth,
		})),
		parseFailRows: spike.filter((s) => s.parseFails).length,
		decision2Risk: d2risk.map((s) => s.id),
	},
};
writeFileSync(join(OUT_DIR, "results1b.json"), JSON.stringify({ summary, real1b, spike, aliasVerdict }), {
	mode: 0o600,
});
writeFileSync(join(OUT_DIR, "summary1b.json"), JSON.stringify(summary, null, 1), { mode: 0o600 });
console.log(
	JSON.stringify(
		{ ...summary, spike: { ...summary.spike, changedFromStep1: summary.spike.changedFromStep1.length } },
		null,
		1,
	),
);
if (summary.spike.decision2Risk.length || summary.confirm.failures.length) process.exitCode = 2;
