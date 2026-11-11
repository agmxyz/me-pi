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
/** Coordinator rounds; the first is the one `launch` starts, the rest are what `round` reopens a row with. */
const ROUNDS = ["implement", "review", "fix", "update"] as const;
type Round = (typeof ROUNDS)[number];
const LATER_ROUNDS = ROUNDS.filter((r) => r !== "implement");
/** The events.jsonl format this helper writes and reads; a run with another version is refused. */
const VERSION = 1;
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

/** A row's id: a ticket number, or a label for work without an issue (see `rowId`). */
type RowId = number | string;

interface Row {
	ticket: RowId;
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
	commit?: string | null;
}

interface Rules {
	requiredChecks: string[];
	upToDate: boolean;
	/** Null when no rule restricts the merge method. */
	mergeMethods: string[] | null;
}

interface PreflightEvent {
	at: string;
	type: "preflight";
	version: number;
	repo: string;
	base: string;
	sha: string;
	clean: true;
	tools: Record<string, boolean>;
	rules: Rules | "unknown";
	rulesError?: string;
	check: string;
	chiefPane: string;
	tickets: RowId[];
}

interface ApproveEvent {
	at: string;
	type: "approve";
	quote: string;
	action: string;
	tickets: RowId[];
	inferred: boolean;
}

interface NoteEvent {
	at: string;
	type: "note";
	kind: string;
	ticket: RowId;
	text: string;
}

/** Events that move one row, one payload per type; `apply` folds each. */
type RowEvent = { at: string; ticket: RowId } & (
	| { type: "launch"; launch: Launch; deadline: number }
	| { type: "report"; path: string; status: "DONE" | "BLOCKED"; source: "event" | "status" }
	| { type: "answer"; basis: string; deadline: number }
	| { type: "answer"; user: string; deadline: number }
	| { type: "escalate" }
	| { type: "gate"; sha: string; judged: string }
	| { type: "round"; round: Round; deadline: number }
	/** `head` is the observed PR head, or null when `merge` ran update-branch and the new head is not known yet. */
	| { type: "head-moved"; head: string | null; reason: "pr-head" | "update-branch" }
	| { type: "merge-intent"; sha: string }
	| { type: "merged"; commit: string | null }
	| { type: "leave-open" }
	| { type: "drop"; user: string }
);

type Event = PreflightEvent | ApproveEvent | NoteEvent | RowEvent;

interface Run {
	id: string;
	dir: string;
	preflight: PreflightEvent;
	rows: Map<RowId, Row>;
	approvals: ApproveEvent[];
	notes: NoteEvent[];
}

/** A command refused for a reason the chief can act on; exit code 1. */
class Refusal extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Transition table: which event a row accepts; `apply` decides what it becomes. Which events are recorded is decided
// by the commands: `reconcile` records `report`, `merged` and `head-moved` from what it observes, `merge` records
// `merge-intent`, `head-moved` and `merged`.

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
	if (type === "answer" && row.state === "ASKED" && row.owner === "chief")
		throw new Refusal(
			`#${row.ticket} already had a chief answer; the question goes to the user: event ${row.ticket} escalate (${where(row)})`,
		);
	throw new Refusal(where(row));
}

/** The row's state and the events it accepts, as every refusal names them. */
function where(row: Row): string {
	return `#${row.ticket} is ${label(row)}; it accepts: ${accepted(row).join(", ") || "nothing"}`;
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
function apply(row: Row, e: RowEvent): void {
	check(row, e.type);
	switch (e.type) {
		case "launch":
			row.launch = e.launch;
			running(row, ROUNDS[0], e.deadline, e.at);
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
		gate: `gate ${n} --judged "<your note on the diff>"`,
		round: `event ${n} round <${LATER_ROUNDS.join("|")}> --deadline <minutes>`,
		...(row.intent ? {} : { "merge-intent": `merge ${n}` }),
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

function readEvents(dir: string): unknown[] {
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

/**
 * Rebuilds the run from its events; an event the table refuses means the log was edited by hand. A run whose
 * preflight carries another format version is refused before any event is read as this version's.
 */
function rebuild(id: string, dir: string): Run {
	const [first, ...rest] = readEvents(dir) as Event[];
	if (first?.type !== "preflight") throw new Error(`${dir}/events.jsonl does not start with a preflight event`);
	const preflight = first;
	if (preflight.version !== VERSION)
		throw new Refusal(
			`run ${id} was written by another version of the helper: its events.jsonl has version ${preflight.version ?? "none"}; this helper writes version ${VERSION}. Finish that run with the helper that wrote it, or point ${join(dirname(dir), "current")} elsewhere`,
		);
	const run: Run = { id, dir, preflight, rows: new Map(), approvals: [], notes: [] };
	for (const ticket of preflight.tickets)
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
	if (e.type === "preflight") throw new Error("a second preflight event");
	if (e.type === "approve") run.approvals.push(e);
	else if (e.type === "note") run.notes.push(e);
	else apply(rowOf(run, e.ticket), e);
}

/** Checks `e` against the current state, then appends it: a refused event is never written. */
function record(run: Run, e: ApproveEvent | NoteEvent | RowEvent): void {
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
	const row = typeof ticket === "number" || typeof ticket === "string" ? run.rows.get(ticket) : undefined;
	if (!row) throw new Refusal(`#${ticket} is not a row of run ${run.id}; rows: ${[...run.rows.keys()].join(", ")}`);
	return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Commands.

const LABEL_MAX = 32;

/**
 * A row id as given on the command line: digits without a leading zero are a ticket number; a label starts with a
 * lowercase letter and holds lowercase letters and digits in hyphen-separated words, at most 32 characters, so it is
 * never a number or an option and is safe in a shell word and a file name.
 */
function rowId(text: string | undefined, what: string): RowId {
	if (text && /^[1-9]\d*$/.test(text)) return Number(text);
	if (text && text.length <= LABEL_MAX && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(text)) return text;
	throw new Refusal(
		`${what} must be a ticket number or a label (a lowercase letter, then lowercase letters, digits and single inner hyphens, at most ${LABEL_MAX} characters), got ${JSON.stringify(text)}`,
	);
}

function ticketList(text: string | undefined, what: string): RowId[] {
	const tickets = (text ?? "").split(",").map((t) => rowId(t.trim(), what));
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
	const event: PreflightEvent = {
		at: now.toISOString(),
		type: "preflight",
		version: VERSION,
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

/**
 * Reads a report's first `Status` line (`Status: DONE` or a `Status` heading followed by its value): the status when
 * the value is exactly DONE or BLOCKED (optionally bold), else the value as written, which is not a finished report.
 */
function reportStatus(path: string): { status?: "DONE" | "BLOCKED"; value: string } {
	const lines = readFileSync(path, "utf8").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = /^(?:#+\s*)?\**Status\**\s*:?\s*(.*)$/i.exec(lines[i].trim());
		if (!match) continue;
		const value = match[1].trim() || (lines.slice(i + 1).find((l) => l.trim()) ?? "").trim();
		const status = /^(\*\*)?(DONE|BLOCKED)\1$/.exec(value)?.[2] as "DONE" | "BLOCKED" | undefined;
		return { status, value };
	}
	return { value: "" };
}

function reportEvent(at: string, ticket: RowId, path: string, source: "event" | "status"): RowEvent {
	if (!existsSync(path)) throw new Refusal(`report ${path} does not exist`);
	const { status, value } = reportStatus(path);
	if (!status)
		throw new Refusal(
			`report ${path} is not finished: its Status line must be exactly DONE or BLOCKED, got ${JSON.stringify(value)}`,
		);
	return { at, type: "report", ticket, path, status, source };
}

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();

/** A brief line as `--basis` must quote it: whitespace normalised, a leading list or heading marker dropped. */
const briefLine = (line: string) => normalise(normalise(line).replace(/^(?:#+|[-*+]|\d+[.)])\s+/, ""));

function event(argv: string[], runner: Runner, cwd: string): string {
	const [n, type, ...rest] = argv;
	const run = currentRun(runner, cwd);
	const row = rowOf(run, rowId(n, "the row"));
	if (!type) throw new Refusal(`name an event; ${where(row)}`);
	if (NOT_BY_EVENT[type])
		throw new Refusal(`${type} is not recorded through event: ${NOT_BY_EVENT[type]}; ${where(row)}`);
	if (!TABLE.some((t) => t.event === type))
		throw new Refusal(
			`unknown event ${type}; events: ${TABLE.map((t) => t.event)
				.filter((e) => !NOT_BY_EVENT[e])
				.join(", ")}; ${where(row)}`,
		);
	check(row, type);
	const at = runner.now().toISOString();
	const base = { at, ticket: row.ticket };
	let e: RowEvent;
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
			e = { ...base, type, launch, deadline: minutes(values) };
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
				const lines = readFileSync(row.launch!.brief, "utf8").split("\n").map(briefLine);
				if (!lines.includes(briefLine(basis)))
					throw new Refusal(
						`--basis is not in the brief ${row.launch!.brief} as a whole line; quote the whole line that decides it, or escalate`,
					);
				e = { ...base, type, basis, deadline };
			} else {
				if (values.basis !== undefined) throw new Refusal(`#${row.ticket} is ASKED(user); only --user answers it`);
				e = { ...base, type, user: required(values, "user"), deadline };
			}
			break;
		}
		case "round": {
			const { values, positionals } = parse(rest, { deadline: "string" });
			const round = LATER_ROUNDS.find((r) => r === positionals[0]);
			if (positionals.length !== 1 || !round)
				throw new Refusal(
					`round takes one of ${LATER_ROUNDS.join(", ")}; got ${JSON.stringify(positionals.join(" "))}`,
				);
			e = { ...base, type, round, deadline: minutes(values) };
			break;
		}
		case "drop": {
			const { values } = parse(rest, { user: "string" });
			e = { ...base, type, user: required(values, "user") };
			break;
		}
		case "escalate":
		case "leave-open":
			parse(rest, {});
			e = { ...base, type };
			break;
		default:
			throw new Error(`event ${type} is in the table but has no parser`);
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
	const e: ApproveEvent = {
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
	const ticket = rowOf(run, rowId(required(values, "ticket"), "--ticket")).ticket;
	const text = positionals.join(" ").trim();
	if (!text) throw new Refusal(`note needs the text of what happened`);
	record(run, { at: runner.now().toISOString(), type: "note", kind, ticket, text });
	return `note recorded: ${kind} #${ticket}\nledger: ${writeLedger(run, new Map(), runner.now())}`;
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
				record(run, { at: at(), type: "head-moved", ticket: row.ticket, head: pr.headRefOid, reason: "pr-head" });
			else if (pr.state !== "OPEN" && row.state !== "GATED")
				lines.push(
					`PR is ${pr.state} on GitHub while the row is ${label(row)}; ask the user and record the outcome`,
				);
		}
	}
	if (row.intent) lines.push(`merge intent at ${row.intent.sha} pending since ${row.intent.at}: the PR is not merged`);
	return lines;
}

function rulesText(preflight: PreflightEvent): string {
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
	const details = new Map<RowId, string[]>();
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
	out.push(`ledger: ${writeLedger(run, details, now)}`);
	return out.join("\n");
}

/**
 * Regenerates `ledger.md` from the run and returns its path. `details` holds what `status` observed outside per row;
 * `note` passes none, so its ledger shows the recorded events only.
 */
function writeLedger(run: Run, details: Map<RowId, string[]>, now: Date): string {
	const ledger = join(run.dir, "ledger.md");
	writeFileSync(ledger, renderLedger(run, details, now));
	return ledger;
}

function renderLedger(run: Run, details: Map<RowId, string[]>, now: Date): string {
	const p = run.preflight;
	const cell = (text: string) => text.replace(/\|/g, "\\|");
	const lines = [
		`<!-- Generated by batch.ts status or note from events.jsonl at ${now.toISOString()}; edits here are overwritten. -->`,
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
				`| #${r.ticket} | ${label(r)} | ${next(r)} | ${deadlineText(r, now)} | ${r.launch?.branch ?? ""} | ${r.lastAt} | ${cell((details.get(r.ticket) ?? []).join("; "))} |`,
		),
		"",
		"## Approvals",
		"",
		...(run.approvals.length
			? run.approvals.map(
					(a) =>
						`- ${a.at} ${a.action} ${a.tickets.map((t) => `#${t}`).join(", ")}: ${JSON.stringify(a.quote)}${a.inferred ? " (inferred)" : ""}`,
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

// ---------------------------------------------------------------------------------------------------------------
// Effect commands: each fetches what it decides on, and records only what it observed.

const PR_FIELDS =
	"number,state,headRefOid,baseRefName,mergeable,mergeStateStatus,statusCheckRollup,body,files,url,mergeCommit";
// Owned by LOCK_NAME in packages/pi-workers/extensions/delegate-implement.ts; test/batch-chief.test.ts holds the contract.
const LOCK = "me-pi-implement.lock";

/** Where an implement job's lock sits in a checkout's git dir. */
export const implementLock = (gitDir: string) => join(gitDir, LOCK);

function launched(row: Row): Launch {
	if (!row.launch) throw new Refusal(`#${row.ticket} was never launched; it has no worktree, branch or pane`);
	return row.launch;
}

function viewPr(run: Run, row: Row, runner: Runner): any {
	const branch = launched(row).branch;
	const view = runner.exec("gh", ["pr", "view", branch, "--json", PR_FIELDS], { cwd: run.preflight.repo });
	if (view.code !== 0) throw new Refusal(`cannot read the PR of ${branch}: ${view.stderr.trim()}`);
	return JSON.parse(view.stdout);
}

/** A check's name and whether it passed, for both shapes `statusCheckRollup` carries. */
function checkResult(c: any): { name: string; passed: boolean; result: string } {
	if (c?.__typename === "StatusContext")
		return { name: c.context, passed: c.state === "SUCCESS", result: String(c.state).toLowerCase() };
	const done = c?.status === "COMPLETED";
	const passed = done && ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion);
	return { name: c?.name, passed, result: String(done ? c.conclusion : c?.status).toLowerCase() };
}

/**
 * Failures of the checks on the PR head (`statusCheckRollup` is the head commit's): every required check must be
 * present and passed, and no other reported check may be failing or pending. Unknown rules require at least one
 * check.
 */
function checkFailures(pr: any, rules: Rules | "unknown"): string[] {
	const checks = ((pr.statusCheckRollup ?? []) as any[]).map(checkResult);
	const required = rules === "unknown" ? [] : rules.requiredChecks;
	const failures = required.flatMap((name) => {
		const found = checks.filter((c) => c.name === name);
		if (!found.length) return [`required check ${name} has not run on ${pr.headRefOid}`];
		return found.every((c) => c.passed)
			? []
			: [`required check ${name} has not passed on ${pr.headRefOid} (${found.map((c) => c.result).join(", ")})`];
	});
	for (const c of checks)
		if (!c.passed && !required.includes(c.name))
			failures.push(`check ${c.name} has not passed on ${pr.headRefOid} (${c.result})`);
	if (rules === "unknown" && !checks.length)
		failures.push(`no checks reported on ${pr.headRefOid} and the base rules are unknown`);
	return failures;
}

function gitIn(runner: Runner, dir: string, ...args: string[]): Result {
	return runner.exec("git", ["-C", dir, ...args]);
}

/** The porcelain status lines of a worktree, or a Refusal when git cannot read it. */
function dirtyLines(runner: Runner, worktree: string): string[] {
	const out = gitIn(runner, worktree, "status", "--porcelain");
	if (out.code !== 0) throw new Refusal(`git status failed in ${worktree}: ${out.stderr.trim()}`);
	return out.stdout.split("\n").filter((l) => l.trim());
}

function gate(argv: string[], runner: Runner, cwd: string): string {
	const { values, positionals } = parse(argv, { judged: "string" });
	const run = currentRun(runner, cwd);
	const row = rowOf(run, rowId(positionals[0], "the row"));
	check(row, "gate");
	const judged = required(values, "judged");
	const launch = launched(row);
	const facts: { ok: boolean; text: string }[] = [];
	const fact = (ok: boolean, text: string) => facts.push({ ok, text });
	const dirty = dirtyLines(runner, launch.worktree);
	fact(
		!dirty.length,
		dirty.length
			? `worktree ${launch.worktree} is not clean: ${dirty.join("; ")}`
			: `worktree ${launch.worktree} is clean`,
	);
	const tip = gitIn(runner, launch.worktree, "rev-parse", "HEAD");
	const local = tip.code === 0 ? tip.stdout.trim() : `unreadable (${tip.stderr.trim()})`;
	const pr = viewPr(run, row, runner);
	fact(
		local === pr.headRefOid,
		`local tip ${local} ${local === pr.headRefOid ? "equals" : "differs from"} the PR head ${pr.headRefOid}`,
	);
	fact(pr.state === "OPEN", `PR #${pr.number} is ${pr.state}`);
	const base = run.preflight.base;
	fact(pr.baseRefName === base, `PR targets ${pr.baseRefName}; the run's base is ${base}`);
	fact(pr.mergeable === "MERGEABLE", `PR mergeable: ${pr.mergeable}`);
	const failures = checkFailures(pr, run.preflight.rules);
	if (failures.length) for (const failure of failures) fact(false, failure);
	else fact(true, `checks passed on ${pr.headRefOid}`);
	const skipped: string[] = [];
	if (typeof row.ticket === "number") {
		const closes = new RegExp(`\\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\\s+#${row.ticket}\\b`, "i").test(
			pr.body ?? "",
		);
		fact(closes, closes ? `body closes #${row.ticket}` : `body does not close #${row.ticket}`);
	} else skipped.push(`body closing keyword not checked: ${row.ticket} is a label row, not a ticket`);
	const files = ((pr.files ?? []) as any[]).map((f) => `  ${f.path} +${f.additions} -${f.deletions}`);
	const passed = facts.every((f) => f.ok);
	const out = [
		`Fetched by this command (PR #${pr.number}${pr.url ? ` ${pr.url}` : ""}):`,
		...facts.map((f) => `  ${f.ok ? "PASS" : "FAIL"}: ${f.text}`),
		...skipped.map((s) => `  SKIP: ${s}`),
		`  files changed (${files.length}):`,
		...files.map((f) => `  ${f}`),
		"Read by the chief:",
		`  ${judged}`,
		"Taken on report (not verified):",
		`  everything ${launch.report} states (check runs, reviews, what changed and why); this command did not read it`,
	];
	if (!passed) throw new Refusal(`gate failed; #${row.ticket} stays ${label(row)}\n${out.join("\n")}`);
	record(run, { at: runner.now().toISOString(), type: "gate", ticket: row.ticket, sha: pr.headRefOid, judged });
	return `${out.join("\n")}\n#${row.ticket} is ${label(row)}`;
}

function merge(argv: string[], runner: Runner, cwd: string): string {
	const { positionals } = parse(argv, {});
	const run = currentRun(runner, cwd);
	const row = rowOf(run, rowId(positionals[0], "the row"));
	check(row, "merge-intent");
	if (row.intent)
		throw new Refusal(
			`a merge intent for #${row.ticket} at ${row.intent.sha} is pending since ${row.intent.at}; run status to reconcile it before anything else`,
		);
	const covering = run.approvals.filter((a) => a.action === "merge" && a.tickets.includes(row.ticket));
	if (!covering.some((a) => !a.inferred))
		throw new Refusal(
			covering.length
				? `only an inferred merge approval covers #${row.ticket}; confirm it with the user and record their words with approve (without --inferred)`
				: `no merge approval covers #${row.ticket}; record the user's words with approve --action merge`,
		);
	const rules = run.preflight.rules;
	if (rules !== "unknown" && rules.mergeMethods && !rules.mergeMethods.includes("squash"))
		throw new Refusal(`the base rules allow ${rules.mergeMethods.join(", ")}, not squash`);
	const pr = viewPr(run, row, runner);
	if (pr.state !== "OPEN") throw new Refusal(`PR #${pr.number} is ${pr.state}; run status to reconcile`);
	if (pr.headRefOid !== row.sha)
		throw new Refusal(
			`#${row.ticket} was gated at ${row.sha} but the PR head is ${pr.headRefOid}; run status, then gate again`,
		);
	const failures = checkFailures(pr, rules);
	if (failures.length) throw new Refusal(failures.join("; "));
	const repo = run.preflight.repo;
	if (pr.mergeStateStatus === "BEHIND" && (rules === "unknown" || rules.upToDate)) {
		const update = runner.exec("gh", ["pr", "update-branch", String(pr.number)], { cwd: repo });
		if (update.code !== 0)
			throw new Refusal(
				`PR #${pr.number} is behind ${pr.baseRefName} and gh pr update-branch failed: ${update.stderr.trim()}`,
			);
		record(run, {
			at: runner.now().toISOString(),
			type: "head-moved",
			ticket: row.ticket,
			head: null,
			reason: "update-branch",
		});
		return `PR #${pr.number} was behind ${pr.baseRefName} and the rules ${rules === "unknown" ? "are unknown" : "require it up to date"}: branch updated; #${row.ticket} is ${label(row)}; gate again when CI finishes on the new head`;
	}
	record(run, { at: runner.now().toISOString(), type: "merge-intent", ticket: row.ticket, sha: row.sha! });
	const merged = runner.exec("gh", ["pr", "merge", String(pr.number), "--squash", "--match-head-commit", row.sha!], {
		cwd: repo,
	});
	const after = viewPr(run, row, runner);
	if (after.state !== "MERGED")
		throw new Refusal(
			`GitHub says PR #${pr.number} is ${after.state}, not merged${merged.code !== 0 ? ` (gh pr merge exited ${merged.code}: ${merged.stderr.trim()})` : ""}; the intent stays pending: run status before anything else`,
		);
	const commit = after.mergeCommit?.oid ?? null;
	record(run, { at: runner.now().toISOString(), type: "merged", ticket: row.ticket, commit });
	return `#${row.ticket} is MERGED as ${commit}`;
}

/** Whether a live Pi runs in the pane; `undefined` when the pane is gone. */
function piInPane(runner: Runner, pane: string): boolean | undefined {
	const info = runner.exec("herdr", ["pane", "process-info", "--pane", pane]);
	if (info.code !== 0) {
		if (/pane_not_found/.test(info.stdout + info.stderr)) return undefined;
		throw new Refusal(`cannot read the processes of pane ${pane}: ${(info.stderr || info.stdout).trim()}`);
	}
	const procs = JSON.parse(info.stdout)?.result?.process_info?.foreground_processes ?? [];
	return procs.some((p: any) => /(^|\/)pi$/.test(p?.argv0 ?? ""));
}

/** Whether pane text shows an open dialog: a select hint, or a `guard` confirm title (`Allow <risk>?`). */
export function dialogVisible(screen: string): boolean {
	return /enter select/.test(screen) || /^\s*Allow .+\?\s*$/m.test(screen);
}

/** Why the chief may not type into the pane now, or `undefined` when a prompt is safe. */
function promptBlocker(runner: Runner, pane: string): string | undefined {
	const live = piInPane(runner, pane);
	if (!live)
		return `no live Pi in pane ${pane}${live === undefined ? " (the pane is gone)" : ""}; a prompt would type into the shell`;
	const read = runner.exec("herdr", ["agent", "read", pane, "--source", "visible"]);
	if (read.code !== 0) return `cannot read pane ${pane}: ${read.stderr.trim()}`;
	if (dialogVisible(read.stdout))
		return `a dialog is visible in pane ${pane}; Enter would answer it: release it with herdr agent send-keys ${pane} esc and take the question to the user`;
	return undefined;
}

function prompt(argv: string[], runner: Runner, cwd: string): string {
	const { positionals } = parse(argv, {});
	const [n, ...words] = positionals;
	const run = currentRun(runner, cwd);
	const row = rowOf(run, rowId(n, "the row"));
	const text = words.join(" ").trim();
	if (!text) throw new Refusal("prompt needs the text to send");
	const pane = launched(row).pane;
	const blocker = promptBlocker(runner, pane);
	if (blocker) throw new Refusal(blocker);
	const sent = runner.exec("herdr", ["agent", "prompt", pane, text]);
	if (sent.code !== 0) throw new Refusal(`herdr agent prompt ${pane} failed: ${(sent.stderr || sent.stdout).trim()}`);
	return `sent to #${row.ticket} in pane ${pane}`;
}

const QUIT_POLLS = 15;

/** Releases one terminal row's resources in order; returns the lines to print and why anything was left. */
function cleanRow(run: Run, row: Row, runner: Runner, dryRun: boolean): { lines: string[]; left?: string } {
	const launch = row.launch!;
	const repo = run.preflight.repo;
	const lines: string[] = [];
	const effect = (cmd: string, args: string[], cwd?: string): Result => {
		if (dryRun) {
			lines.push(`  would run: ${[cmd, ...args].join(" ")}`);
			return { code: 0, stdout: "", stderr: "" };
		}
		lines.push(`  ran: ${[cmd, ...args].join(" ")}`);
		return runner.exec(cmd, args, cwd ? { cwd } : undefined);
	};
	const live = piInPane(runner, launch.pane);
	if (live) {
		const blocker = promptBlocker(runner, launch.pane);
		if (blocker) return { lines, left: blocker };
		const quit = effect("herdr", ["agent", "prompt", launch.pane, "/quit"]);
		if (quit.code !== 0) return { lines, left: `/quit was not sent: ${quit.stderr.trim()}` };
		if (!dryRun) {
			let polls = 0;
			while (piInPane(runner, launch.pane)) {
				if (++polls > QUIT_POLLS) return { lines, left: `Pi still runs in pane ${launch.pane} after /quit` };
				runner.exec("sleep", ["1"]);
			}
		}
	}
	if (existsSync(launch.worktree)) {
		const gitDir = gitIn(runner, launch.worktree, "rev-parse", "--path-format=absolute", "--git-dir");
		if (gitDir.code !== 0)
			return { lines, left: `cannot find the git dir of ${launch.worktree}: ${gitDir.stderr.trim()}` };
		const lock = implementLock(gitDir.stdout.trim());
		if (existsSync(lock)) return { lines, left: `${lock} is present: a worker is writing` };
		const dirty = dirtyLines(runner, launch.worktree);
		if (dirty.length) return { lines, left: `worktree ${launch.worktree} is not clean: ${dirty.join("; ")}` };
		const removed = effect("git", ["worktree", "remove", launch.worktree], repo);
		if (removed.code !== 0) return { lines, left: `git worktree remove failed: ${removed.stderr.trim()}` };
	}
	if (row.state === "MERGED") {
		const exists = runner.exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${launch.branch}`], {
			cwd: repo,
		});
		if (exists.code === 0) {
			const deleted = effect("git", ["branch", "-D", launch.branch], repo);
			if (deleted.code !== 0)
				return { lines, left: `git branch -D ${launch.branch} failed: ${deleted.stderr.trim()}` };
		}
	} else lines.push(`  kept branch ${launch.branch}: the PR is not merged`);
	if (live !== undefined) {
		const closed = effect("herdr", ["pane", "close", launch.pane]);
		if (closed.code !== 0) return { lines, left: `herdr pane close ${launch.pane} failed: ${closed.stderr.trim()}` };
	}
	return { lines };
}

function cleanup(argv: string[], runner: Runner, cwd: string): string {
	const { values } = parse(argv, { "dry-run": "boolean" });
	const dryRun = values["dry-run"] === true;
	const run = currentRun(runner, cwd);
	const out: string[] = [dryRun ? "cleanup --dry-run: nothing is changed" : "cleanup"];
	const left: string[] = [];
	for (const row of run.rows.values()) {
		if (!row.launch) continue;
		const resources = `worktree ${row.launch.worktree}, branch ${row.launch.branch}, pane ${row.launch.pane}`;
		if (!TERMINAL.includes(row.state)) {
			left.push(`#${row.ticket} ${resources}: the row is ${label(row)}, not terminal`);
			continue;
		}
		out.push(`#${row.ticket} ${label(row)}:`);
		const result = cleanRow(run, row, runner, dryRun);
		out.push(...result.lines);
		if (result.left) {
			out.push(`  left: ${result.left}`);
			left.push(`#${row.ticket} ${resources}: ${result.left}`);
		}
	}
	out.push(
		"Notes:",
		...(run.notes.length ? run.notes.map((n) => `- ${n.kind} #${n.ticket}: ${n.text}`) : ["- none"]),
		"Resources left:",
		...(left.length ? left.map((l) => `- ${l}`) : ["- none"]),
	);
	return out.join("\n");
}

const COMMANDS: Record<string, (argv: string[], runner: Runner, cwd: string) => string> = {
	preflight,
	event,
	approve,
	note,
	status,
	gate,
	merge,
	prompt,
	cleanup,
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
