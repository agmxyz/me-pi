/**
 * The batch-chief helper: `node batch.ts <command>`. One run's state lives in `events.jsonl` under
 * `<repo>.worktrees/.batch/<run-id>/` and is rebuilt from it on every command; this module owns the row states
 * and their transition table.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

export interface Result {
	code: number;
	stdout: string;
	stderr: string;
}

/** Every external effect goes through here: `git`, `gh`, `herdr` (code 127 when the tool is missing), and the clock. */
export interface Runner {
	exec(cmd: string, args: string[], options?: { cwd?: string }): Result;
	now(): Date;
}

type State = "QUEUED" | "RUNNING" | "ASKED" | "REPORTED" | "GATED" | "MERGED" | "LEFT_OPEN" | "DROPPED";
type Round = "implement" | "review" | "fix" | "update";
const TERMINAL: State[] = ["MERGED", "LEFT_OPEN", "DROPPED"];
const NOTE_KINDS = ["manual-fix", "chief-answer", "wrong-instruction", "gate-miss", "user-friction"];
const TOOLS = ["git", "gh", "herdr"];

interface Launch {
	worktree: string;
	branch: string;
	pane: string;
	session: string;
	brief: string;
	report: string;
}

interface Row {
	ticket: number;
	state: State;
	round?: Round;
	owner?: "chief" | "user";
	/** The gated head SHA while GATED. */
	sha?: string;
	deadline?: string;
	deadlineMinutes?: number;
	lastAt: string;
	launch?: Launch;
	chiefAnswers: number;
	/** A merge intent with no observed result yet. */
	intent?: { sha: string; at: string };
	commit?: string;
}

interface Event {
	at: string;
	type: string;
	ticket?: number;
	[key: string]: any;
}

interface Run {
	id: string;
	dir: string;
	preflight: Event;
	rows: Map<number, Row>;
	approvals: Event[];
	notes: Event[];
}

/** A command refused for a reason the chief can act on; exit code 1. */
class Refusal extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Transition table: the only place that decides which event a row accepts and what it becomes.

/** Row events in table order, with the states they leave from. */
const TABLE: { event: string; accepts: (row: Row) => boolean }[] = [
	{ event: "launch", accepts: (r) => r.state === "QUEUED" },
	{ event: "report", accepts: (r) => r.state === "RUNNING" },
	{
		event: "answer",
		accepts: (r) => r.state === "ASKED" && (r.owner === "user" || r.chiefAnswers === 0),
	},
	{ event: "escalate", accepts: (r) => r.state === "ASKED" && r.owner === "chief" },
	{ event: "gate", accepts: (r) => r.state === "REPORTED" },
	{ event: "round", accepts: (r) => r.state === "REPORTED" || r.state === "GATED" },
	{ event: "head-moved", accepts: (r) => r.state === "GATED" },
	{ event: "merge-intent", accepts: (r) => r.state === "GATED" },
	{ event: "merged", accepts: (r) => r.state === "GATED" },
	{ event: "leave-open", accepts: (r) => r.state === "GATED" },
	{ event: "drop", accepts: (r) => !TERMINAL.includes(r.state) },
];

/** Events another step records; `event` refuses them with this reason. */
const NOT_BY_EVENT: Record<string, string> = {
	gate: "the gate command records it when every fetched fact passes",
	"head-moved": "status records it when the PR head differs from the gated SHA",
	"merge-intent": "the merge command records it before merging",
	merged: "status records it when GitHub says the PR is merged",
};

function accepted(row: Row): string[] {
	return TABLE.filter((t) => t.accepts(row)).map((t) => t.event);
}

function label(row: Row): string {
	if (row.state === "RUNNING") return `RUNNING(${row.round})`;
	if (row.state === "ASKED") return `ASKED(${row.owner})`;
	if (row.state === "GATED") return `GATED(${row.sha})`;
	return row.state;
}

function next(row: Row): string {
	if (row.state === "RUNNING") return "coordinator";
	if (row.state === "ASKED") return row.owner!;
	if (row.state === "GATED") return "user, then chief";
	return TERMINAL.includes(row.state) ? "nobody" : "chief";
}

/** Throws a Refusal naming the row's state and the events it accepts when `type` is not one of them. */
function check(row: Row, type: string): void {
	if (accepted(row).includes(type)) return;
	const accepts = accepted(row).join(", ") || "nothing";
	if (type === "answer" && row.state === "ASKED" && row.owner === "chief")
		throw new Refusal(
			`#${row.ticket} already had a chief answer; the question goes to the user: event ${row.ticket} escalate (#${row.ticket} is ${label(row)}; it accepts: ${accepts})`,
		);
	throw new Refusal(`#${row.ticket} is ${label(row)}; it accepts: ${accepts}`);
}

function running(row: Row, round: Round, minutes: number, at: string): void {
	row.state = "RUNNING";
	row.round = round;
	row.owner = undefined;
	row.sha = undefined;
	row.intent = undefined;
	row.deadlineMinutes = minutes;
	row.deadline = new Date(Date.parse(at) + minutes * 60_000).toISOString();
}

/** Applies one checked row event. */
function apply(row: Row, e: Event): void {
	check(row, e.type);
	switch (e.type) {
		case "launch":
			row.launch = e.launch;
			running(row, "implement", e.deadline, e.at);
			break;
		case "report":
			if (e.status === "DONE") row.state = "REPORTED";
			else {
				row.state = "ASKED";
				row.owner = "chief";
			}
			row.deadline = undefined;
			break;
		case "answer":
			if (row.owner === "chief") row.chiefAnswers++;
			running(row, row.round!, e.deadline, e.at);
			break;
		case "escalate":
			row.owner = "user";
			break;
		case "gate":
			row.state = "GATED";
			row.sha = e.sha;
			break;
		case "round":
			running(row, e.round, e.deadline, e.at);
			break;
		case "head-moved":
			row.state = "REPORTED";
			row.sha = undefined;
			row.intent = undefined;
			break;
		case "merge-intent":
			row.intent = { sha: e.sha, at: e.at };
			break;
		case "merged":
			row.state = "MERGED";
			row.commit = e.commit;
			row.intent = undefined;
			break;
		case "leave-open":
			row.state = "LEFT_OPEN";
			break;
		case "drop":
			row.state = "DROPPED";
			row.deadline = undefined;
			break;
	}
	row.lastAt = e.at;
}

/** The commands status lists for a row; events another command records are left out. */
function allowedCommands(row: Row): string[] {
	const n = row.ticket;
	const usage: Record<string, string> = {
		launch: `event ${n} launch --worktree <path> --branch <name> --pane <id> --session <file> --brief <path> --report <path> --deadline <minutes>`,
		report: `event ${n} report --path ${row.launch?.report ?? "<report>"}`,
		answer:
			row.owner === "chief"
				? `event ${n} answer --basis "<quoted brief line>"`
				: `event ${n} answer --user "<user's words>"`,
		escalate: `event ${n} escalate`,
		round: `event ${n} round <review|fix|update> --deadline <minutes>`,
		"leave-open": `event ${n} leave-open`,
		drop: `event ${n} drop --user "<user's words>"`,
	};
	return accepted(row).flatMap((event) => (usage[event] ? [usage[event]] : []));
}

// ---------------------------------------------------------------------------------------------------------------
// The run directory.

function mainCheckout(runner: Runner, dir: string): string {
	const out = runner.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir });
	if (out.code !== 0) throw new Refusal(`${dir} is not in a git checkout: ${out.stderr.trim()}`);
	return dirname(out.stdout.trim());
}

const batchDir = (repo: string) => join(`${repo}.worktrees`, ".batch");

function readEvents(dir: string): Event[] {
	const path = join(dir, "events.jsonl");
	return readFileSync(path, "utf8")
		.split("\n")
		.flatMap((line, i) => {
			if (!line.trim()) return [];
			try {
				return [JSON.parse(line)];
			} catch (error) {
				throw new Error(`${path}:${i + 1} is not JSON: ${(error as Error).message}`);
			}
		});
}

/** Rebuilds the run from its events; an event the table refuses means the log was edited by hand. */
function rebuild(id: string, dir: string): Run {
	const [preflight, ...rest] = readEvents(dir);
	if (preflight?.type !== "preflight") throw new Error(`${dir}/events.jsonl does not start with a preflight event`);
	const run: Run = { id, dir, preflight, rows: new Map(), approvals: [], notes: [] };
	for (const ticket of preflight.tickets as number[])
		run.rows.set(ticket, { ticket, state: "QUEUED", lastAt: preflight.at, chiefAnswers: 0 });
	for (const e of rest) {
		try {
			fold(run, e);
		} catch (error) {
			throw new Error(
				`${dir}/events.jsonl holds an event the table refuses (${JSON.stringify(e)}): ${(error as Error).message}`,
			);
		}
	}
	return run;
}

function fold(run: Run, e: Event): void {
	if (e.type === "approve") run.approvals.push(e);
	else if (e.type === "note") run.notes.push(e);
	else apply(rowOf(run, e.ticket), e);
}

/** Checks `e` against the current state, then appends it: a refused event is never written. */
function record(run: Run, e: Event): void {
	fold(run, e);
	appendFileSync(join(run.dir, "events.jsonl"), `${JSON.stringify(e)}\n`);
}

function currentRun(runner: Runner, cwd: string): Run {
	const batch = batchDir(mainCheckout(runner, cwd));
	const pointer = join(batch, "current");
	if (!existsSync(pointer)) throw new Refusal(`no current run: ${pointer} is missing; run preflight first`);
	const id = readFileSync(pointer, "utf8").trim();
	return rebuild(id, join(batch, id));
}

function rowOf(run: Run, ticket: unknown): Row {
	const row = typeof ticket === "number" ? run.rows.get(ticket) : undefined;
	if (!row) throw new Refusal(`#${ticket} is not a row of run ${run.id}; rows: ${[...run.rows.keys()].join(", ")}`);
	return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Commands.

function ticketNumber(text: string | undefined, what: string): number {
	if (!text || !/^[1-9]\d*$/.test(text))
		throw new Refusal(`${what} must be a ticket number, got ${JSON.stringify(text)}`);
	return Number(text);
}

function ticketList(text: string | undefined, what: string): number[] {
	const tickets = (text ?? "").split(",").map((t) => ticketNumber(t.trim(), what));
	if (new Set(tickets).size !== tickets.length) throw new Refusal(`${what} names a ticket twice: ${text}`);
	return tickets;
}

function required(values: Record<string, unknown>, name: string): string {
	const value = values[name];
	if (typeof value !== "string" || !value.trim()) throw new Refusal(`--${name} is required`);
	return value;
}

function minutes(values: Record<string, unknown>, fallback?: number): number {
	if (values.deadline === undefined && fallback !== undefined) return fallback;
	const text = required(values, "deadline");
	if (!/^[1-9]\d*$/.test(text)) throw new Refusal(`--deadline must be whole minutes, got ${JSON.stringify(text)}`);
	return Number(text);
}

function parse(argv: string[], options: Record<string, "string" | "boolean">) {
	try {
		return parseArgs({
			args: argv,
			allowPositionals: true,
			strict: true,
			options: Object.fromEntries(Object.entries(options).map(([name, type]) => [name, { type }])),
		});
	} catch (error) {
		throw new Refusal((error as Error).message);
	}
}

interface Rules {
	requiredChecks: string[];
	upToDate: boolean;
	/** Null when no rule restricts the merge method. */
	mergeMethods: string[] | null;
}

function parseRules(json: string): Rules {
	const rules = JSON.parse(json);
	if (!Array.isArray(rules)) throw new Error("the rules response is not a list");
	const result: Rules = { requiredChecks: [], upToDate: false, mergeMethods: null };
	for (const rule of rules) {
		const p = rule?.parameters ?? {};
		if (rule?.type === "required_status_checks") {
			result.requiredChecks.push(...(p.required_status_checks ?? []).map((c: any) => c.context));
			result.upToDate ||= p.strict_required_status_checks_policy === true;
		} else if (rule?.type === "pull_request" && Array.isArray(p.allowed_merge_methods)) {
			result.mergeMethods = p.allowed_merge_methods;
		}
	}
	return result;
}

function preflight(argv: string[], runner: Runner, cwd: string): string {
	const { values } = parse(argv, { repo: "string", tickets: "string", check: "string", "chief-pane": "string" });
	const repo = mainCheckout(runner, resolve(cwd, required(values, "repo")));
	const tickets = ticketList(required(values, "tickets"), "--tickets");
	const git = (...args: string[]) => {
		const out = runner.exec("git", args, { cwd: repo });
		if (out.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${repo}: ${out.stderr.trim()}`);
		return out.stdout.trim();
	};
	const base = git("rev-parse", "--abbrev-ref", "HEAD");
	if (base === "HEAD") throw new Refusal(`${repo} is on a detached HEAD; check out the base branch first`);
	const dirty = git("status", "--porcelain");
	if (dirty) throw new Refusal(`the main checkout ${repo} is not clean:\n${dirty}`);
	const batch = batchDir(repo);
	const pointer = join(batch, "current");
	if (existsSync(pointer)) {
		const id = readFileSync(pointer, "utf8").trim();
		const open = [...rebuild(id, join(batch, id)).rows.values()].filter((r) => !TERMINAL.includes(r.state));
		if (open.length)
			throw new Refusal(
				`run ${id} still has rows that are not terminal: ${open.map((r) => `#${r.ticket}`).join(", ")}`,
			);
	}
	const now = runner.now();
	const id = now.toISOString().replace(/[:.]/g, "-");
	const dir = join(batch, id);
	if (existsSync(dir)) throw new Refusal(`run directory ${dir} already exists`);
	const tools = Object.fromEntries(
		TOOLS.map((tool) => [tool, runner.exec(tool, ["--version"], { cwd: repo }).code !== 127]),
	);
	const rulesRead = runner.exec("gh", ["api", `repos/{owner}/{repo}/rules/branches/${base}`], { cwd: repo });
	let rules: Rules | "unknown" = "unknown";
	let rulesError: string | undefined;
	if (rulesRead.code !== 0) rulesError = rulesRead.stderr.trim() || `gh exited ${rulesRead.code}`;
	else {
		try {
			rules = parseRules(rulesRead.stdout);
		} catch (error) {
			rulesError = `unreadable rules response: ${(error as Error).message}`;
		}
	}
	const event: Event = {
		at: now.toISOString(),
		type: "preflight",
		repo,
		base,
		sha: git("rev-parse", "HEAD"),
		clean: true,
		tools,
		rules,
		...(rulesError ? { rulesError } : {}),
		check: required(values, "check"),
		chiefPane: required(values, "chief-pane"),
		tickets,
	};
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`);
	writeFileSync(pointer, `${id}\n`);
	const missing = TOOLS.filter((tool) => !tools[tool]);
	return [
		`run ${id} created in ${dir}`,
		`base ${base} at ${event.sha}; rules: ${rulesText(event)}`,
		...(missing.length ? [`missing tools: ${missing.join(", ")}`] : []),
		`rows QUEUED: ${tickets.map((t) => `#${t}`).join(", ")}`,
	].join("\n");
}

/** Reads a report's `Status` line (`Status: DONE` or a `Status` heading followed by its value). */
function reportStatus(path: string): "DONE" | "BLOCKED" | undefined {
	const lines = readFileSync(path, "utf8").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = /^(?:#+\s*)?\**Status\**\s*:?\s*(.*)$/i.exec(lines[i].trim());
		if (!match) continue;
		const value = match[1].trim() || (lines.slice(i + 1).find((l) => l.trim()) ?? "").trim();
		return /^\**(DONE|BLOCKED)\b/.exec(value)?.[1] as "DONE" | "BLOCKED" | undefined;
	}
	return undefined;
}

function reportEvent(at: string, ticket: number, path: string, source: "event" | "status"): Event {
	if (!existsSync(path)) throw new Refusal(`report ${path} does not exist`);
	const status = reportStatus(path);
	if (!status) throw new Refusal(`report ${path} has no Status line saying DONE or BLOCKED`);
	return { at, type: "report", ticket, path, status, source };
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

function event(argv: string[], runner: Runner, cwd: string): string {
	const [n, type, ...rest] = argv;
	const run = currentRun(runner, cwd);
	const row = rowOf(run, ticketNumber(n, "the row"));
	if (!type)
		throw new Refusal(
			`name an event; #${row.ticket} is ${label(row)}; it accepts: ${accepted(row).join(", ") || "nothing"}`,
		);
	if (NOT_BY_EVENT[type]) throw new Refusal(`${type} is not recorded through event: ${NOT_BY_EVENT[type]}`);
	if (!TABLE.some((t) => t.event === type))
		throw new Refusal(
			`unknown event ${type}; events: ${TABLE.map((t) => t.event)
				.filter((e) => !NOT_BY_EVENT[e])
				.join(", ")}`,
		);
	check(row, type);
	const at = runner.now().toISOString();
	const base = { at, type, ticket: row.ticket };
	let e: Event;
	switch (type) {
		case "launch": {
			const { values } = parse(rest, {
				worktree: "string",
				branch: "string",
				pane: "string",
				session: "string",
				brief: "string",
				report: "string",
				deadline: "string",
			});
			const path = (name: string) => resolve(cwd, required(values, name));
			const launch: Launch = {
				worktree: path("worktree"),
				branch: required(values, "branch"),
				pane: required(values, "pane"),
				session: path("session"),
				brief: path("brief"),
				report: path("report"),
			};
			if (!existsSync(launch.brief)) throw new Refusal(`brief ${launch.brief} does not exist`);
			e = { ...base, launch, deadline: minutes(values) };
			break;
		}
		case "report": {
			const { values } = parse(rest, { path: "string" });
			e = reportEvent(at, row.ticket, resolve(cwd, required(values, "path")), "event");
			break;
		}
		case "answer": {
			const { values } = parse(rest, { basis: "string", user: "string", deadline: "string" });
			const deadline = minutes(values, row.deadlineMinutes);
			if (row.owner === "chief") {
				if (values.user !== undefined)
					throw new Refusal(`#${row.ticket} is ASKED(chief); escalate before a user answer`);
				const basis = required(values, "basis");
				const brief = readFileSync(row.launch!.brief, "utf8");
				if (!normalise(brief).includes(normalise(basis)))
					throw new Refusal(
						`--basis is not in the brief ${row.launch!.brief}; quote the line that decides it, or escalate`,
					);
				e = { ...base, basis, deadline };
			} else {
				if (values.basis !== undefined) throw new Refusal(`#${row.ticket} is ASKED(user); only --user answers it`);
				e = { ...base, user: required(values, "user"), deadline };
			}
			break;
		}
		case "round": {
			const { values, positionals } = parse(rest, { deadline: "string" });
			const round = positionals[0];
			if (positionals.length !== 1 || !["review", "fix", "update"].includes(round))
				throw new Refusal(`round takes one of review, fix, update; got ${JSON.stringify(positionals.join(" "))}`);
			e = { ...base, round, deadline: minutes(values) };
			break;
		}
		case "drop": {
			const { values } = parse(rest, { user: "string" });
			e = { ...base, user: required(values, "user") };
			break;
		}
		default:
			parse(rest, {});
			e = base;
	}
	record(run, e);
	return `#${row.ticket} is ${label(row)}`;
}

function approve(argv: string[], runner: Runner, cwd: string): string {
	const { values } = parse(argv, { quote: "string", action: "string", tickets: "string", inferred: "boolean" });
	const run = currentRun(runner, cwd);
	const action = required(values, "action");
	if (!/^[a-z][a-z-]*$/.test(action))
		throw new Refusal(`--action must be a word such as merge, got ${JSON.stringify(action)}`);
	const tickets = ticketList(required(values, "tickets"), "--tickets");
	for (const ticket of tickets) rowOf(run, ticket);
	const e: Event = {
		at: runner.now().toISOString(),
		type: "approve",
		quote: required(values, "quote"),
		action,
		tickets,
		inferred: values.inferred === true,
	};
	record(run, e);
	return `approval recorded: ${action} ${tickets.map((t) => `#${t}`).join(", ")}${e.inferred ? " (inferred: confirm with the user before acting)" : ""}`;
}

function note(argv: string[], runner: Runner, cwd: string): string {
	const { values, positionals } = parse(argv, { kind: "string", ticket: "string" });
	const run = currentRun(runner, cwd);
	const kind = required(values, "kind");
	if (!NOTE_KINDS.includes(kind)) throw new Refusal(`--kind must be one of ${NOTE_KINDS.join(", ")}`);
	const ticket = rowOf(run, ticketNumber(required(values, "ticket"), "--ticket")).ticket;
	const text = positionals.join(" ").trim();
	if (!text) throw new Refusal(`note needs the text of what happened`);
	record(run, { at: runner.now().toISOString(), type: "note", kind, ticket, text });
	return `note recorded: ${kind} #${ticket}`;
}

/** Reconciles one row with the outside, which wins, and returns the lines to show under it. */
function reconcile(run: Run, row: Row, runner: Runner): string[] {
	const lines: string[] = [];
	const at = () => runner.now().toISOString();
	const report = row.launch?.report;
	if (row.state === "RUNNING" && report && existsSync(report) && statSync(report).mtimeMs > Date.parse(row.lastAt)) {
		try {
			record(run, reportEvent(at(), row.ticket, report, "status"));
		} catch (error) {
			if (!(error instanceof Refusal)) throw error;
			lines.push(`report newer than the last event, not recorded: ${error.message}`);
		}
	}
	if (row.launch && !TERMINAL.includes(row.state)) {
		const view = runner.exec(
			"gh",
			["pr", "view", row.launch.branch, "--json", "number,state,headRefOid,mergeCommit,url"],
			{ cwd: run.preflight.repo },
		);
		if (view.code !== 0) {
			if (!/no pull requests found/.test(view.stderr)) lines.push(`pr: unknown (${view.stderr.trim()})`);
		} else {
			const pr = JSON.parse(view.stdout);
			lines.push(`pr: #${pr.number} ${pr.state} head ${pr.headRefOid}${pr.url ? ` ${pr.url}` : ""}`);
			if (row.state === "GATED" && pr.state === "MERGED")
				record(run, { at: at(), type: "merged", ticket: row.ticket, commit: pr.mergeCommit?.oid ?? null });
			else if (row.state === "GATED" && pr.headRefOid !== row.sha)
				record(run, { at: at(), type: "head-moved", ticket: row.ticket, head: pr.headRefOid });
			else if (pr.state !== "OPEN" && row.state !== "GATED")
				lines.push(
					`PR is ${pr.state} on GitHub while the row is ${label(row)}; ask the user and record the outcome`,
				);
		}
	}
	if (row.intent) lines.push(`merge intent at ${row.intent.sha} pending since ${row.intent.at}: the PR is not merged`);
	return lines;
}

function rulesText(preflight: Event): string {
	const rules = preflight.rules;
	if (rules === "unknown") return `unknown (${preflight.rulesError})`;
	return [
		`required checks ${rules.requiredChecks.join(", ") || "none"}`,
		`up to date ${rules.upToDate ? "required" : "not required"}`,
		`merge methods ${rules.mergeMethods?.join(", ") ?? "not restricted by rules"}`,
	].join("; ");
}

function deadlineText(row: Row, now: Date): string {
	if (!row.deadline) return "";
	return `${row.deadline}${now.getTime() > Date.parse(row.deadline) ? " OVERDUE" : ""}`;
}

function status(argv: string[], runner: Runner, cwd: string): string {
	parse(argv, {});
	const run = currentRun(runner, cwd);
	const details = new Map<number, string[]>();
	for (const row of run.rows.values()) details.set(row.ticket, reconcile(run, row, runner));
	const now = runner.now();
	const p = run.preflight;
	const out = [`run ${run.id}: base ${p.base} at ${p.sha}; rules: ${rulesText(p)}`];
	for (const row of run.rows.values()) {
		const deadline = deadlineText(row, now);
		out.push(`#${row.ticket} ${label(row)} next: ${next(row)}${deadline ? `, deadline ${deadline}` : ""}`);
		for (const command of allowedCommands(row)) out.push(`  allowed: ${command}`);
		for (const line of details.get(row.ticket)!) out.push(`  ${line}`);
	}
	const ledger = join(run.dir, "ledger.md");
	writeFileSync(ledger, renderLedger(run, details, now));
	out.push(`ledger: ${ledger}`);
	return out.join("\n");
}

function renderLedger(run: Run, details: Map<number, string[]>, now: Date): string {
	const p = run.preflight;
	const cell = (text: string) => text.replace(/\|/g, "\\|");
	const lines = [
		`<!-- Generated by batch.ts status from events.jsonl at ${now.toISOString()}; edits here are overwritten. -->`,
		`# Batch run ${run.id}`,
		"",
		`- Repo: \`${p.repo}\`, base \`${p.base}\` at \`${p.sha}\`, main checkout clean at preflight`,
		`- Check: \`${p.check}\``,
		`- Chief pane: \`${p.chiefPane}\``,
		`- Tools: ${TOOLS.map((t) => `${t} ${p.tools[t] ? "found" : "missing"}`).join(", ")}`,
		`- Base rules: ${rulesText(p)}`,
		"",
		"| Row | State | Next | Deadline | Branch | Last event | Notes |",
		"| --- | --- | --- | --- | --- | --- | --- |",
		...[...run.rows.values()].map(
			(r) =>
				`| #${r.ticket} | ${label(r)} | ${next(r)} | ${deadlineText(r, now)} | ${r.launch?.branch ?? ""} | ${r.lastAt} | ${cell(details.get(r.ticket)!.join("; "))} |`,
		),
		"",
		"## Approvals",
		"",
		...(run.approvals.length
			? run.approvals.map(
					(a) =>
						`- ${a.at} ${a.action} ${a.tickets.map((t: number) => `#${t}`).join(", ")}: ${JSON.stringify(a.quote)}${a.inferred ? " (inferred)" : ""}`,
				)
			: ["- none"]),
		"",
		"## Notes",
		"",
		...(run.notes.length ? run.notes.map((n) => `- ${n.kind} #${n.ticket}: ${n.text}`) : ["- none"]),
		"",
	];
	return lines.join("\n");
}

const COMMANDS: Record<string, (argv: string[], runner: Runner, cwd: string) => string> = {
	preflight,
	event,
	approve,
	note,
	status,
};

/** Runs one helper command; exit code 1 is a refusal the chief can act on, 2 an unexpected failure. */
export function main(argv: string[], runner: Runner, cwd: string): { code: number; out: string } {
	const [command, ...rest] = argv;
	const handler = command ? COMMANDS[command] : undefined;
	if (!handler) return { code: 1, out: `usage: batch.ts <${Object.keys(COMMANDS).join("|")}> [options]` };
	try {
		return { code: 0, out: handler(rest, runner, cwd) };
	} catch (error) {
		if (error instanceof Refusal) return { code: 1, out: `refused: ${error.message}` };
		return { code: 2, out: `error: ${(error as Error).message}` };
	}
}

const systemRunner: Runner = {
	now: () => new Date(),
	exec(cmd, args, options) {
		const result = spawnSync(cmd, args, { cwd: options?.cwd, encoding: "utf8" });
		if (result.error) {
			const missing = (result.error as NodeJS.ErrnoException).code === "ENOENT";
			return { code: missing ? 127 : 1, stdout: "", stderr: result.error.message };
		}
		return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
	},
};

if (import.meta.main) {
	const result = main(process.argv.slice(2), systemRunner, process.cwd());
	process.stdout.write(`${result.out}\n`);
	process.exitCode = result.code;
}
