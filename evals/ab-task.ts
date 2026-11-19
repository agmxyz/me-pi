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

export function median(xs: number[]): number | undefined {
	if (!xs.length) return undefined;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
