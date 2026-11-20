/** The A/B eval's pure parts: the task file, the per-arm contract, and the facts read from a session log. */
import { isAbsolute } from "node:path";
import type { Coordinator } from "./sandbox.ts";

export type Arm = "A" | "B";
export const ARMS: readonly Arm[] = ["A", "B"];

export interface Task {
	id: string;
	/** Absolute path of the target git repository; it is cloned, never modified. */
	repo: string;
	/** Commit the worktree starts from and the review point. */
	base: string;
	branch: string;
	/** Absolute path of the brief file. */
	brief: string;
	/** The exact check command, run in the worktree. */
	check: string;
	/** Commands run in the worktree before the coordinator starts. */
	setup: string[];
	coordinator: Coordinator;
	/** A delegate.json object, version 3. */
	pool: { version: 3 } & Record<string, unknown>;
	/** A known-good result SHA to diff against. */
	reference?: string;
	/** Free-form, copied into every record. */
	baseline?: Record<string, unknown>;
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Returns the task or throws one error that lists every problem found. */
export function validateTask(raw: unknown): Task {
	if (!isObject(raw)) throw new Error("task: must be a JSON object");
	const t = raw;
	const problems: string[] = [];
	for (const key of ["id", "repo", "base", "branch", "brief", "check"])
		if (!isString(t[key])) problems.push(`${key}: required string`);
	for (const key of ["repo", "brief"])
		if (isString(t[key]) && !isAbsolute(t[key] as string)) problems.push(`${key}: must be an absolute path`);
	if (!Array.isArray(t.setup) || !t.setup.every(isString)) problems.push("setup: required array of command strings");
	const c = t.coordinator;
	if (!isObject(c) || !isString(c.provider) || !isString(c.model) || !isString(c.thinking))
		problems.push("coordinator: required {provider, model, thinking}");
	if (!isObject(t.pool) || t.pool.version !== 3) problems.push("pool: required delegate.json object with version 3");
	if (t.reference !== undefined && !isString(t.reference)) problems.push("reference: must be a commit SHA string");
	if (t.baseline !== undefined && !isObject(t.baseline)) problems.push("baseline: must be an object");
	if (problems.length) throw new Error(`task: ${problems.join("; ")}`);
	return t as unknown as Task;
}

export interface ContractPaths {
	run: string;
	brief: string;
	worktree: string;
	report: string;
}

/** The skill each arm's coordinator runs. */
export const skillOf = (arm: Arm) => (arm === "A" ? "implement-me-pi" : "implement-direct");

/** Fills the contract template for one arm; throws when a placeholder is left unfilled. */
export function renderContract(template: string, task: Task, arm: Arm, paths: ContractPaths): string {
	const values: Record<string, string> = {
		TASK: task.id,
		RUN: paths.run,
		SKILL: skillOf(arm),
		BRIEF: paths.brief,
		WORKER_CLAUSE: arm === "A" ? " and your implement worker; give the worker that path" : "",
		WORKTREE: paths.worktree,
		BRANCH: task.branch,
		BASE: task.base,
		CHECK: task.check,
		REPORT: paths.report,
	};
	const out = template.replace(/\{\{(\w+)\}\}/g, (all, key: string) => values[key] ?? all);
	const left = out.match(/\{\{\w+\}\}/g);
	if (left) throw new Error(`contract: unfilled placeholders ${[...new Set(left)].join(", ")}`);
	return out;
}

/** The one prompt each coordinator gets. */
export const promptOf = (arm: Arm, contract: string) =>
	`/skill:${skillOf(arm)} Your contract is ${contract}; it answers every question of step 1.`;

/** The report's Status (DONE or BLOCKED), whether written as a heading or a `Status:` line. */
export function reportStatus(report: string): "DONE" | "BLOCKED" | "unknown" {
	const at = report.search(/^\W*Status\b/im);
	if (at < 0) return "unknown";
	const m = /\b(DONE|BLOCKED)\b/.exec(report.slice(at, at + 200));
	return (m?.[1] as "DONE" | "BLOCKED") ?? "unknown";
}

const BLOCKED = /^(BLOCKED\b|Blocked \(|Blocked by user\b|Tool execution was blocked)/;

/** Compaction entries, and tool results refused by guard or reporting BLOCKED. */
export function sessionFacts(jsonl: string): { compactions: number; blocked: number } {
	const facts = { compactions: 0, blocked: 0 };
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		const entry = JSON.parse(line);
		if (entry.type === "compaction") facts.compactions++;
		const m = entry.type === "message" ? entry.message : undefined;
		if (m?.role !== "toolResult") continue;
		const text = Array.isArray(m.content)
			? m.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("")
			: "";
		if (BLOCKED.test(text.trimStart())) facts.blocked++;
	}
	return facts;
}

/**
 * What the coordinator gets on top of the sandbox env. Pi runs under `env -i`, so no GitHub token is inherited.
 * OpenSSH reads `~/.ssh` from the passwd home, not `$HOME`, so git's ssh gets no config, no identity, and no prompt:
 * the agent cannot push with the user's keys.
 */
export const coordinatorEnv = (statusLog: string, capUsd: number): Record<string, string> => ({
	// Both arms run unattended: nobody answers a dialog, so guard refuses instead of waiting.
	ME_PI_UNATTENDED: "1",
	ME_PI_STATUS_LOG: statusLog,
	ME_PI_SPEND_BUDGET_USD: String(capUsd),
	GIT_SSH_COMMAND: "ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes",
	GIT_TERMINAL_PROMPT: "0",
});

export type AttemptState = "completed" | "capped" | "timeout" | "incomplete" | "void";

/**
 * The attempt's final state from how it ended and what it left: an account or infra stop from the status log wins,
 * then an arm-B attempt that used the implement worker (it ran arm A's method), then a completed run with no log.
 */
export function finalState(o: {
	arm: Arm;
	state: AttemptState;
	note: string;
	statusLog: string;
	hasLog: boolean;
	implementCalls: number;
}): { state: AttemptState; note: string } {
	if (/STOPPED: account/.test(o.statusLog)) return { state: "incomplete", note: "account" };
	if (/STOPPED: infra/.test(o.statusLog)) return { state: "void", note: "infra" };
	if (o.arm === "B" && o.implementCalls > 0) return { state: "void", note: "arm B used implement" };
	if (!o.hasLog && o.state === "completed") return { state: "incomplete", note: "no session log" };
	return { state: o.state, note: o.note };
}

/**
 * Median total cost over the records whose cost is fully known: completed, with a Pi estimate that has no pending
 * job. The rest are counted in `excluded`, not averaged in as $0.
 */
export function costMedian(records: { state: string; cost: { source: string; total: number } }[]): {
	median: number | undefined;
	excluded: number;
} {
	const known = records.filter((r) => r.state === "completed" && r.cost.source === "pi-estimate");
	return { median: median(known.map((r) => r.cost.total)), excluded: records.length - known.length };
}

export function median(xs: number[]): number | undefined {
	if (!xs.length) return undefined;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A watchdog tick further than this after the previous one means the machine slept in between. */
export const SUSPEND_GAP_MS = 60_000;

export interface ActiveClock {
	/** When the watchdog last ticked. */
	last: number;
	/** When the attempt times out, moved later by every suspension. */
	deadline: number;
	suspendedMs: number;
}

/**
 * Advances the attempt's clock to `now`, so the timeout counts active time only: a gap between ticks longer than
 * `SUSPEND_GAP_MS` (the machine slept, so timers did not fire) is counted as suspended and extends the deadline.
 */
export function tick(clock: ActiveClock, now: number): ActiveClock {
	const gap = now - clock.last;
	if (gap <= SUSPEND_GAP_MS) return { ...clock, last: now };
	return { last: now, deadline: clock.deadline + gap, suspendedMs: clock.suspendedMs + gap };
}

/** An implement worker's shutdown commit (`WIP(<role>): …`) holds unfinished work, not a delivery. */
export const isWipSubject = (subject: string) => subject.startsWith("WIP(");

/**
 * Delivered: the run completed, the report says DONE, the check passes in a fresh clone of HEAD, and HEAD is not a WIP
 * commit. A green check alone is not delivery: a WIP commit or a BLOCKED report can still pass it.
 */
export function isAccepted(r: {
	state: string;
	report: { status: string | null };
	checkFresh: { exit: number | null };
	headIsWip: boolean;
}): boolean {
	return r.state === "completed" && r.report.status === "DONE" && r.checkFresh.exit === 0 && !r.headIsWip;
}

/** States a resumed sweep keeps; a `timeout` or `incomplete` attempt is run again. */
const SETTLED: readonly AttemptState[] = ["completed", "capped", "void"];
const keyOf = (task: string, arm: string, n: number) => `${task}\0${arm}\0${n}`;

export interface QueuedAttempt {
	task: string;
	arm: Arm;
	n: number;
}

/**
 * The attempts to run, interleaved (for each n, each task, each arm) so provider drift during the sweep hits each arm
 * and task alike, less those `done` already holds a settled record for.
 */
export function attemptQueue(
	tasks: string[],
	arms: readonly Arm[],
	runs: number,
	done: { task: string; arm: string; n: number; state: string }[] = [],
): QueuedAttempt[] {
	const settled = new Set(
		done.filter((r) => SETTLED.includes(r.state as AttemptState)).map((r) => keyOf(r.task, r.arm, r.n)),
	);
	const queue: QueuedAttempt[] = [];
	for (let n = 1; n <= runs; n++)
		for (const task of tasks)
			for (const arm of arms) if (!settled.has(keyOf(task, arm, n))) queue.push({ task, arm, n });
	return queue;
}

/** What the summary reads from a record. */
export interface SummaryRecord {
	task: string;
	arm: string;
	n: number;
	state: string;
	accepted?: boolean;
	wallMs: number;
	compactions: number | null;
	checkFresh: { exit: number | null; timedOut: boolean };
	cost: { source: string; total: number };
}

const fmt = (x: number | undefined, f: (v: number) => string) => (x === undefined ? "–" : f(x));

/**
 * The summary table: one row per task and arm, then a total per arm. Only the last record of each (task, arm, n)
 * counts, so a resumed attempt replaces the timed-out one before it. Records of other tasks or arms are left out.
 */
export function summaryTable(records: SummaryRecord[], tasks: string[], arms: readonly Arm[]): string[] {
	const latest = new Map<string, SummaryRecord>();
	for (const r of records) if (tasks.includes(r.task)) latest.set(keyOf(r.task, r.arm, r.n), r);
	const kept = [...latest.values()];
	const row = (task: string, arm: string, r: SummaryRecord[]) => {
		const green = r.filter((x) => x.checkFresh.exit === 0 && !x.checkFresh.timedOut).length;
		const cost = costMedian(r);
		return `| ${task} | ${arm} | ${r.length} | ${r.filter((x) => x.state === "completed").length} | ${green} | ${
			r.filter((x) => x.accepted === true).length
		} | ${fmt(cost.median, (v) => `$${v.toFixed(2)}`)} (${cost.excluded} excluded) | ${fmt(
			median(r.map((x) => x.wallMs)),
			(v) => `${(v / 60_000).toFixed(1)} min`,
		)} | ${fmt(median(r.filter((x) => x.compactions !== null).map((x) => x.compactions as number)), String)} |`;
	};
	const lines = [
		"| task | arm | attempts | completed | check green (fresh clone) | accepted | median cost (n excluded) | median wall | median compactions |",
		"|---|---|---|---|---|---|---|---|---|",
	];
	for (const task of tasks)
		for (const arm of arms)
			lines.push(
				row(
					task,
					arm,
					kept.filter((x) => x.task === task && x.arm === arm),
				),
			);
	if (tasks.length > 1)
		for (const arm of arms)
			lines.push(
				row(
					"total",
					arm,
					kept.filter((x) => x.arm === arm),
				),
			);
	return lines;
}
