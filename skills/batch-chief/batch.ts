/**
 * The batch-chief helper: `node batch.ts <command>`. One run's state lives in `events.jsonl` under
 * `<repo>.worktrees/.batch/<run-id>/` and is rebuilt from it on every command; this module owns the row states
 * and their transition table.
 */
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
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

/** One watcher poll, with consecutive definite absences and failed delivery checks carried between polls. */
export function timerDecision(input: {
	running: boolean;
	deadline: number;
	expected: number;
	now: number;
	absent: boolean;
	misses: number;
	tries: number;
	blocker: boolean;
}): { action: "exit" | "wait" | "send" | "give-up"; misses: number; tries: number } {
	const { running, deadline, expected, now, absent, blocker } = input;
	let { misses, tries } = input;
	if (!running || deadline !== expected) return { action: "exit", misses, tries };
	misses = absent ? misses + 1 : 0;
	if (now < expected && misses < 2 && tries === 0) return { action: "wait", misses, tries };
	if (!blocker) return { action: "send", misses, tries };
	tries++;
	return { action: tries >= 20 ? "give-up" : "wait", misses, tries };
}

type State = "QUEUED" | "RUNNING" | "ASKED" | "REPORTED" | "GATED" | "MERGED" | "LEFT_OPEN" | "DROPPED";
/** Coordinator rounds; the first is the one `launch` starts, the rest are what `round` reopens a row with. */
const ROUNDS = ["implement", "review", "fix", "update"] as const;
type Round = (typeof ROUNDS)[number];
const LATER_ROUNDS = ROUNDS.filter((r) => r !== "implement");
/**
 * The events.jsonl format this helper writes; a run with a version outside `READS` is refused. Bump it when an older
 * helper would ignore a new field or event that changes a refusal or an effect (as `live` changes what `merge` allows);
 * an optional field that only adds display text (as `approve`'s `question`) needs none. A run keeps its preflight's
 * version: this helper appends to an older run only events and fields that version has, which holds for version 1
 * because `live` and `live-result` exist only on a row its preflight named with `live`.
 */
const VERSION = 2;
/**
 * The versions this helper reads. `1` is kept for runs the version-1 helper started that are still open (their
 * `current` pointer is set) when the skill updates: such a log is a version-2 log without live checks, so it replays
 * unchanged. Drop `1` from `READS`, with `v1-events.jsonl` and its tests, once no version-1 run can be open: the
 * first release after every user has ended or set aside their version-1 runs.
 */
const READS = [1, VERSION];
const LIVE_MODES = ["before-merge", "after-merge"] as const;
type LiveMode = (typeof LIVE_MODES)[number];
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
	/** When `launch` was recorded; while it equals `lastAt` the row has not moved since, so its contract may be written. */
	launchedAt?: string;
	chiefAnswers: number;
	/** A merge intent with no observed result yet. */
	intent?: { sha: string; at: string };
	commit?: string | null;
	/** The row's live check, named at preflight; `result` holds only a result at the row's current `sha`. */
	live?: { mode: LiveMode; result?: { sha: string; result: "pass" | "fail"; evidence: string; at: string } };
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
	/** The rows with a live check and when it runs; rows not named have none. */
	live?: { ticket: RowId; mode: LiveMode }[];
	/** The run of another version this preflight set aside, with the user's words that it is finished and cleaned up. */
	setAside?: { run: string; version: unknown; user: string };
}

interface ApproveEvent {
	at: string;
	type: "approve";
	quote: string;
	/** What the user's words answered; optional display text, so no version bump (see `VERSION`). */
	question?: string;
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
	/** A live check's result, against the row's gated SHA (for a merged row, the SHA it was gated and merged at). */
	| { type: "live-result"; sha: string; result: "pass" | "fail"; evidence: string }
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

type RowEventType = RowEvent["type"];

interface Transition {
	/** Whether a row in this state accepts the event. */
	accepts: (row: Row) => boolean;
	/** The command `status` lists while the row accepts the event (none when it returns undefined), or null. */
	usage: ((row: Row) => string | undefined) | null;
	/** Why `event` refuses it: the step that records it instead; null when `event` records it. */
	recordedBy: string | null;
}

/** Every row event, in table order (the order refusals and `status` list them in), with the states it leaves from. */
const TRANSITIONS: Record<RowEventType, Transition> = {
	launch: {
		accepts: (r) => r.state === "QUEUED",
		usage: (r) =>
			`event ${r.ticket} launch --worktree <path> --branch <name> --pane <id> --session <file> --brief <path> --report <path> --deadline <minutes>`,
		recordedBy: null,
	},
	report: {
		accepts: (r) => r.state === "RUNNING",
		usage: (r) => `event ${r.ticket} report --path ${r.launch?.report ?? "<report>"}`,
		recordedBy: null,
	},
	answer: {
		accepts: (r) => r.state === "ASKED" && (r.owner === "user" || r.chiefAnswers === 0),
		usage: (r) =>
			r.owner === "chief"
				? `event ${r.ticket} answer --basis "<quoted brief line>"`
				: `event ${r.ticket} answer --user "<user's words>"`,
		recordedBy: null,
	},
	escalate: {
		accepts: (r) => r.state === "ASKED" && r.owner === "chief",
		usage: (r) => `event ${r.ticket} escalate`,
		recordedBy: null,
	},
	gate: {
		accepts: (r) => r.state === "REPORTED",
		usage: (r) => `gate ${r.ticket} --judged "<your note on the diff>"`,
		recordedBy: "the gate command records it when every fetched fact passes",
	},
	round: {
		accepts: (r) => r.state === "REPORTED" || r.state === "GATED",
		usage: (r) => `event ${r.ticket} round <${LATER_ROUNDS.join("|")}> --deadline <minutes>`,
		recordedBy: null,
	},
	"head-moved": {
		accepts: (r) => r.state === "GATED",
		usage: null,
		recordedBy: "status records it when the PR head differs from the gated SHA",
	},
	"merge-intent": {
		accepts: (r) => r.state === "GATED",
		usage: (r) => (r.intent ? undefined : `merge ${r.ticket}`),
		recordedBy: "the merge command records it before merging",
	},
	merged: {
		accepts: (r) => r.state === "GATED",
		usage: null,
		recordedBy: "status records it when GitHub says the PR is merged",
	},
	"leave-open": {
		accepts: (r) => r.state === "GATED",
		usage: (r) => `event ${r.ticket} leave-open`,
		recordedBy: null,
	},
	"live-result": {
		accepts: (r) => !!r.live && (r.state === "GATED" || (r.state === "MERGED" && r.live.mode === "after-merge")),
		usage: (r) => liveResultUsage(r.ticket),
		recordedBy: "the live command records it",
	},
	drop: {
		accepts: (r) => !TERMINAL.includes(r.state),
		usage: (r) => `event ${r.ticket} drop --user "<user's words>"`,
		recordedBy: null,
	},
};

const ROW_EVENTS = Object.keys(TRANSITIONS) as RowEventType[];

function liveResultUsage(ticket: RowId, result = "<pass|fail>"): string {
	return `live ${ticket} --result ${result} --evidence "<text or path>"`;
}

/** Whether a merged `after-merge` row still owes its live check result; it keeps the run open. */
const liveOwed = (row: Row) => row.state === "MERGED" && row.live?.mode === "after-merge" && !row.live.result;

const isRowEvent = (type: string): type is RowEventType => Object.hasOwn(TRANSITIONS, type);

/** The exhaustiveness check of a switch: a case left out makes its value reach here and fails `tsc`. */
function unreachable(value: never): never {
	throw new Error(`unhandled case ${JSON.stringify(value)}`);
}

function accepted(row: Row): RowEventType[] {
	return ROW_EVENTS.filter((type) => TRANSITIONS[type].accepts(row));
}

function label(row: Row): string {
	switch (row.state) {
		case "RUNNING":
			return `RUNNING(${row.round})`;
		case "ASKED":
			return `ASKED(${row.owner})`;
		case "GATED":
			return `GATED(${row.sha})`;
		case "QUEUED":
		case "REPORTED":
		case "MERGED":
		case "LEFT_OPEN":
		case "DROPPED":
			return row.state;
		default:
			return unreachable(row.state);
	}
}

function next(row: Row): string {
	switch (row.state) {
		case "RUNNING":
			return "coordinator";
		case "ASKED":
			return row.owner!;
		case "GATED":
			return "user, then chief";
		case "QUEUED":
		case "REPORTED":
		case "MERGED":
		case "LEFT_OPEN":
		case "DROPPED":
			return TERMINAL.includes(row.state) ? "nobody" : "chief";
		default:
			return unreachable(row.state);
	}
}

/** Throws a Refusal naming the row's state and the events it accepts when `type` is not one of them. */
function check(row: Row, type: RowEventType): void {
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
			row.launchedAt = e.at;
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
		case "live-result":
			row.live!.result = { sha: e.sha, result: e.result, evidence: e.evidence, at: e.at };
			break;
		case "drop":
			row.state = "DROPPED";
			row.deadline = undefined;
			break;
		default:
			unreachable(e);
	}
	// A live result goes stale exactly as the gate does: whatever clears or moves the gated SHA clears it.
	if (row.live?.result && row.live.result.sha !== row.sha) row.live.result = undefined;
	row.lastAt = e.at;
}

/** The commands status lists for a row; an event with no usage, or none in this state, is left out. */
function allowedCommands(row: Row): string[] {
	return accepted(row).flatMap((type) => {
		const usage = TRANSITIONS[type].usage?.(row);
		return usage ? [usage] : [];
	});
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
	if (!READS.includes(preflight.version)) throw new Refusal(otherVersion(id, preflight.version));
	const run: Run = { id, dir, preflight, rows: new Map(), approvals: [], notes: [] };
	for (const ticket of preflight.tickets)
		run.rows.set(ticket, { ticket, state: "QUEUED", lastAt: preflight.at, chiefAnswers: 0 });
	for (const { ticket, mode } of preflight.live ?? []) rowOf(run, ticket).live = { mode };
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

function otherVersion(id: string, version: unknown): string {
	return `run ${id} was written by another version of the helper: its events.jsonl has version ${version ?? "none"}; this helper writes version ${VERSION} and reads ${READS.join(", ")}. Finish that run with the helper that wrote it`;
}

/** The format version a run's first event carries, read without replaying the run's events. */
function logVersion(dir: string): unknown {
	const path = join(dir, "events.jsonl");
	const first = readFileSync(path, "utf8").split("\n", 1)[0];
	try {
		return JSON.parse(first)?.version;
	} catch (error) {
		throw new Error(`${path}:1 is not JSON: ${(error as Error).message}`);
	}
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

/** `--live <n>:<before-merge|after-merge>[,...]`: each entry names a row of `tickets` once. */
function liveList(text: string, tickets: RowId[]): { ticket: RowId; mode: LiveMode }[] {
	const entries = text.split(",").map((entry) => {
		const match = /^([^:]+):(.*)$/.exec(entry.trim());
		if (!match) throw new Refusal(`--live entries are <n>:<${LIVE_MODES.join("|")}>, got ${JSON.stringify(entry)}`);
		const ticket = rowId(match[1], "--live");
		if (!tickets.includes(ticket)) throw new Refusal(`--live names #${ticket}, which is not a row of --tickets`);
		const mode = LIVE_MODES.find((m) => m === match[2]);
		if (!mode)
			throw new Refusal(
				`--live mode of #${ticket} must be before-merge or after-merge, got ${JSON.stringify(match[2])}`,
			);
		return { ticket, mode };
	});
	const named = entries.map((e) => e.ticket);
	const twice = named.find((t, i) => named.indexOf(t) !== i);
	if (twice !== undefined) throw new Refusal(`--live names #${twice} twice: ${text}`);
	return entries;
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
	const { values } = parse(argv, {
		repo: "string",
		tickets: "string",
		check: "string",
		"chief-pane": "string",
		live: "string",
		"set-aside-old-run": "string",
	});
	const setAsideWords = values["set-aside-old-run"];
	if (setAsideWords !== undefined && (typeof setAsideWords !== "string" || !setAsideWords.trim()))
		throw new Refusal(`--set-aside-old-run needs the user's words confirming the old run is finished and cleaned up`);
	const repo = mainCheckout(runner, resolve(cwd, required(values, "repo")));
	const tickets = ticketList(required(values, "tickets"), "--tickets");
	const live = values.live === undefined ? undefined : liveList(required(values, "live"), tickets);
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
	let setAside: PreflightEvent["setAside"];
	let setAsideText: string | undefined;
	if (existsSync(pointer)) {
		const id = readFileSync(pointer, "utf8").trim();
		const old = join(batch, id);
		const version = logVersion(old);
		if (!READS.includes(version as number)) {
			// Another version's events are never replayed through this table; the user vouches the run is finished.
			if (typeof setAsideWords !== "string")
				throw new Refusal(
					`${otherVersion(id, version)}; run preflight again with --set-aside-old-run "<user's words>" only after the user confirms it is finished and cleaned up, to start a new run without checking it`,
				);
			setAside = { run: id, version: version ?? null, user: setAsideWords };
			setAsideText = `set aside run ${id} (version ${version ?? "none"}), not checked; it stays in ${old}, and any worktree, branch or pane it left is not cleaned up; the user's words: ${JSON.stringify(setAsideWords)}`;
		} else {
			const rows = [...rebuild(id, old).rows.values()];
			const open = rows.filter((r) => !TERMINAL.includes(r.state));
			if (open.length)
				throw new Refusal(
					`run ${id} still has rows that are not terminal: ${open.map((r) => `#${r.ticket}`).join(", ")}`,
				);
			const owed = rows.filter(liveOwed);
			if (owed.length)
				throw new Refusal(
					`run ${id} still owes a live check: ${owed.map((r) => `#${r.ticket} (batch.ts ${liveResultUsage(r.ticket)})`).join(", ")}`,
				);
		}
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
		...(live ? { live } : {}),
		...(setAside ? { setAside } : {}),
	};
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify(event)}\n`);
	writeFileSync(pointer, `${id}\n`);
	const missing = TOOLS.filter((tool) => !tools[tool]);
	return [
		`run ${id} created in ${dir}`,
		...(setAsideText ? [setAsideText] : []),
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
	const recordedBy = isRowEvent(type) ? TRANSITIONS[type].recordedBy : null;
	if (recordedBy) throw new Refusal(`${type} is not recorded through event: ${recordedBy}; ${where(row)}`);
	if (!isRowEvent(type))
		throw new Refusal(
			`unknown event ${type}; events: ${ROW_EVENTS.filter((e) => !TRANSITIONS[e].recordedBy).join(", ")}; ${where(row)}`,
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
			const pushes = confirmedApprovals(run, row, "push", (a) => a.action === "push");
			if (pushes.why) throw new Refusal(pushes.why);
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
	const { values } = parse(argv, {
		quote: "string",
		question: "string",
		action: "string",
		tickets: "string",
		prs: "string",
		inferred: "boolean",
	});
	const run = currentRun(runner, cwd);
	const action = required(values, "action");
	if (!/^[a-z][a-z-]*$/.test(action))
		throw new Refusal(`--action must be a word such as merge, got ${JSON.stringify(action)}`);
	if ((values.tickets === undefined) === (values.prs === undefined))
		throw new Refusal("name the rows with exactly one of --tickets or --prs");
	const tickets =
		values.prs === undefined
			? ticketList(required(values, "tickets"), "--tickets")
			: prRows(run, runner, required(values, "prs"));
	for (const ticket of tickets) rowOf(run, ticket);
	const question = values.question === undefined ? undefined : required(values, "question");
	const e: ApproveEvent = {
		at: runner.now().toISOString(),
		type: "approve",
		quote: required(values, "quote"),
		...(question === undefined ? {} : { question }),
		action,
		tickets,
		inferred: values.inferred === true,
	};
	record(run, e);
	return `approval recorded: ${action} ${tickets.map((t) => `#${t}`).join(", ")}${e.inferred ? " (inferred: confirm with the user before acting)" : ""}`;
}

/** The rows owning `--prs`, in its order: each launched row's branch is looked up on GitHub for its PR number. */
function prRows(run: Run, runner: Runner, text: string): RowId[] {
	const prs = text.split(",").map((p) => p.trim().replace(/^#/, ""));
	if (prs.some((p) => !/^[1-9]\d*$/.test(p)))
		throw new Refusal(`--prs must be PR numbers separated by commas, got ${JSON.stringify(text)}`);
	if (new Set(prs).size !== prs.length) throw new Refusal(`--prs names a PR twice: ${text}`);
	const owner = new Map<string, RowId>();
	for (const row of run.rows.values()) {
		if (!row.launch) continue;
		const view = runner.exec("gh", ["pr", "view", row.launch.branch, "--json", "number"], {
			cwd: run.preflight.repo,
		});
		if (view.code === 0) owner.set(String(JSON.parse(view.stdout).number), row.ticket);
		else if (!/no pull requests found/.test(view.stderr))
			throw new Refusal(`cannot read the PR of ${row.launch.branch}: ${view.stderr.trim()}`);
	}
	const missing = prs.find((p) => !owner.has(p));
	if (missing)
		throw new Refusal(
			`PR #${missing} is not the PR of any row; rows' PRs: ${[...owner].map(([pr, t]) => `#${pr} (#${t})`).join(", ") || "none"}`,
		);
	return prs.map((p) => owner.get(p)!);
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
	return `note recorded: ${kind} #${ticket}\nledger: ${writeLedger(run, "note", runner.now())}`;
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
	return lines;
}

/** The lines under a row that the event log alone determines, shown by both `status` and the ledger. */
function logLines(row: Row): string[] {
	const lines = row.intent
		? [`merge intent at ${row.intent.sha} pending since ${row.intent.at}: the PR is not merged`]
		: [];
	if (row.live) lines.push(`live check: ${row.live.mode}, ${liveText(row)}`);
	return lines;
}

function liveText(row: Row): string {
	const result = row.live?.result;
	if (result) return `${result.result} at ${result.sha}: ${result.evidence}`;
	return liveOwed(row) ? `OWED: run it, then batch.ts ${liveResultUsage(row.ticket)}` : "no result recorded";
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

/**
 * Prints the run and each row with its launch facts, allowed commands and observed outside. It reads no pane: a
 * coordinator line such as `ATTEMPT FAILED` is the chief's to read, and only a report file moves a row.
 */
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
		const l = row.launch;
		if (l) out.push(`  launched: pane ${l.pane}, worktree ${l.worktree}, branch ${l.branch}, session ${l.session}`);
		for (const command of allowedCommands(row)) out.push(`  allowed: ${command}`);
		for (const line of [...details.get(row.ticket)!, ...logLines(row)]) out.push(`  ${line}`);
	}
	out.push(`ledger: ${writeLedger(run, "status", now, details)}`);
	return out.join("\n");
}

/**
 * Regenerates `ledger.md` from the run and returns its path. `outside` holds what `status` observed outside per row;
 * `note` checks nothing outside, so its ledger says so in place of those facts.
 */
function writeLedger(run: Run, by: "status" | "note", now: Date, outside?: Map<RowId, string[]>): string {
	const ledger = join(run.dir, "ledger.md");
	writeFileSync(ledger, renderLedger(run, by, now, outside));
	return ledger;
}

function renderLedger(run: Run, by: "status" | "note", now: Date, outside?: Map<RowId, string[]>): string {
	const p = run.preflight;
	const cell = (text: string) => text.replace(/\|/g, "\\|");
	const lines = [
		`<!-- Generated by batch.ts ${by} from events.jsonl at ${now.toISOString()}; edits here are overwritten. -->`,
		`# Batch run ${run.id}`,
		"",
		`- Repo: \`${p.repo}\`, base \`${p.base}\` at \`${p.sha}\`, main checkout clean at preflight`,
		`- Check: \`${p.check}\``,
		`- Chief pane: \`${p.chiefPane}\``,
		`- Tools: ${TOOLS.map((t) => `${t} ${p.tools[t] ? "found" : "missing"}`).join(", ")}`,
		`- Base rules: ${rulesText(p)}`,
		...(p.setAside
			? [
					`- Set aside: run ${p.setAside.run} (version ${p.setAside.version ?? "none"}), not checked: ${JSON.stringify(p.setAside.user)}`,
				]
			: []),
		"",
		"| Row | State | Next | Deadline | Branch | Last event | Notes |",
		"| --- | --- | --- | --- | --- | --- | --- |",
		...[...run.rows.values()].map(
			(r) =>
				`| #${r.ticket} | ${label(r)} | ${next(r)} | ${deadlineText(r, now)} | ${r.launch?.branch ?? ""} | ${r.lastAt} | ${cell([...(outside ? (outside.get(r.ticket) ?? []) : [`outside not checked (written by ${by}); run status`]), ...logLines(r)].join("; "))} |`,
		),
		"",
		"## Approvals",
		"",
		...(run.approvals.length
			? run.approvals.map(
					(a) =>
						`- ${a.at} ${a.action} ${a.tickets.map((t) => `#${t}`).join(", ")}: ${JSON.stringify(a.quote)}${a.question === undefined ? "" : ` answering ${JSON.stringify(a.question)}`}${a.inferred ? " (inferred)" : ""}`,
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

/** Printed last by a passing `gate`: how the chief puts the gate's decisions to the user. */
const RECOMMEND_REMINDER = "Put one recommended action beside each decision you put to the user.";
/** Printed by a passing `gate` and by `merge`, so friction is recorded while it is fresh. */
const NOTE_REMINDER = 'Record any friction now: batch.ts note --kind <kind> --ticket <n> "<what>".';

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
	return [...out, `#${row.ticket} is ${label(row)}`, RECOMMEND_REMINDER, NOTE_REMINDER].join("\n");
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
	const approvals = confirmedApprovals(run, row, "merge", (a) => a.action === "merge");
	if (approvals.why) throw new Refusal(approvals.why);
	if (!approvals.confirmed.length)
		throw new Refusal(`no merge approval covers #${row.ticket}; record the user's words with approve --action merge`);
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
	const result = row.live?.result;
	if (row.live?.mode === "before-merge" && result?.result !== "pass")
		throw new Refusal(
			`#${row.ticket} has a before-merge live check and no recorded pass at ${row.sha}${result ? ` (the last result at it is ${result.result})` : ""}; run it from the clone (batch.ts live ${row.ticket} start), then record the pass with batch.ts ${liveResultUsage(row.ticket, "pass")}`,
		);
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
	return `#${row.ticket} is MERGED as ${commit}\n${NOTE_REMINDER}`;
}

/**
 * `live <n> start` puts a clone of the main checkout at the gated SHA in `<run dir>/live/<n>/` (a clone, not a
 * worktree, so no other checkout's lock holds it up); an existing clean clone is fetched and reused, nothing is
 * deleted. `live <n> --result <pass|fail> --evidence <text>` records the result against the row's gated SHA.
 */
function live(argv: string[], runner: Runner, cwd: string): string {
	const { values, positionals } = parse(argv, { result: "string", evidence: "string" });
	const run = currentRun(runner, cwd);
	const row = rowOf(run, rowId(positionals[0], "the row"));
	if (!row.live)
		throw new Refusal(`#${row.ticket} has no live check; a row gets one only at preflight --live <n>:<mode>`);
	if (positionals[1] === "start" && positionals.length === 2 && values.result === undefined) {
		if (row.state !== "GATED") throw new Refusal(`live start needs a GATED row; ${where(row)}`);
		return liveStart(run, row, runner);
	}
	if (positionals.length !== 1)
		throw new Refusal(`usage: live ${row.ticket} start, or ${liveResultUsage(row.ticket)}`);
	const result = required(values, "result");
	if (result !== "pass" && result !== "fail") throw new Refusal(`--result must be pass or fail, got ${result}`);
	const evidence = required(values, "evidence");
	check(row, "live-result");
	const sha = row.sha!;
	record(run, { at: runner.now().toISOString(), type: "live-result", ticket: row.ticket, sha, result, evidence });
	return `#${row.ticket} live check ${result} recorded at ${sha}`;
}

function liveStart(run: Run, row: Row, runner: Runner): string {
	const path = join(run.dir, "live", String(row.ticket));
	const sha = row.sha!;
	const step = (args: string[]) => {
		const out = runner.exec("git", args);
		if (out.code !== 0) throw new Refusal(`git ${args.join(" ")} failed: ${out.stderr.trim()}`);
	};
	let how: string;
	if (isLink(path) || isLink(dirname(path)))
		throw new Refusal(`${path} or its parent is a symlink; the clone goes only into the run's own live directory`);
	if (existsSync(path)) {
		const dirty = dirtyLines(runner, path);
		if (dirty.length)
			throw new Refusal(`${path} exists and is not clean: ${dirty.join("; ")}; nothing was changed in it`);
		step(["-C", path, "fetch", "origin"]);
		how = `reused the clone at ${path}`;
	} else {
		step(["clone", run.preflight.repo, path]);
		how = `cloned ${run.preflight.repo} into ${path}`;
	}
	step(["-C", path, "checkout", "--detach", sha]);
	return [
		`${how}, detached at ${sha}`,
		`run #${row.ticket}'s ${row.live!.mode} live check there, and the same check on the base as a control; then batch.ts ${liveResultUsage(row.ticket)}`,
	].join("\n");
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
	const contractFile = contractPath(run, row);
	// Only the implement round needs it: later rounds follow a report, which the contract made the coordinator write.
	if (row.state === "RUNNING" && row.round === "implement" && !existsSync(contractFile))
		throw new Refusal(
			`#${row.ticket} has no contract at ${contractFile}; write it before prompting the coordinator: batch.ts ${CONTRACT_USAGE(row.ticket)}`,
		);
	const blocker = promptBlocker(runner, pane);
	if (blocker) throw new Refusal(blocker);
	const sent = runner.exec("herdr", ["agent", "prompt", pane, text]);
	if (sent.code !== 0) throw new Refusal(`herdr agent prompt ${pane} failed: ${(sent.stderr || sent.stdout).trim()}`);
	return `sent to #${row.ticket} in pane ${pane}`;
}

// ---------------------------------------------------------------------------------------------------------------
// The coordinator contract: CONTRACT.md beside this file is its only text; `contract` fills the placeholders its
// table names and holds no copy of it.

const CONTRACT_USAGE = (ticket: RowId) => `contract ${ticket} [--lenses "<text>"] --skill <name> --setup "<cmd>"`;

const contractPath = (run: Run, row: Row) => join(run.dir, `contract-${row.ticket}.md`);

/**
 * The parts of CONTRACT.md `contract` uses: the placeholder table (first column to its default cell), the
 * placeholders it declares kept as written, and the two blocks.
 */
function contractSource(): {
	table: Map<string, string | undefined>;
	kept: Set<string>;
	contract: string;
	template: string;
} {
	const path = join(import.meta.dirname, "CONTRACT.md");
	const lines = readFileSync(path, "utf8").split("\n");
	/** The cells of each row of the table whose header starts with `| <first> |`; `\|` is a pipe inside a cell. */
	const rows = (first: string) => {
		const head = lines.findIndex((l) => new RegExp(`^\\|\\s*${first}\\s*\\|`).test(l));
		if (head < 0) throw new Error(`${path} has no | ${first} | table`);
		const end = lines.findIndex((l, i) => i > head && !l.startsWith("|"));
		return lines
			.slice(head + 2, end < 0 ? undefined : end)
			.map((l) => l.split(/(?<!\\)\|/).map((cell) => cell.replaceAll("\\|", "|").trim()));
	};
	const names = (cell: string) => [...cell.matchAll(/`(<[^`>]+>)`/g)].map((m) => m[1]);
	const table = new Map<string, string | undefined>();
	for (const [, first, , fallback] of rows("Placeholder"))
		for (const name of names(first)) table.set(name, fallback || undefined);
	const kept = new Set(rows("Kept as written").flatMap(([, first]) => names(first)));
	/** The fenced markdown block under `heading`, with its fence lines; it closes at its own fence's length. */
	const block = (heading: string) => {
		const at = lines.indexOf(heading);
		const open = lines.findIndex((l, i) => i > at && /^`{3,}markdown$/.test(l));
		const fence = open < 0 ? "" : lines[open].slice(0, -"markdown".length);
		const close = lines.findIndex((l, i) => i > open && l === fence);
		if (at < 0 || open < 0 || close < 0) throw new Error(`${path} has no fenced markdown block under ${heading}`);
		return lines.slice(open, close + 1);
	};
	return {
		table,
		kept,
		contract: block("## Contract").slice(1, -1).join("\n"),
		template: block("## Report template").join("\n"),
	};
}

/** Replaces each placeholder of `values` in `text` in one pass, so a value (a user's quote) is never filled itself. */
function fill(text: string, values: Map<string, string>): string {
	const names = [...values.keys()].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	return text.replace(new RegExp(names.join("|"), "g"), (name) => values.get(name)!);
}

/**
 * `contract <n>` writes `<run dir>/contract-<n>.md` from CONTRACT.md: its contract block, then `## Report template`
 * with the template block, every placeholder of the table filled from the run, the row's launch and the user's
 * approvals. It runs only between `launch` and the row's next event, so the coordinator's contract is fixed once the
 * row has moved; a rerun there rewrites the run's own derived file.
 */
function contract(argv: string[], runner: Runner, cwd: string): string {
	const { values, positionals } = parse(argv, { lenses: "string", skill: "string", setup: "string" });
	const run = currentRun(runner, cwd);
	const row = rowOf(run, rowId(positionals[0], "the row"));
	if (positionals.length !== 1) throw new Refusal(`usage: ${CONTRACT_USAGE(row.ticket)}`);
	if (!row.launch)
		throw new Refusal(
			`contract needs the launch facts: run batch.ts event ${row.ticket} launch first; ${where(row)}`,
		);
	if (row.state !== "RUNNING" || row.round !== "implement" || row.lastAt !== row.launchedAt)
		throw new Refusal(
			`#${row.ticket}'s contract is fixed once the row moves past its launch; send a change with prompt; ${where(row)}`,
		);
	const { table, kept, contract: body, template } = contractSource();
	const p = run.preflight;
	const l = row.launch;
	const missing = new Map<string, string>();
	const filled = new Map<string, string>();
	const option = (name: string) => {
		const value = values[name];
		return typeof value === "string" && value.trim() ? value : undefined;
	};
	const cut = gitIn(runner, l.worktree, "merge-base", "HEAD", `origin/${p.base}`);
	const baseSha = cut.code === 0 && cut.stdout.trim() ? cut.stdout.trim() : undefined;
	const authorised = authorisedActions(run, row);
	const sources: Record<string, () => string | undefined> = {
		"<n>": () => String(row.ticket),
		"<chief pane>": () => p.chiefPane,
		"<brief>": () => l.brief,
		"<worktree>": () => l.worktree,
		"<branch>": () => l.branch,
		"<base>": () => p.base,
		"<base sha>": () => baseSha,
		"<review point>": () => baseSha,
		"<check>": () => p.check,
		"<setup>": () => option("setup"),
		"<implementation skill>": () => option("skill"),
		"<lenses>": () => option("lenses") ?? table.get("<lenses>"),
		"<authorised actions>": () => authorised.lines,
		"<report>": () => l.report,
		"<scratch>": () => `${join(run.dir, "scratch", String(row.ticket))}/`,
	};
	const why: Record<string, string> = {
		"<base sha>": `git -C ${l.worktree} merge-base HEAD origin/${p.base} failed: ${cut.stderr.trim() || "no output"}`,
		"<review point>": "it is <base sha>, which has no value",
		"<setup>": "--setup is required",
		"<implementation skill>": "--skill is required",
		"<lenses>": "--lenses is required: CONTRACT.md's table states no default",
		"<authorised actions>": authorised.why ?? "",
	};
	for (const name of table.keys()) {
		const source = sources[name];
		if (!source) {
			missing.set(
				name,
				"this helper has no source for it; give it one in batch.ts contract, or drop it from the table",
			);
			continue;
		}
		const value = source();
		if (value === undefined) missing.set(name, why[name] ?? "no value");
		else filled.set(name, value);
	}
	if (missing.size)
		throw new Refusal(
			`contract for #${row.ticket} not written: ${[...missing].map(([name, reason]) => `${name}: ${reason}`).join("; ")}`,
		);
	// The table's default lenses name <review point>: a default taken from the table is filled itself.
	if (!option("lenses")) filled.set("<lenses>", fill(filled.get("<lenses>")!, filled));
	// A placeholder in the text that neither table declares would reach the coordinator unfilled. The unfilled text
	// is read, so a user's quote holding `<...>` is not taken for one.
	const left = new Set(
		[...body.matchAll(/<[^<>\n]+>/g)].map((m) => m[0]).filter((name) => !table.has(name) && !kept.has(name)),
	);
	if (left.size)
		throw new Refusal(
			`contract for #${row.ticket} not written: ${[...left].join(", ")} in CONTRACT.md's contract text, declared by neither table; add each to the placeholder table with its source in batch.ts contract, or to the kept-as-written table`,
		);
	const text = `${fill(body, filled)}\n\n## Report template\n\n${fill(template, filled)}\n`;
	const path = contractPath(run, row);
	writeFileSync(path, text);
	return `contract for #${row.ticket} written to ${path}`;
}

/**
 * The approvals of `run` matching `matches` that cover `row` and were recorded without `--inferred`. When some cover it
 * but every one is inferred, `why` is the refusal: an inferred scope never authorises an action until the user confirms
 * it. `what` names the action in that refusal.
 */
function confirmedApprovals(
	run: Run,
	row: Row,
	what: string | undefined,
	matches: (a: ApproveEvent) => boolean,
): { confirmed: ApproveEvent[]; why?: string } {
	const covering = run.approvals.filter((a) => matches(a) && a.tickets.includes(row.ticket));
	const confirmed = covering.filter((a) => !a.inferred);
	if (covering.length && !confirmed.length)
		return {
			confirmed,
			why: `only an inferred ${what ? `${what} ` : ""}approval covers #${row.ticket}; confirm it with the user and record their words with approve (without --inferred)`,
		};
	return { confirmed };
}

/**
 * The coordinator's authorised actions: one line per approval recorded without `--inferred` that covers the row,
 * except `merge`, which stays the chief's. None, or only inferred ones, is a reason to refuse, as `launch` and
 * `merge` refuse an inferred scope.
 */
function authorisedActions(run: Run, row: Row): { lines?: string; why?: string } {
	const { confirmed, why } = confirmedApprovals(run, row, undefined, (a) => a.action !== "merge");
	if (why) return { why };
	if (!confirmed.length)
		return {
			why: `no approval covers #${row.ticket} for its coordinator (a merge approval is the chief's); record the user's words with approve --action push`,
		};
	const lines = confirmed.map(
		(a) =>
			`- ${a.action}, ${a.at}: ${JSON.stringify(a.quote)}${a.question === undefined ? "" : `, answering ${JSON.stringify(a.question)}`}`,
	);
	return { lines: lines.join("\n") };
}

const QUIT_POLLS = 15;

/**
 * Releases one terminal row's resources in order; returns the lines to print, why anything was left, and the local
 * branch it kept because the PR is not merged.
 */
function cleanRow(
	run: Run,
	row: Row,
	runner: Runner,
	dryRun: boolean,
): { lines: string[]; left?: string; kept?: string } {
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
	const exists = runner.exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${launch.branch}`], {
		cwd: repo,
	});
	if (exists.code !== 0 && exists.code !== 1)
		return { lines, left: `cannot check branch ${launch.branch}: ${exists.stderr.trim()}` };
	let kept: string | undefined;
	if (exists.code === 0 && row.state === "MERGED") {
		const deleted = effect("git", ["branch", "-D", launch.branch], repo);
		if (deleted.code !== 0) return { lines, left: `git branch -D ${launch.branch} failed: ${deleted.stderr.trim()}` };
	} else if (exists.code === 0) {
		lines.push(`  kept branch ${launch.branch}: the PR is not merged`);
		kept = launch.branch;
	}
	if (live !== undefined) {
		const closed = effect("herdr", ["pane", "close", launch.pane]);
		if (closed.code !== 0) return { lines, left: `herdr pane close ${launch.pane} failed: ${closed.stderr.trim()}` };
	}
	return { lines, kept };
}

/** The run's own directories that `cleanup` removes once every coordinator has quit; nothing else is ever removed. */
const DISPOSABLE = ["scratch", "live"];
/** The first format version whose contract made `DISPOSABLE` the run's: an older run's are listed, never removed. */
const DISPOSABLE_SINCE = 2;

/**
 * The run directory as a real path, refused unless it is a real directory directly inside the real batch directory:
 * the deletion roots are built from it alone, never from report, event or command-line text.
 */
function realRunDir(run: Run): string {
	const batch = realpathSync(dirname(run.dir));
	if (basename(run.dir) !== run.id || ["", ".", ".."].includes(run.id) || run.id.includes(sep))
		throw new Refusal(`run id ${JSON.stringify(run.id)} is not a plain directory name`);
	const dir = join(batch, run.id);
	if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir)
		throw new Refusal(`run directory ${run.dir} is not a real directory inside ${batch}`);
	return dir;
}

/** Whether `path` is a symlink, dangling or not (`existsSync` follows links and misses a dangling one). */
function isLink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Throws unless `path` lies strictly inside `root` and its parent is the real, unlinked directory `parent`. */
function assertInside(root: string, parent: string, path: string): void {
	if (!path.startsWith(`${root}${sep}`) || dirname(path) !== parent || realpathSync(parent) !== parent)
		throw new Error(`${path} does not resolve inside ${root}; nothing more is removed`);
}

/**
 * Removes everything below the real directory `dir` bottom-up. Each entry is read with `lstat`, so a symlink is
 * unlinked as a file and never followed; containment is checked again right before each removal.
 */
function removeBelow(root: string, dir: string): void {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		assertInside(root, dir, path);
		if (lstatSync(path).isDirectory()) {
			removeBelow(root, path);
			assertInside(root, dir, path);
			rmdirSync(path);
		} else unlinkSync(path);
	}
}

/**
 * Removes the run's `scratch/` and `live/` (or lists them on a dry run): a root that is a symlink is unlinked, a
 * directory is emptied with `removeBelow` and removed. Returns the lines to print and the roots it could not remove.
 */
function removeDisposable(
	run: Run,
	dryRun: boolean,
	names: readonly string[] = DISPOSABLE,
): { lines: string[]; left: string[] } {
	const lines: string[] = [];
	const left: string[] = [];
	let dir: string;
	try {
		dir = realRunDir(run);
	} catch (error) {
		const why = `scratch and live not removed: ${(error as Error).message}`;
		return { lines: [`  left: ${why}`], left: [why] };
	}
	for (const name of names) {
		const root = join(dir, name);
		const shown = join(run.dir, name);
		let kind: "symlink" | "directory" | "file";
		try {
			const st = lstatSync(root);
			kind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "directory" : "file";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			// The coordinators are already gone: report what is left rather than lose the outcome.
			lines.push(`  left: ${shown}: ${(error as Error).message}`);
			left.push(`${shown}: not checked: ${(error as Error).message}`);
			continue;
		}
		const what = kind === "symlink" ? "unlink symlink" : "remove";
		if (dryRun) {
			lines.push(`  would ${what}: ${shown}`);
			continue;
		}
		try {
			if (kind === "directory") {
				removeBelow(root, root);
				assertInside(dir, dir, root);
				rmdirSync(root);
			} else {
				assertInside(dir, dir, root);
				unlinkSync(root);
			}
			lines.push(`  ${kind === "symlink" ? "unlinked symlink" : "removed"}: ${shown}`);
		} catch (error) {
			lines.push(`  left: ${shown}: ${(error as Error).message}`);
			left.push(`${shown}: partly removed or kept: ${(error as Error).message}`);
		}
	}
	return { lines, left };
}

/** The entries of a report's `## Scratch paths left` section as written, without `none`; read, never resolved. */
function scratchPathsLeft(path: string): string[] {
	if (!existsSync(path)) return [];
	const lines = readFileSync(path, "utf8").split("\n");
	const start = lines.findIndex((l) => /^#+\s*Scratch paths left\s*$/i.test(l.trim()));
	if (start < 0) return [];
	const end = lines.findIndex((l, i) => i > start && /^#+\s/.test(l.trim()));
	return lines
		.slice(start + 1, end < 0 ? undefined : end)
		.flatMap((l) => /^[-*+]\s+(.*)$/.exec(l.trim())?.[1].trim() ?? [])
		.filter((entry) => entry && !/^none\.?$/i.test(entry));
}

/** What `cleanup` hands to the user without touching it: remote branches of merged rows, scratch paths, a behind base. */
function handOver(run: Run, runner: Runner): string[] {
	const repo = run.preflight.repo;
	const base = run.preflight.base;
	const items: string[] = [];
	const remoteHead = (branch: string) =>
		runner.exec("git", ["ls-remote", "origin", `refs/heads/${branch}`], { cwd: repo });
	for (const row of run.rows.values()) {
		if (!row.launch) continue;
		if (row.state === "MERGED") {
			const remote = remoteHead(row.launch.branch);
			if (remote.code !== 0)
				items.push(`#${row.ticket} cannot check remote branch ${row.launch.branch}: ${remote.stderr.trim()}`);
			else if (remote.stdout.trim())
				items.push(`#${row.ticket} remote branch ${row.launch.branch} still exists on origin; not deleted`);
		}
		for (const entry of scratchPathsLeft(row.launch.report))
			items.push(`#${row.ticket} scratch path left (from ${row.launch.report}): ${entry}`);
	}
	const remote = remoteHead(base);
	const head = runner.exec("git", ["rev-parse", "HEAD"], { cwd: repo });
	const sha = remote.stdout.split(/\s/)[0];
	if (remote.code !== 0 || head.code !== 0 || !sha)
		items.push(
			`cannot tell whether main checkout ${repo} is behind origin/${base}: ${(remote.stderr || head.stderr).trim() || "no remote head"}`,
		);
	else if (sha !== head.stdout.trim()) {
		const ancestor = runner.exec("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { cwd: repo });
		// Exit 1: origin's head is not in HEAD; "not a valid commit": origin has a commit this checkout never fetched.
		if (ancestor.code === 1 || /not a valid (commit|object)/i.test(ancestor.stderr))
			items.push(`main checkout ${repo} is behind origin/${base} (${sha}); pull it before the next batch`);
		else if (ancestor.code !== 0)
			items.push(`cannot tell whether main checkout ${repo} is behind origin/${base}: ${ancestor.stderr.trim()}`);
	}
	return items;
}

function cleanup(argv: string[], runner: Runner, cwd: string): string {
	const { values } = parse(argv, { "dry-run": "boolean" });
	const dryRun = values["dry-run"] === true;
	const run = currentRun(runner, cwd);
	const out: string[] = [dryRun ? "cleanup --dry-run: nothing is changed" : "cleanup"];
	const left: string[] = [];
	/** Rows whose coordinator was not confirmed gone, or whose resources failed a check: scratch and live stay. */
	let unsettled = false;
	for (const row of run.rows.values()) {
		if (!row.launch) continue;
		const resources = `worktree ${row.launch.worktree}, branch ${row.launch.branch}, pane ${row.launch.pane}`;
		if (!TERMINAL.includes(row.state)) {
			left.push(`#${row.ticket} ${resources}: the row is ${label(row)}, not terminal`);
			unsettled = true;
			continue;
		}
		out.push(`#${row.ticket} ${label(row)}:`);
		const result = cleanRow(run, row, runner, dryRun);
		out.push(...result.lines);
		if (result.left) {
			out.push(`  left: ${result.left}`);
			left.push(`#${row.ticket} ${resources}: ${result.left}`);
			unsettled = true;
		} else if (result.kept) left.push(`#${row.ticket} branch ${result.kept}: kept, the PR is not merged`);
	}
	unsettled ||= [...run.rows.values()].some((r) => !TERMINAL.includes(r.state));
	const owed = [...run.rows.values()].filter(liveOwed);
	for (const row of owed)
		left.push(`#${row.ticket} live check (after-merge) owed: run it, then batch.ts ${liveResultUsage(row.ticket)}`);
	out.push("Run directory:");
	// Like `handOver`'s items, listed for the user and no reason to keep the run: this run's contract never gave them away.
	const notOwned: string[] = [];
	if (owed.length) {
		// The owed check runs from its clone: live stays, scratch goes once the coordinators are gone.
		const root = join(run.dir, "live");
		if (existsSync(root) || isLink(root)) out.push(`  kept: ${root}: a live check is owed`);
	}
	if (run.preflight.version < DISPOSABLE_SINCE) {
		for (const name of DISPOSABLE) {
			const root = join(run.dir, name);
			if (!existsSync(root) && !isLink(root)) continue;
			const why = `not removed: run ${run.id} was started by the version-${run.preflight.version} helper, whose contract never made it disposable`;
			out.push(`  ${why}: ${root}`);
			notOwned.push(`${root}: ${why}`);
		}
	} else if (unsettled) {
		for (const name of owed.length ? ["scratch"] : DISPOSABLE) {
			const root = join(run.dir, name);
			if (!existsSync(root) && !isLink(root)) continue;
			out.push(`  kept: ${root}: a row is not terminal or its coordinator is not confirmed gone`);
			left.push(`${root}: kept until every coordinator has quit`);
		}
	} else {
		const removed = removeDisposable(run, dryRun, owed.length ? ["scratch"] : DISPOSABLE);
		out.push(...removed.lines);
		left.push(...removed.left);
	}
	// Listed for the user, never removed, and no reason to keep the run: the helper does not own them.
	const handed = [...notOwned, ...handOver(run, runner)];
	out.push(
		"Notes:",
		...(run.notes.length ? run.notes.map((n) => `- ${n.kind} #${n.ticket}: ${n.text}`) : ["- none"]),
		"Resources left:",
		...(left.length || handed.length ? [...left, ...handed].map((l) => `- ${l}`) : ["- none"]),
	);
	const finished = !left.length && [...run.rows.values()].every((r) => TERMINAL.includes(r.state));
	if (finished && !dryRun) {
		const pointer = join(dirname(run.dir), "current");
		try {
			unlinkSync(pointer);
			out.push(`current run cleared: ${pointer} removed; ${run.dir} stays; the next batch starts with preflight`);
		} catch (error) {
			out.push(`current run not cleared: removing ${pointer} failed: ${(error as Error).message}`);
		}
	}
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
	live,
	contract,
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
