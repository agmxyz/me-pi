/** The A/B eval's parts that need no Pi: the task file, the per-arm contract, scoring, and the facts read from a session log. */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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
	/** The one coordinator, with `pool`; or absent when `coordinators` is given. */
	coordinator?: Coordinator;
	/** A delegate.json object, version 3. With `coordinators`, the base each coordinator's pool is derived from. */
	pool?: Pool;
	/** A coordinator matrix: each attempt runs one, with a pool whose scout and worker use the same model. */
	coordinators?: Coordinator[];
	/** Set for a synthetic task: its directory, and how its outcome is scored. */
	synth?: Synth;
	/** A known-good result SHA to diff against. */
	reference?: string;
	/** Free-form, copied into every record. */
	baseline?: Record<string, unknown>;
}

export type Pool = { version: 3 } & Record<string, unknown>;

export interface Synth {
	/** Absolute path of `evals/synth/tasks/<id>`: brief.md, meta.json, hidden/, optional base/, reference/. */
	dir: string;
	expect: "done" | "blocked";
	blockedKeywords: string[];
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
	const isCoordinator = (c: unknown) =>
		isObject(c) && isString(c.provider) && isString(c.model) && isString(c.thinking);
	if (t.coordinators === undefined) {
		if (!isCoordinator(t.coordinator)) problems.push("coordinator: required {provider, model, thinking}");
		if (!isObject(t.pool) || t.pool.version !== 3)
			problems.push("pool: required delegate.json object with version 3");
	} else {
		const cs = t.coordinators;
		if (!Array.isArray(cs) || !cs.length || !cs.every(isCoordinator))
			problems.push("coordinators: must be a non-empty array of {provider, model, thinking}");
		else if (new Set(cs.map(coordinatorLabel)).size !== cs.length) problems.push("coordinators: given twice");
		if (t.coordinator !== undefined) problems.push("coordinator: give coordinator or coordinators, not both");
		if (t.pool !== undefined && (!isObject(t.pool) || t.pool.version !== 3))
			problems.push("pool: must be a delegate.json object with version 3");
	}
	if (t.reference !== undefined && !isString(t.reference)) problems.push("reference: must be a commit SHA string");
	if (t.baseline !== undefined && !isObject(t.baseline)) problems.push("baseline: must be an object");
	if (problems.length) throw new Error(`task: ${problems.join("; ")}`);
	return t as unknown as Task;
}

/** Names a coordinator in records, the queue, and the summary: `provider/model@thinking`. */
export const coordinatorLabel = (c: Coordinator) => `${c.provider}/${c.model}@${c.thinking}`;

/** A coordinator's pool: `base` with scout and worker both on the coordinator's own model and thinking. */
export function poolFor(base: Pool, c: Coordinator): Pool {
	const model = `${c.provider}/${c.model}`;
	// delegate accepts only `low` or `off` for scout; `low` keeps it on the same model as the coordinator.
	return {
		...base,
		scout: { models: [{ model, thinking: "low" }] },
		worker: { models: [{ model, thinking: c.thinking }] },
	};
}

/** Each coordinator a task runs with, and its pool; `basePool` is used when the task has `coordinators` but no `pool`. */
export function seatsOf(task: Task, basePool: Pool): { coordinator: Coordinator; pool: Pool }[] {
	if (!task.coordinators) return [{ coordinator: task.coordinator!, pool: task.pool! }];
	return task.coordinators.map((coordinator) => ({ coordinator, pool: poolFor(task.pool ?? basePool, coordinator) }));
}

/**
 * Turns a task-file entry into a task: a synthetic entry (`kind: "synth"`, with `dir` and `fixture`, resolved against
 * `fileDir`) gets its target from `build(fixture, overlay)` (the fixture plus the task's `base/`, if any), its brief from
 * `<dir>/brief.md`, its branch `task/<id>`, and its scoring from `<dir>/meta.json`. Any other entry is a git task.
 */
export function loadTask(
	raw: unknown,
	fileDir: string,
	build: (fixture: string, overlay: string | undefined) => { repo: string; base: string },
): Task {
	if (!isObject(raw) || raw.kind !== "synth") return validateTask(raw);
	const { kind: _, dir: rawDir, fixture: rawFixture, ...rest } = raw;
	if (!isString(rest.id) || !isString(rawDir) || !isString(rawFixture))
		throw new Error("task: a synth task needs id, dir, and fixture strings");
	const dir = resolve(fileDir, rawDir);
	const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
	if (meta.expect !== "done" && meta.expect !== "blocked")
		throw new Error(`task ${rest.id}: meta.json expect must be "done" or "blocked"`);
	const blockedKeywords: unknown = meta.blockedKeywords ?? [];
	if (!Array.isArray(blockedKeywords) || !blockedKeywords.every(isString))
		throw new Error(`task ${rest.id}: meta.json blockedKeywords must be an array of strings`);
	if (meta.expect === "blocked" && !blockedKeywords.length)
		throw new Error(`task ${rest.id}: an expect "blocked" task needs blockedKeywords`);
	const overlay = join(dir, "base");
	const target = build(resolve(fileDir, rawFixture), existsSync(overlay) ? overlay : undefined);
	return validateTask({
		...rest,
		...target,
		branch: `task/${rest.id}`,
		brief: join(dir, "brief.md"),
		synth: { dir, expect: meta.expect, blockedKeywords },
	});
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
 * OpenSSH reads `~/.ssh` from the passwd home, not `$HOME`, so git refuses the ssh transport outright through
 * `protocol.ssh.allow=never` and cannot prompt: the agent cannot push with the user's keys. A `GIT_SSH_COMMAND` would
 * do the same but leaks into the target's own tests (piops asserts it is unset for local clones), failing their check.
 */
export const coordinatorEnv = (statusLog: string, capUsd: number): Record<string, string> => ({
	// Both arms run unattended: nobody answers a dialog, so guard refuses instead of waiting.
	ME_PI_UNATTENDED: "1",
	ME_PI_STATUS_LOG: statusLog,
	ME_PI_SPEND_BUDGET_USD: String(capUsd),
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: "protocol.ssh.allow",
	GIT_CONFIG_VALUE_0: "never",
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

/**
 * A synthetic task's pass. `done`: accepted and every hidden test green. `blocked`: the report's Status is BLOCKED,
 * its text names the ambiguity (one of `blockedKeywords`, any case), and nothing under `src` changed.
 */
export function isPass(
	synth: Synth,
	r: { accepted: boolean; hidden: { exit: number | null }; reportText: string; srcChanged: string[] },
): boolean {
	if (synth.expect === "done") return r.accepted && r.hidden.exit === 0;
	const text = r.reportText.toLowerCase();
	return (
		reportStatus(r.reportText) === "BLOCKED" &&
		synth.blockedKeywords.some((k) => text.includes(k.toLowerCase())) &&
		r.srcChanged.length === 0
	);
}

/** States a resumed sweep keeps; a `timeout` or `incomplete` attempt is run again. */
const SETTLED: readonly AttemptState[] = ["completed", "capped", "void"];
/** One attempt's identity: a resumed sweep and the summary key on it. */
const keyOf = (r: { task: string; coordinator: Coordinator; arm: string; n: number }) =>
	`${r.task}\0${coordinatorLabel(r.coordinator)}\0${r.arm}\0${r.n}`;

export interface QueuedAttempt {
	task: string;
	coordinator: Coordinator;
	arm: Arm;
	n: number;
}

/**
 * The attempts to run, interleaved (for each n, each coordinator, each task that has it, each arm) so provider drift
 * during the sweep hits each coordinator, task, and arm alike, less those `done` already holds a settled record for.
 */
export function attemptQueue(
	tasks: { id: string; coordinators: Coordinator[] }[],
	arms: readonly Arm[],
	runs: number,
	done: { task: string; coordinator: Coordinator; arm: string; n: number; state: string }[] = [],
): QueuedAttempt[] {
	const settled = new Set(done.filter((r) => SETTLED.includes(r.state as AttemptState)).map(keyOf));
	const coordinators = new Map(tasks.flatMap((t) => t.coordinators).map((c) => [coordinatorLabel(c), c]));
	const queue: QueuedAttempt[] = [];
	for (let n = 1; n <= runs; n++)
		for (const [label, coordinator] of coordinators)
			for (const task of tasks)
				if (task.coordinators.some((c) => coordinatorLabel(c) === label))
					for (const arm of arms) {
						const q = { task: task.id, coordinator, arm, n };
						if (!settled.has(keyOf(q))) queue.push(q);
					}
	return queue;
}

/** What the summary reads from a record. */
export interface SummaryRecord {
	task: string;
	coordinator: Coordinator;
	arm: string;
	n: number;
	state: string;
	accepted?: boolean;
	/** Synthetic tasks only. */
	pass?: boolean;
	wallMs: number;
	compactions: number | null;
	checkFresh: { exit: number | null; timedOut: boolean };
	cost: { source: string; total: number };
}

const fmt = (x: number | undefined, f: (v: number) => string) => (x === undefined ? "–" : f(x));

/**
 * The summary table: one row per coordinator, task, and arm; a total per coordinator and arm when there are several
 * tasks; and an overall total per arm when there are several coordinators. Only the last record of each (task,
 * coordinator, arm, n) counts, so a resumed attempt replaces the timed-out one before it. Records of other tasks,
 * coordinators, or arms are left out. `pass` shows `–` for a group with no synthetic record.
 */
export function summaryTable(
	records: SummaryRecord[],
	tasks: string[],
	coordinators: Coordinator[],
	arms: readonly Arm[],
): string[] {
	const labels = coordinators.map(coordinatorLabel);
	const latest = new Map<string, SummaryRecord>();
	for (const r of records)
		if (tasks.includes(r.task) && labels.includes(coordinatorLabel(r.coordinator))) latest.set(keyOf(r), r);
	const kept = [...latest.values()];
	const row = (coordinator: string, task: string, arm: string, r: SummaryRecord[]) => {
		const green = r.filter((x) => x.checkFresh.exit === 0 && !x.checkFresh.timedOut).length;
		const cost = costMedian(r);
		const scored = r.filter((x) => x.pass !== undefined);
		return `| ${coordinator} | ${task} | ${arm} | ${r.length} | ${r.filter((x) => x.state === "completed").length} | ${green} | ${
			r.filter((x) => x.accepted === true).length
		} | ${scored.length ? scored.filter((x) => x.pass).length : "–"} | ${fmt(cost.median, (v) => `$${v.toFixed(2)}`)} (${cost.excluded} excluded) | ${fmt(
			median(r.map((x) => x.wallMs)),
			(v) => `${(v / 60_000).toFixed(1)} min`,
		)} | ${fmt(median(r.filter((x) => x.compactions !== null).map((x) => x.compactions as number)), String)} |`;
	};
	const lines = [
		"| coordinator | task | arm | attempts | completed | check green (fresh clone) | accepted | pass | median cost (n excluded) | median wall | median compactions |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const label of labels) {
		const mine = kept.filter((x) => coordinatorLabel(x.coordinator) === label);
		for (const task of tasks)
			for (const arm of arms)
				lines.push(
					row(
						label,
						task,
						arm,
						mine.filter((x) => x.task === task && x.arm === arm),
					),
				);
		if (tasks.length > 1)
			for (const arm of arms)
				lines.push(
					row(
						label,
						"total",
						arm,
						mine.filter((x) => x.arm === arm),
					),
				);
	}
	if (labels.length > 1)
		for (const arm of arms)
			lines.push(
				row(
					"all",
					"total",
					arm,
					kept.filter((x) => x.arm === arm),
				),
			);
	return lines;
}
