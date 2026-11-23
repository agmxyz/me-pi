/**
 * Policy tasks: a small fixture repo, a prompt, and a scorer the model never sees. Where a routing scenario is scored
 * from the session log, a task is scored from the work directory and the final reply by its own `score.mjs`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Verdict } from "./score.ts";

export const TASKS = join(dirname(new URL(import.meta.url).pathname), "tasks");

export interface TaskVerdict extends Verdict {
	/** A count the scorer printed as `metric=<n>` (words, caveat sentences). */
	metric?: number;
}

export const taskPrompt = (dir: string) => readFileSync(join(dir, "prompt.txt"), "utf8").trim();
export const taskFixture = (dir: string) => join(dir, "fixture");
export const taskScorer = (dir: string) => readFileSync(join(dir, "score.mjs"), "utf8");

/**
 * Runs `node score.mjs <run-dir> <work-dir>`, where `<run-dir>/answer.txt` holds the reply. Exit 0 is a pass; exit 1
 * with nothing on stderr is a fail. Anything else is `unknown`, never a fail: a scorer error, a timeout, a signal, and
 * exit 1 with stderr output, which is how Node reports a scorer that crashed. The scorer runs hidden tests, so it
 * executes code the model wrote: give it the sandbox's `env` and a `tmp` inside the sandbox.
 */
export function scoreTask(
	dir: string,
	work: string,
	reply: string,
	tmp: string,
	env: Record<string, string>,
): TaskVerdict {
	const runDir = mkdtempSync(join(tmp, "task-run-"));
	writeFileSync(join(runDir, "answer.txt"), reply);
	const r = spawnSync(process.execPath, [join(dir, "score.mjs"), runDir, work], {
		env,
		encoding: "utf8",
		timeout: 180_000,
	});
	const crashed = r.status === 1 && (r.stderr ?? "").trim() !== "";
	const said = (crashed ? r.stderr : `${r.stdout ?? ""}${r.stderr ?? ""}`).trim().split("\n");
	const line = (crashed ? said.find((l) => /Error/.test(l)) : said[0]) ?? said[0];
	const evidence = `${crashed ? "scorer crashed: " : ""}${line?.slice(0, 200) || r.error?.message || `scorer exit ${r.status ?? r.signal}`}`;
	const metric = /^metric=(-?[\d.]+)$/m.exec(r.stdout ?? "")?.[1];
	return {
		id: "task scorer",
		result: r.status === 0 ? "pass" : r.status === 1 && !crashed ? "fail" : "unknown",
		evidence,
		...(metric === undefined ? {} : { metric: Number(metric) }),
	};
}
