/**
 * guard's proof harness (macOS only, local, never in CI): runs every corpus row in real /bin/bash under sandbox-exec
 * with argv-recording stubs (bash-truth.ts), then checks that guard's policy asks wherever what `rm` and `git`
 * actually received is dangerous. `npm run guard-truth`.
 *
 * Fake disk, as the guard tests assume: the row's start dir is the session's repo (`/w/repo`, on the row's branch,
 * with a network `origin`); nothing else is a repo; the stub home is `/Users/stub`.
 *
 * "Dangerous" is guard 0.1.3's rules over bash's argv (a recursive rm of a non-disposable target, or a `gitRisk`), as in
 * the #78 spike. Each dangerous row the policy allows must be a deliberate drop (the same rules over bash's argv,
 * `argvPolicy`, also allow it: history rewrites, local pushes) or one of the known A-env rows (TMPDIR set wrong before
 * the session: guard reads command text, not the environment). Exits 1 on any other miss or a failed self-check.
 */
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import {
	argvPolicy,
	disposable,
	gitSplit,
	movesGit,
	type PolicyEnv,
	policy,
	rmRecursive,
	rmSplit,
} from "../../packages/pi-workers/extensions/guard-policy.ts";
import { gitRisk } from "../../packages/pi-workers/extensions/guard-regex.ts";
import { initShell, parseShell } from "../../packages/pi-workers/extensions/guard-shell.ts";
import { prepare, STUB_HOME, type Truth, truth } from "./bash-truth.ts";

if (process.platform !== "darwin") {
	console.error("guard-truth needs macOS (/usr/bin/sandbox-exec and the bash 3.2 Pi uses there)");
	process.exit(2);
}

interface Row {
	id: number;
	source: string;
	command: string;
	branch: string;
	/** The TMPDIR the row runs under ("" = unset); absent = the harness's own. */
	tmpdir?: string;
}
interface SelfCheck {
	command: string;
	branch?: string;
	tmpdir?: string;
	rm?: string[][];
	git?: string[][];
}
const here = dirname(fileURLToPath(import.meta.url));
const { rows, selfChecks } = JSON.parse(readFileSync(join(here, "corpus.json"), "utf8")) as {
	rows: Row[];
	selfChecks: SelfCheck[];
};
// Known A-env rows: `${TMPDIR:?}/x` with TMPDIR set to `/` (or similar) before the command.
const A_ENV = new Set([538, 543, 548, 553]);

const tInit = performance.now();
await initShell();
const initMs = performance.now() - tInit;

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

const REPO = "/w/repo";
const inRepo = (d: string) => d === REPO || d.startsWith(`${REPO}/`);
const env = (branch: string): PolicyEnv => ({
	cwd: REPO,
	home: STUB_HOME,
	branch: () => branch,
	branchOf: (d) => (inRepo(d) ? branch : undefined),
	repoRootOf: (d) => (inRepo(d) ? REPO : null),
	remoteUrlOf: (d, n) => (inRepo(d) && n === "origin" ? "git@github.com:me/repo.git" : undefined),
	isCheckoutRef: (d, n) =>
		inRepo(d) ? /^(?:main|master|feature\/[\w-]+|other|HEAD(?:[~^]\d*)*)$/.test(n) : undefined,
});
const strip = (p: string) => p.replace(/^\/private(?=\/(?:var|tmp)\/)/, "");
/** A sandbox path as the fake-disk path it stands for: the start dir is the repo. */
const toDisk = (startDir: string) => (p: string) => {
	const n = strip(posix.normalize(p));
	const s = strip(startDir);
	return n === s || n.startsWith(`${s}/`) ? REPO + n.slice(s.length) : n;
};
/** guard 0.1.3's rules over what bash ran: a recursive rm of a non-disposable target, or a risky git call. */
function dangerous(t: Truth, branch: string): string[] {
	const out: string[] = [];
	let branchMoved = false;
	for (const c of t.calls) {
		if (c.name === "rm") {
			const { options, operands } = rmSplit(c.argv);
			if (!rmRecursive(options)) continue;
			const bad = operands.map((o) => o.replace(/\/{2,}/g, "/")).filter((o) => !disposable(o));
			if (bad.length) out.push(`rm ${c.argv.join(" ")}`);
		} else if (c.name === "git") {
			const { globals, sub, words } = gitSplit(c.argv);
			if (!sub) continue;
			const elsewhere = branchMoved || c.moved || movesGit(globals) || c.gitDir !== "" || c.gitWorkTree !== "";
			const risk = gitRisk(sub, words, () => branch, elsewhere);
			if (risk) out.push(`git ${c.argv.join(" ")}: ${risk}`);
			if (sub === "checkout" || sub === "switch") branchMoved = true;
		}
	}
	return out;
}

const run = prepare([...rows.map((r) => r.command), ...selfChecks.map((s) => s.command)]);
try {
	const self = await pool(selfChecks, 8, async (s) => {
		const t = await truth(run, s.command, { tmpdir: s.tmpdir });
		const got = (name: string) => t.calls.filter((c) => c.name === name).map((c) => c.argv);
		const problems = (["rm", "git"] as const).flatMap((name) =>
			s[name] && JSON.stringify(got(name)) !== JSON.stringify(s[name])
				? [`${name}: want ${JSON.stringify(s[name])}, got ${JSON.stringify(got(name))}`]
				: [],
		);
		if (t.timedOut) problems.push("timed out");
		return { command: s.command, problems };
	});
	const truths = await pool(rows, 8, (r) => truth(run, r.command, { tmpdir: r.tmpdir }));
	const parseMs: number[] = [];
	const misses: string[] = [];
	const dropped: string[] = [];
	const aEnv: number[] = [];
	const downgraded: string[] = [];
	let danger = 0;
	let asked = 0;
	for (const [i, row] of rows.entries()) {
		const t = truths[i];
		const t0 = performance.now();
		parseShell(row.command);
		parseMs.push(performance.now() - t0);
		const got = policy(row.command, env(row.branch));
		const want = argvPolicy(t.calls, env(row.branch), toDisk(t.startDir));
		const RANK = { allow: 0, "ask-if-dirty": 1, ask: 2 };
		if (RANK[got.verdict] < RANK[want.verdict] && !A_ENV.has(row.id))
			downgraded.push(`#${row.id} policy ${got.verdict} < bash argv ${want.verdict}: ${want.findings[0]?.detail}`);
		const reasons = dangerous(t, row.branch);
		if (!reasons.length) continue;
		danger++;
		if (got.verdict !== "allow") asked++;
		else if (A_ENV.has(row.id)) aEnv.push(row.id);
		else if (want.verdict === "allow")
			dropped.push(`#${row.id} ${want.dropped.map((d) => `${d.rule}: ${d.detail}`).join("; ") || "?"}`);
		else misses.push(`#${row.id} ${reasons.join("; ")}`);
	}
	const sorted = [...parseMs].sort((a, b) => a - b);
	const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(3);
	const selfFailed = self.filter((s) => s.problems.length);
	console.log(`rows ${rows.length}; dangerous by bash argv (0.1.3 rules) ${danger}: asked ${asked}`);
	console.log(`deliberate drops ${dropped.length}:\n  ${dropped.join("\n  ")}`);
	console.log(`A-env rows allowed (known; guard reads text, not the environment): ${aEnv.join(", ") || "none"}`);
	console.log(`misses on command text: ${misses.length}${misses.length ? `\n  ${misses.join("\n  ")}` : ""}`);
	console.log(
		`policy below its own rules over bash argv: ${downgraded.length}${downgraded.length ? `\n  ${downgraded.join("\n  ")}` : ""}`,
	);
	console.log(`self-checks ${self.length - selfFailed.length}/${self.length}`);
	for (const s of selfFailed) console.log(`  ${JSON.stringify(s.command)}: ${s.problems.join("; ")}`);
	console.log(`parser init ${initMs.toFixed(1)} ms; parse p50 ${pct(0.5)} ms, p99 ${pct(0.99)} ms, max ${pct(1)} ms`);
	process.exitCode = misses.length || selfFailed.length || downgraded.length ? 1 : 0;
} finally {
	rmSync(run.dir, { recursive: true, force: true });
}
