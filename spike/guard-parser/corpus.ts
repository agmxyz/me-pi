/**
 * Builds the corpus: every command string passed to classify/workerRisk/gitTreeWrite by `test/guard.test.ts` on this
 * checkout and on the remote branches `fix/guard-temp-rm` and `fix/guard-command-positions`, plus the hand-written
 * rows in rows.ts. Each test file runs against main's guard.ts with a recording stand-in, so its commands are taken
 * from the values the tests compute, not scraped from source text.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROWS, type Row } from "./rows.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const cache = join(here, ".cache");
mkdirSync(cache, { recursive: true });

export interface CorpusRow extends Row {
	/** The TMPDIR the row runs under; undefined is the harness default, "" is unset. */
	tmpdir?: string;
}

function testFile(ref: string | undefined): string {
	if (!ref) return readFileSync(join(root, "test/guard.test.ts"), "utf8");
	const res = spawnSync("git", ["-C", root, "show", `${ref}:test/guard.test.ts`], { encoding: "utf8" });
	if (res.status !== 0) throw new Error(`git show ${ref}: ${res.stderr}`);
	return res.stdout;
}

function recordFrom(label: string, ref: string | undefined): CorpusRow[] {
	const name = label.replace(/\W+/g, "_");
	const src = testFile(ref)
		.replace('from "node:assert/strict"', `from ${JSON.stringify(join(here, "assert-shim.ts"))}`)
		.replace('from "node:test"', `from ${JSON.stringify(join(here, "test-shim.ts"))}`)
		.replace(
			'import("../packages/pi-workers/extensions/guard.ts")',
			`import(${JSON.stringify(join(here, "record.ts"))})`,
		);
	if (src.includes("../packages/pi-workers/extensions/guard.ts"))
		throw new Error(`${label}: guard import not rewritten`);
	const file = join(cache, `${name}.test.ts`);
	const out = join(cache, `${name}.json`);
	writeFileSync(file, src);
	const res = spawnSync(process.execPath, [file], { encoding: "utf8", env: { ...process.env, RECORD_OUT: out } });
	if (res.status !== 0) throw new Error(`${label}: ${res.stderr}`);
	const recorded: { fn: string; command: string; branch?: string; tmpdir: string | null }[] = JSON.parse(
		readFileSync(out, "utf8"),
	);
	if (recorded.length < 50) throw new Error(`${label}: only ${recorded.length} commands recorded`);
	return recorded.map((r) => ({
		source: `${label} (${r.fn})`,
		command: r.command,
		branch: r.branch,
		...(r.tmpdir !== null ? { tmpdir: r.tmpdir } : {}),
	}));
}

/** The whole corpus, one row per distinct (command, branch, tmpdir); sources of duplicates are merged. */
export function corpus(): CorpusRow[] {
	const all: CorpusRow[] = [
		...recordFrom("test/guard.test.ts", undefined),
		...recordFrom("fix/guard-temp-rm", "origin/fix/guard-temp-rm"),
		...recordFrom("fix/guard-command-positions", "origin/fix/guard-command-positions"),
		...ROWS,
	];
	const byKey = new Map<string, CorpusRow>();
	for (const row of all) {
		const key = JSON.stringify([row.command, row.branch ?? "feature/x", row.tmpdir ?? null]);
		const seen = byKey.get(key);
		if (!seen) byKey.set(key, { ...row, branch: row.branch ?? "feature/x" });
		else if (!seen.source.split("; ").includes(row.source)) seen.source += `; ${row.source}`;
	}
	return [...byKey.values()];
}
