/**
 * guard's oracle (method step 2): judges every corpus row (`test/guard-corpus.json`, and the review rounds' rows in
 * `test/guard-corpus-review.json`) and every generated row
 * (`test/guard-generate.ts`) with the live guard path (`policy` on real fixture repos, plus the dirty check) and with
 * guard 0.1.3's `classify`, and prints the same three numbers every time:
 *
 * - regressions: 0.1.3 asks, the new guard allows, and the row isn't expected to allow (must be 0); one expected to
 *   allow is a lift (a measured-safe category proven: clean tree, temp target, text), counted apart;
 * - old gaps: dangerous by expectation, both allow (reported; rows marked `known` are the listed ones);
 * - false prompts: expected allow, the new guard asks.
 *
 * Fixtures are real repos under a fresh dir in `$HOME/.cache` (not temp: guard allows temp repos by design): `clean`
 * and `dirty` on `feat`, `main` on `main`, `sub` = `clean/src`, `temp` a fresh temp dir; each with a network `origin`.
 * Nothing from a row is run; guard only makes read-only git queries. `npm run guard-oracle` (`--list` prints the rows
 * behind each number); `test/guard-oracle.test.ts` runs it in `npm run check`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { guardRisk } from "../packages/pi-workers/extensions/guard.ts";
import { classify } from "../packages/pi-workers/extensions/guard-regex.ts";
import { initShell } from "../packages/pi-workers/extensions/guard-shell.ts";
import { type Fixture, generated, type Row } from "./guard-generate.ts";

const here = dirname(fileURLToPath(import.meta.url));

export interface Verdicts {
	row: Row;
	old: boolean;
	now: boolean;
}
export interface OracleResult {
	rows: number;
	regressions: Verdicts[];
	oldGaps: Verdicts[];
	falsePrompts: Verdicts[];
	/** 0.1.3 asks, the new guard allows, and the row expects allow: the S-category lifts. */
	lifts: Verdicts[];
}

/** Creates the fixture repos under `root` (a fresh dir); returns each fixture's cwd. */
export function fixtures(root: string): Record<Fixture, string> {
	const git = (cwd: string, ...a: string[]) =>
		execFileSync("git", ["-C", cwd, "-c", "user.email=o@example.com", "-c", "user.name=o", ...a], { stdio: "pipe" });
	const repo = (name: string, branch: string, dirty: boolean) => {
		const d = join(root, name);
		mkdirSync(join(d, "src", "sub"), { recursive: true });
		git(root, "init", "-q", "-b", branch, d);
		writeFileSync(join(d, "src", "a.txt"), "1\n");
		writeFileSync(join(d, "src", "sub", "b.txt"), "1\n");
		git(d, "add", ".");
		git(d, "commit", "-q", "-m", "init");
		git(d, "branch", "other");
		git(d, "remote", "add", "origin", "https://example.invalid/r.git");
		if (dirty) {
			writeFileSync(join(d, "src", "a.txt"), "changed\n");
			writeFileSync(join(d, "src", "new.txt"), "untracked\n");
		}
		return d;
	};
	const clean = repo("clean", "feat", false);
	// Remotes whose fetch URL is local but whose push URL is a network one (`pushurl`, `pushInsteadOf`): a push there is
	// case 3. `local` pushes to a bare repo for real; `assumed`/`skipped` hide a change from `git status`.
	git(root, "init", "-q", "--bare", join(root, "bare.git"));
	git(clean, "remote", "add", "local", join(root, "bare.git"));
	git(clean, "remote", "add", "pushurl", join(root, "bare.git"));
	git(clean, "config", "remote.pushurl.pushurl", "https://example.invalid/x.git");
	git(root, "init", "-q", "--bare", join(root, "rewritten.git"));
	git(clean, "remote", "add", "rewrite", join(root, "rewritten.git"));
	git(clean, "config", "url.https://example.invalid/.pushInsteadOf", join(root, "rewritten.git"));
	const hidden = repo("hidden", "feat", false);
	writeFileSync(join(hidden, "src", "a.txt"), "changed\n");
	git(hidden, "update-index", "--assume-unchanged", "src/a.txt");
	writeFileSync(join(hidden, "src", "sub", "b.txt"), "changed\n");
	git(hidden, "update-index", "--skip-worktree", "src/sub/b.txt");
	return {
		clean,
		dirty: repo("dirty", "feat", true),
		main: repo("onmain", "main", false),
		sub: join(clean, "src"),
		hidden,
		temp: mkdtempSync(join(tmpdir(), "guard-oracle-")),
	};
}

/** The corpus rows (`test/guard-corpus.json`) and the generated rows. */
export function allRows(): Row[] {
	const load = (f: string) => (JSON.parse(readFileSync(join(here, f), "utf8")) as { rows: Row[] }).rows;
	return [...load("guard-corpus.json"), ...load("guard-corpus-review.json"), ...generated()];
}

/** Judges `rows` in the fixtures: the three numbers and the rows behind them. */
export function judgeRows(rows: Row[], cwds: Record<Fixture, string>): OracleResult {
	const user = userInfo().username;
	const fill = (cmd: string) =>
		cmd
			.replaceAll("@CLEAN@", cwds.clean)
			.replaceAll("@DIRTY@", cwds.dirty)
			.replaceAll("@MAIN@", cwds.main)
			.replaceAll("@HIDDEN@", cwds.hidden)
			.replaceAll("@USER@", user);
	const out: OracleResult = { rows: rows.length, regressions: [], oldGaps: [], falsePrompts: [], lifts: [] };
	for (const row of rows) {
		const cwd = cwds[row.cwd];
		const cmd = fill(row.cmd);
		const now = guardRisk(cmd, cwd, { parser: true, worker: false }) !== undefined;
		const old = classify(cmd, () => branchAt(cwd)) !== undefined;
		const v = { row: { ...row, cmd }, old, now };
		// `ask-if-dirty` on a clean fixture is an allow; on dirty, an ask.
		const want = row.want === "ask-if-dirty" ? (row.cwd === "dirty" ? "ask" : "allow") : row.want;
		if (old && !now) (want === "allow" ? out.lifts : out.regressions).push(v);
		if (want === "ask" && !old && !now) out.oldGaps.push(v);
		if (want === "allow" && now) out.falsePrompts.push(v);
	}
	return out;
}

function branchAt(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { stdio: "pipe" }).toString().trim();
	} catch {
		return undefined;
	}
}

/** Runs the oracle on fresh fixtures (removed after). */
export async function runOracle(rows: Row[] = allRows()): Promise<OracleResult> {
	await initShell();
	const base = join(homedir(), ".cache");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "guard-oracle-"));
	const cwds = fixtures(root);
	try {
		return judgeRows(rows, cwds);
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(cwds.temp, { recursive: true, force: true });
	}
}

export const summary = (r: OracleResult) =>
	`rows ${r.rows}: regressions ${r.regressions.length}, old gaps ${r.oldGaps.length} (known ${r.oldGaps.filter((v) => v.row.known).length}), false prompts ${r.falsePrompts.length} (lifts ${r.lifts.length})`;

if (import.meta.main) {
	const r = await runOracle();
	console.log(summary(r));
	if (process.argv.includes("--list"))
		for (const [name, vs] of [
			["regressions", r.regressions],
			["old gaps", r.oldGaps],
			["false prompts", r.falsePrompts],
		] as const) {
			console.log(`\n${name}:`);
			for (const v of vs) console.log(`  [${v.row.cwd}] ${JSON.stringify(v.row.cmd)}  # ${v.row.source}`);
		}
	process.exitCode = r.regressions.length ? 1 : 0;
}
