/**
 * Short rows for finished tool calls while tool output is collapsed. A row is one line (a status glyph, what ran,
 * then facts about the result) and a few indented output lines, with no background box.
 *
 * The numbers below were picked by replaying 40 past sessions through Pi's row component and by checking which
 * lines a reader needs: the first output line often carries the answer or a table header, the last ones the result.
 *
 * The transcript holds what a reader needs later; a live area above the editor holds what is happening now.
 * While the agent works, a call shows only in the live area: the last three calls, with the time a running one
 * has taken and its last output line. A row enters the transcript once the next step shows what became of it:
 *
 * - Followed by another step, a command keeps one line, without its output. A call known to change nothing
 *   (a lookup, or a check that passed) keeps no line; a stretch of work made only of such calls is one count.
 * - Followed by text, a call shows with its output, and keeps it when that text is the reply: it is usually
 *   the check the reply rests on. It folds as above if another step follows the text after all.
 * - A failure, a write and the changed lines of an edit show as soon as the call ends, and stay. A failed
 *   command folds, and dims, only once the same command passes later.
 *
 * Folded rows that follow each other close up into one block. When the agent stops, the live area becomes one
 * line that sums up the run: failures still open, files changed, calls, time.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionAPI, renderDiff, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getCapabilities,
	hyperlink,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Output this short is shown whole. */
const WHOLE_LINES = 6;
/** Longer output keeps its first line and its last three. */
const HEAD_LINES = 1;
const TAIL_LINES = 3;
/** A failed call keeps its end from the first line that reads like an error, looking this far back. */
const FAILED_LINES = 20;
/** A failed call with no such line keeps this many, which is also the least a failed call keeps. */
const FAILED_MIN_LINES = 5;
const ERROR_LIKE =
	/error|fail|✖|✗|not found|no such|denied|cannot|exception|traceback|fatal|panic|refused|invalid|unexpected/i;
/** The shape of an error message itself, not just a line that mentions one: `TypeError:`, `error TS2322`, `fatal:`. */
const ERROR_SHAPE =
	/\w*(Error|Exception):|\berror[ :[(]+[A-Z]+\d+|^\s*(fatal|panic|error)\b[:!]|\b(FAIL|FAILED|Traceback)\b|✖|✗/;
/** A cut in the middle of a command must save at least this many columns over a cut at its end. */
const MIDDLE_CUT_MIN = 8;
/** A command that ran this long shows its duration as a warning. */
const SLOW_MS = 30_000;
/** Changed lines an edit shows before it counts the rest. */
const EDIT_LINES = 4;

type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];

/** One collapsed row: `head` after the status glyph, `meta` at the end of that line, `body` lines below. */
interface Summary {
	/** A function gets the columns it may fill, for a head that shortens itself. */
	head: string | ((room: number) => string);
	meta?: string[];
	body?: string[];
	/** Lines of output the call returned: a row that shows none of them says how many there were. */
	count?: number;
	/** The body is what the call did, not what it printed: it stays when the row folds. */
	keep?: boolean;
	/** The call is known to change nothing: once folded it keeps no line of its own. */
	silent?: boolean;
	/** Set on a folded row that no longer needs attention: the whole line is dim. */
	quiet?: boolean;
}
type Summarize = (args: any, result: Result | undefined, theme: Theme, context: Context) => Summary;

/** Kept in the row's shared renderer state, beside whatever Pi's own renderer keeps there. */
interface RowState {
	piCall?: Component;
	piResult?: Component;
	result?: Result;
	failed?: boolean;
	durationMs?: number;
	/** When the call started running; set for a call in the live area, which shows the time it has taken. */
	startedAt?: number;
	expanded?: boolean;
	/** The row's summary and its drawn first line, kept until Pi next updates the row: Pi draws every row on every frame. */
	summary?: Summary;
	headLine?: { key: string; rows: string[] };
	bodyLines?: { key: string; rows: string[] };
}

/** Where a call sits in the transcript. */
interface Call {
	id: string;
	index: number;
	/** The assistant message that made the call: calls of one message run together and fold together. */
	turn: number;
	/** The user prompt the call answers. */
	run: number;
	/** Calls with no text between their rows; folded rows of one block close up. */
	block: number;
}
/** What a drawn row tells its neighbours. */
interface Row {
	/** True when the row is folded to its first line or to nothing, so it can close up with the rows around it. */
	folded: () => boolean;
	/** True when the folded row keeps no line: it is counted with the silent rows next to it. */
	silent: () => boolean;
	head: (width: number) => string[];
	/** The command a `bash` row ran: a failure is settled once the same command passes. */
	command?: string;
}
/**
 * The calls of the current session in transcript order, kept from Pi's message events: a row cannot see its
 * neighbours. A hidden `Thinking...` label between two rows is not text, so it does not start a new block.
 */
const transcript = {
	calls: new Map<string, Call>(),
	order: [] as Call[],
	/** Rows by call id. A row can draw before its call is known here, so a new session does not clear them. */
	rows: new Map<string, Row>(),
	/** The calls that ran each command and passed. */
	passed: new Map<string, Set<string>>(),
	turn: 0,
	block: 0,
	run: 0,
	/** The newest turn with a call, by run. */
	newest: new Map<number, number>(),
	/** The last turn whose calls have their place in the transcript; later calls show only in the live area. */
	settled: 0,
	textSeen: false,
};
function resetTranscript(): void {
	transcript.calls.clear();
	transcript.newest.clear();
	Object.assign(transcript, { order: [], turn: 0, block: 0, run: 0, settled: 0, textSeen: false });
}
function startMessage(message: any): void {
	if (message?.role === "user") {
		settle(transcript.turn);
		transcript.run++;
		transcript.block++;
	} else if (message?.role === "assistant") {
		transcript.turn++;
		transcript.textSeen = false;
	}
}
/** Takes in an assistant message as it stands; called again as the message streams in. */
function noteMessage(message: any): void {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		const text = block.type === "text" && block.text?.trim();
		// The message's first text or call shows what became of the step before it. After text the step shows
		// with its output, and folds if a call follows after all.
		if (text || block.type === "toolCall") settle(transcript.turn - 1);
		if (text && !transcript.textSeen) {
			transcript.textSeen = true;
			transcript.block++;
		}
		if (block.type !== "toolCall" || transcript.calls.has(block.id)) continue;
		const { turn, run } = transcript;
		const call = { id: block.id, index: transcript.order.length, turn, run, block: transcript.block };
		transcript.calls.set(block.id, call);
		transcript.order.push(call);
		transcript.newest.set(run, turn);
	}
}
function settle(turn: number): void {
	transcript.settled = Math.max(transcript.settled, turn);
}
/** True while nothing has followed the call's step yet. A call this module was not told of is not held back. */
function unsettled(toolCallId: string): boolean {
	const call = transcript.calls.get(toolCallId);
	return call !== undefined && call.turn > transcript.settled;
}
/** True once a later step followed the call: a call of a later message, before the next user prompt. */
function superseded(toolCallId: string): boolean {
	const call = transcript.calls.get(toolCallId);
	return call !== undefined && call.turn < (transcript.newest.get(call.run) ?? 0);
}
/** True for a failed command that a later call ran again and passed. */
function passedLater(toolCallId: string): boolean {
	const call = transcript.calls.get(toolCallId);
	const command = transcript.rows.get(toolCallId)?.command;
	if (!call || command === undefined) return false;
	for (const id of transcript.passed.get(command) ?? [])
		if ((transcript.calls.get(id)?.index ?? -1) > call.index) return true;
	return false;
}
const foldedRow = (call: Call | undefined) => (call && transcript.rows.get(call.id)?.folded() ? call : undefined);
const closesUp = (call: Call, other: Call | undefined) => other?.block === call.block && foldedRow(other) !== undefined;
/**
 * The lines of the run of folded rows that ends with this one: a line for each row that keeps one. A run that
 * opens its block and keeps no line is one count instead, so a stretch of work always leaves a trace.
 */
function foldedRun(call: Call, width: number, tally: (count: number) => string): string[] {
	let first = call.index;
	while (first > 0 && closesUp(call, transcript.order[first - 1])) first--;
	const rows = transcript.order.slice(first, call.index + 1).map(({ id }) => transcript.rows.get(id));
	const drawn = rows.flatMap((row) => (row?.silent() ? [] : (row?.head(width) ?? [])));
	const opensBlock = transcript.order[first - 1]?.block !== call.block;
	return drawn.length === 0 && opensBlock ? [tally(rows.length)] : drawn;
}

function rowState(context: Context): RowState {
	context.state.compactTools ??= {};
	return context.state.compactTools;
}
const lines = (render: (width: number) => string[]): Component => ({ invalidate() {}, render });

/** Non-blank output lines: a collapsed row spends no row on a blank one. */
function outputLines(result: Result | undefined): string[] {
	const text = (result?.content ?? []).map((block) => (block.type === "text" ? block.text : "")).join("\n");
	return stripVTControlCharacters(text.replace(/\r/g, ""))
		.replace(/\t/g, "   ")
		.split("\n")
		.filter((line) => line.trim());
}
function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
function shortPath(path: string, cwd: string): string {
	if (path === cwd) return ".";
	if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
	const home = process.env.HOME;
	return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
/** A file path, short on screen and a link to the file where the terminal supports links. */
function filePath(args: any, theme: Theme, cwd: string): string {
	const path = String(args?.path ?? args?.file_path ?? "...");
	const text = theme.fg("accent", shortPath(path, cwd));
	return getCapabilities().hyperlinks ? hyperlink(text, pathToFileURL(resolve(cwd, path)).href) : text;
}
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const title = (theme: Theme, text: string) => theme.fg("toolTitle", theme.bold(text));

/** A call as the live area shows it. */
interface Shown {
	toolName: string;
	args: any;
	startedAt: number;
	result?: Result;
	failed?: boolean;
	durationMs?: number;
	/** The end of what a running call has printed so far. */
	output: string[];
}
/** What one run did, from the prompt to the agent stopping. */
interface Run {
	startedAt: number;
	calls: number;
	changed: Set<string>;
	/** Failed calls by what they tried, dropped when the same thing later succeeds. */
	open: Set<string>;
	tried: Map<string, string>;
	/** The calls of the live area, oldest first. */
	shown: Map<string, Shown>;
}
/** The widget above the editor: the live area while the agent works, the receipt once it stops. */
const AREA = "compact-tools";
/** The live area's height. It does not change while the agent works, so the editor below it stays in place. */
const AREA_LINES = 3;
/** Tools whose rows this module does not hold back: they draw their own, so the live area leaves them out. */
const drawsOwnRow = new Set<string>();
const newRun = (): Run => ({
	startedAt: Date.now(),
	calls: 0,
	changed: new Set(),
	open: new Set(),
	tried: new Map(),
	shown: new Map(),
});
/** What a call tried: a command, or a tool on a file. A retry of the same thing settles an earlier failure. */
function attempt(toolName: string, args: any): string {
	const target = toolName === "bash" ? String(args?.command ?? "").trim() : (args?.path ?? args?.file_path ?? "");
	return `${toolName} ${target}`;
}
/** The run in one line, what needs attention first; nothing for a run that called no tool. */
function receipt(run: Run, theme: Theme): string | undefined {
	if (run.calls === 0) return undefined;
	const facts = [
		...(run.open.size > 0 ? [theme.fg("error", `✗ ${plural(run.open.size, "failure")} open`)] : []),
		...(run.changed.size > 0 ? [theme.fg("muted", `${plural(run.changed.size, "file")} changed`)] : []),
		theme.fg("dim", plural(run.calls, "call")),
		theme.fg("dim", formatDuration(Date.now() - run.startedAt)),
	];
	return facts.join(theme.fg("dim", " · "));
}
/**
 * The live area: one line for each of the run's last calls, newest last. The newest call, while it runs, also
 * shows the end of its output. Blank lines above keep the height fixed.
 */
function liveArea(run: Run, theme: Theme, cwd: string, width: number): string[] {
	const shown = [...run.shown.values()].filter((call) => !drawsOwnRow.has(call.toolName));
	const drawn: string[] = [];
	for (const [back, call] of shown.toReversed().entries()) {
		if (drawn.length >= AREA_LINES) break;
		const state: RowState = call;
		const context = { cwd, isError: call.failed === true, outputPad: 1, state: { compactTools: state } } as Context;
		const summarize = SUMMARIES[call.toolName] ?? plainSummary(call.toolName);
		const summary = { ...summarize(call.args, call.result, theme, context), body: [] };
		const output = back === 0 && !call.result ? call.output.slice(1 - AREA_LINES) : [];
		drawn.unshift(
			...headLine(summary, state, theme, context).render(width),
			...indented(
				output.map((line) => theme.fg("toolOutput", line)),
				state,
				theme,
				context,
			).render(width),
		);
	}
	return [...Array(Math.max(0, AREA_LINES - drawn.length)).fill(""), ...drawn.slice(-AREA_LINES)];
}

/** `cd <dir>` in front of a command says where it ran, not what it did. */
const CD_PREFIX = /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;|\n)\s*/;
/** Plumbing that shapes a command's output for the model and tells a reader nothing about what ran. */
const SHELL_OPTIONS = /^set\s+[-+][a-z]+(?:\s+pipefail)?\s*(?:&&|;|\n)\s*/;
const STDERR_MERGE = /\s+2>&1(?=\s|$)/g;
const OUTPUT_CAP = /\s*\|\s*(?:tail|head)(?:\s+-n?\s*\d+)?\s*$/;

/** Programs that read, wait or report, and checks: test runs, linters, type checks. None leaves a change behind. */
const CHANGES_NOTHING = new RegExp(
	`^(?:${[
		"rg|grep|ls|cat|head|tail|sed\\s+-n|find|fd|wc|tree|stat|file|which|pwd|echo|printf|sort|uniq|cut|tr|column",
		"jq|nl|du|df|diff|cmp|awk|seq|date|sleep|true|false|ps|pgrep|basename|dirname|realpath|shasum|whoami|uname",
		"cd|test|\\[|exit|break|continue|wait|read|type|env|printenv|export|set|xargs\\s+(?:rg|grep|ls|cat|wc|head|tail)",
		"git\\s+(?:status|log|diff|show|rev-parse|rev-list|ls-files|ls-tree|ls-remote|blame|grep|describe|merge-base|merge-tree|cat-file|reflog|shortlog|fetch|check-ignore|config\\s+--get)",
		"git\\s+(?:branch|tag|remote|stash\\s+list|worktree\\s+list)(?:\\s+-(?!d\\b|D\\b|m\\b|M\\b|-delete)[\\w-]+)*\\s*$",
		"gh\\s+(?:pr|issue|run|release|repo|workflow|search)\\s+(?:view|list|checks|diff|status|watch|prs|issues|code)",
		"gh\\s+api(?!.*\\s(?:-X|--method|-f|-F|--field|--input)\\b)",
		"herdr\\s+(?:pane\\s+(?:read|get|list)|agent\\s+(?:list|get|status|read|wait)|workspace\\s+list)",
		"npm\\s+(?:test|ls|view|outdated|run\\s+(?:check|test|lint|typecheck))",
		"node\\s+--test|npx\\s+(?:tsc|vitest|jest|biome\\s+(?:check|lint)(?!.*--(?:write|fix)))|tsc|pytest",
		"uv\\s+run\\s+(?:pytest|ruff\\s+check(?!.*--fix)|mypy|pyright)|ruff\\s+check(?!.*--fix)|mypy|pyright",
		"cargo\\s+(?:test|check|clippy)|go\\s+(?:test|vet)",
		"[\\w.-]+(?:\\s+[\\w-]+)*\\s+--(?:help|version)\\s*$",
	].join("|")})(?:\\s|$)`,
);
/** Shell words in front of a command that run nothing themselves, and variables set for it. */
const SHELL_WORD = /^(?:(?:(?:do|then|else|elif|if|while|until|command|time)\b|[!({]|\w+=\S*)\s*)+/;
/** A whole segment that runs no program: the frame of a loop or test, a variable, a comment. */
const RUNS_NOTHING = /^(?:done|fi|do|then|else|[{}()]|for\s+\w+\s+in\b.*|\w+=\S*|#.*)?$/;
/** `git -C <dir>` runs a subcommand elsewhere; where does not decide whether it changes anything. */
const GIT_DIR = /^git\s+-C\s+\S+\s+/;
/** A redirect to a file, or a `find` that deletes files or runs a program. */
const MAY_CHANGE = /(?<![0-9&])>(?!&)(?!\s*\/dev\/null)|[0-9]>(?!&|\s*\/dev\/null)|\s-(?:delete|exec)\b/;
/** A script for an interpreter: on standard input from a here-document, or as an argument. */
const HERE_DOCUMENT = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n[ \t]*\2(?=\n|$)/;
const INLINE_SCRIPT = /\b(?:python3?|node|ruby|perl)\s+-[ce]\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/;
const READS_SCRIPT = /^(?:python3?|node|ruby|perl)(?:\s+-[A-Za-z]+)*\s+-(?:\s|$)|^cat\s*$/;
/** What a script uses to write a file, remove one, start a program, or send a request that changes something. */
const SCRIPT_CHANGES =
	/open\([^)]*,\s*['"][wax+]|\.write\(|write_text|write_bytes|writeFile|appendFile|unlink|rmtree|\.remove\(|rmSync|mkdir|rename|shutil|subprocess|os\.system|child_process|execSync|spawn|requests\.(?:post|put|delete|patch)|method:/;
/** Replaces each match until none is left; undefined when `keep` turns a match down. */
function takeOut(
	text: string | undefined,
	pattern: RegExp,
	keep: (match: RegExpMatchArray) => string | undefined,
): string | undefined {
	if (text === undefined) return undefined;
	let rest = text;
	for (let match = rest.match(pattern); match; match = rest.match(pattern)) {
		const put = keep(match);
		if (put === undefined) return undefined;
		rest = rest.slice(0, match.index) + put + rest.slice((match.index ?? 0) + match[0].length);
	}
	return rest;
}
/**
 * True for a command made only of programs known to change nothing. Any other command may have changed
 * something: a program this list does not name counts as one that did.
 */
function changesNothing(command: string): boolean {
	const scripts: string[] = [];
	const ran: string[] = [];
	// A here-document is text for the program in front of it: its body is no command.
	let rest = takeOut(command.replace(/\\\n/g, " "), HERE_DOCUMENT, (match) => {
		scripts.push(match[4]);
		return ` «${scripts.length - 1}»${match[3]}`;
	});
	rest = takeOut(rest, INLINE_SCRIPT, (match) => (SCRIPT_CHANGES.test(match[1] ?? match[2]) ? undefined : "true"));
	// Nothing runs inside single quotes; a substitution runs a command of its own; double quotes are then text.
	rest = takeOut(rest?.replace(/'[^']*'/g, "q"), /\$\(([^()`]*)\)|`([^`]*)`/, (match) => {
		ran.push(match[1] ?? match[2]);
		return "q";
	})?.replace(/"(?:[^"\\]|\\.)*"/g, "q");
	if (rest === undefined || /\$\(|`|<</.test(rest) || MAY_CHANGE.test(rest)) return false;
	const parts = rest.split(/&&|\|\||[;|\n]/).map((part) =>
		part
			.trim()
			.replace(SHELL_WORD, "")
			.replace(/\s*[)}]+$/, "")
			.replace(GIT_DIR, "git "),
	);
	const harmless = parts.every((part) => {
		const script = part.match(/«(\d+)»/);
		const program = part.replace(/\s*«\d+»/g, "");
		if (script) return READS_SCRIPT.test(program) && !SCRIPT_CHANGES.test(scripts[Number(script[1])]);
		return RUNS_NOTHING.test(program) || CHANGES_NOTHING.test(program);
	});
	return harmless && ran.every(changesNothing);
}

/** `src/a.ts:12` or `src/a.ts:12:5` in output: a place in a file, which a terminal can open. */
const FILE_REFERENCE = /(?<![\w/.-])((?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[a-z]{1,5}):(\d+)(?::\d+)?/g;

/**
 * An output line in its colour, with file references linked where the terminal supports links. Only a failed
 * call marks its error-like lines: in passing output the same words are mostly matches in code, not errors.
 */
function outputLine(line: string, theme: Theme, context: Context): string {
	const paint = (text: string) => theme.fg(context.isError && ERROR_LIKE.test(line) ? "error" : "toolOutput", text);
	if (!getCapabilities().hyperlinks) return paint(line);
	let linked = "";
	let end = 0;
	for (const match of line.matchAll(FILE_REFERENCE)) {
		const url = `${pathToFileURL(resolve(context.cwd, match[1])).href}#L${match[2]}`;
		linked += paint(line.slice(end, match.index)) + hyperlink(paint(match[0]), url);
		end = match.index + match[0].length;
	}
	return linked + paint(line.slice(end));
}
/**
 * Text cut in the middle to fit: a command's start says what ran, its end what came out. Text only a little too
 * long is cut at its end instead, where a few lost characters read more easily.
 */
function middleCut(text: string, room: number): string {
	const over = visibleWidth(text) - room;
	if (over <= 0) return text;
	const chars = [...text];
	const fit = (from: string[], width: number) => {
		let count = 0;
		while (count < from.length && visibleWidth(from.slice(0, count + 1).join("")) <= width) count++;
		return count;
	};
	const right = over < MIDDLE_CUT_MIN ? 0 : fit(chars.toReversed(), Math.floor((room - 1) / 3));
	const end = chars.slice(chars.length - right).join("");
	// Cut by hand: Pi's truncation ends its result with a style reset, which would unstyle the end.
	return `${chars.slice(0, fit(chars, room - 1 - visibleWidth(end))).join("")}…${end}`;
}
/** How many lines a failed command keeps from its end: from the first error-like line among the last twenty. */
function failedTail(output: string[]): number {
	const window = output.slice(-FAILED_LINES);
	const first = window.findIndex((line) => ERROR_LIKE.test(line));
	return Math.min(output.length, Math.max(FAILED_MIN_LINES, first < 0 ? 0 : window.length - first));
}
/** `:60-99` for a read of part of a file. */
function lineRange(args: any): string {
	const offset = typeof args?.offset === "number" ? args.offset : undefined;
	const limit = typeof args?.limit === "number" ? args.limit : undefined;
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	return `:${start}-${limit === undefined ? "" : start + limit - 1}`;
}

const SUMMARIES: Record<string, Summarize> = {
	bash(args, result, theme, context) {
		let command = String(args?.command ?? "...").trim();
		const meta: string[] = [];
		const options = command.match(SHELL_OPTIONS);
		if (options && command.length > options[0].length) command = command.slice(options[0].length);
		const cd = command.match(CD_PREFIX);
		if (cd && command.length > cd[0].length) {
			command = command.slice(cd[0].length);
			const dir = shortPath(cd[1].replace(/^["']|["']$/g, "").replace(/\/$/, ""), context.cwd);
			if (dir !== ".") meta.push(theme.fg("muted", `in ${dir}`));
		}
		const [firstLine, ...rest] = command.split("\n");
		const merged = firstLine.replace(STDERR_MERGE, "");
		const first = (rest.length === 0 && merged.replace(OUTPUT_CAP, "")) || merged;
		const more = rest.length > 0 ? ` ⏎${rest.length}` : "";
		// The prompt is dim so the eye lands on the command.
		const head = (room: number) =>
			theme.fg("dim", "$ ") +
			title(theme, middleCut(first, room - 2 - visibleWidth(more))) +
			theme.fg("muted", more);
		if (!result) return { head, meta };
		const silent = !context.isError && changesNothing(command);
		const output = outputLines(result);
		// Pi ends a failed command's output with this line; the head line carries the code instead.
		const exit = context.isError ? output.at(-1)?.match(/^Command exited with code (\d+)$/)?.[1] : undefined;
		if (exit) output.pop();
		const whole = !context.isError && output.length <= WHOLE_LINES;
		const headCount = whole ? output.length : context.isError ? 0 : HEAD_LINES;
		const tailCount = whole ? 0 : context.isError ? failedTail(output) : TAIL_LINES;
		const hidden = output.length - headCount - tailCount;
		if (exit) meta.push(theme.fg("error", `exit ${exit}`));
		const ms = rowState(context).durationMs ?? 0;
		if (ms >= 1000) meta.push(theme.fg(ms >= SLOW_MS ? "warning" : "muted", formatDuration(ms)));
		const shown = (rows: string[]) => rows.map((line) => outputLine(line, theme, context));
		// The count of skipped lines sits where they were skipped.
		const body = [
			...shown(output.slice(0, headCount)),
			...(hidden > 0 ? [theme.fg("muted", `⋮ ${plural(hidden, "more line")}`)] : []),
			...shown(tailCount > 0 ? output.slice(-tailCount) : []),
		];
		return { head, meta, body, count: output.length, silent };
	},
	read(args, result, theme, context) {
		const head = `${title(theme, "read")} ${filePath(args, theme, context.cwd)}${theme.fg("warning", lineRange(args))}`;
		if (!result) return { head };
		if (context.isError) return { head, body: outputLines(result).map((line) => theme.fg("toolOutput", line)) };
		const blocks = result.content ?? [];
		if (blocks.some((block) => block.type === "image")) return { head, meta: [theme.fg("muted", "image")] };
		const text = blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		// Pi ends a partial read with a bracketed note on how to continue; it is not a line of the file.
		const count = text
			.replace(/\n+\[[^\n]*\]\s*$/, "")
			.trimEnd()
			.split("\n").length;
		return { head, meta: [theme.fg("muted", plural(count, "line"))], silent: true };
	},
	write(args, _result, theme, context) {
		const content = typeof args?.content === "string" ? args.content.trimEnd() : "";
		const size = content ? [theme.fg("muted", plural(content.split("\n").length, "line"))] : [];
		return { head: `${title(theme, "write")} ${filePath(args, theme, context.cwd)}`, meta: size, keep: true };
	},
	edit(args, result, theme, context) {
		const head = `${title(theme, "edit")} ${filePath(args, theme, context.cwd)}`;
		if (!result) return { head };
		// Pi's display diff marks a changed line with a leading "+" or "-".
		const diff: string[] = typeof result.details?.diff === "string" ? result.details.diff.split("\n") : [];
		const changed = diff.filter((line) => line.startsWith("+") || line.startsWith("-"));
		const added = changed.filter((line) => line.startsWith("+")).length;
		const meta = [
			`${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${changed.length - added}`)}`,
		];
		// Pi's diff colours the lines and, where one line replaces one, inverts the words that changed.
		const shown = changed.slice(0, EDIT_LINES);
		const body = shown.length > 0 ? renderDiff(shown.join("\n")).split("\n") : [];
		if (changed.length > shown.length && shown.length > 0)
			body.push(theme.fg("muted", `… +${plural(changed.length - shown.length, "changed line")}`));
		return { head, meta, body, keep: true };
	},
};
/** Tools whose failure Pi draws: it shows what the call tried to change. */
const PI_DRAWS_FAILURE = new Set(["write", "edit"]);

/** A tool with no renderers of its own: its name, its arguments, and how much it returned. */
const plainSummary =
	(toolName: string): Summarize =>
	(args, result, theme, context) => {
		const pairs = Object.entries(args ?? {}).map(
			([key, value]) => `${key}=${typeof value === "string" ? value.split("\n")[0] : JSON.stringify(value)}`,
		);
		const output = outputLines(result);
		// A long result of an unknown tool is counted, not sampled: it is usually a document or JSON.
		const kept = context.isError ? FAILED_LINES : output.length <= WHOLE_LINES ? WHOLE_LINES : 0;
		return {
			head: `${title(theme, toolName)} ${theme.fg("muted", pairs.join(" "))}`,
			body: kept > 0 ? output.slice(-kept).map((line) => theme.fg("toolOutput", line)) : [],
			count: output.length,
		};
	};

function glyph(state: RowState, theme: Theme): string {
	if (!state.result) return theme.fg("accent", "●");
	return state.failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

/** Whole seconds a running call has taken, from one second on: `12s`, then `1m 5s`. */
function elapsed(state: RowState): string | undefined {
	if (state.result || state.startedAt === undefined) return undefined;
	const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
	if (seconds < 1) return undefined;
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The first line of a row: status glyph, what ran, then the facts about its result or how long it has run. */
function headLine(summary: Summary, state: RowState, theme: Theme, context: Context): Component {
	return lines((width) => {
		const pad = " ".repeat(context.outputPad);
		const sep = theme.fg("dim", " · ");
		const running = elapsed(state);
		const unseen = summary.body?.length ? 0 : (summary.count ?? 0);
		const facts = [
			...(unseen > 0 ? [theme.fg("muted", plural(unseen, "line"))] : []),
			...(summary.meta ?? []),
			...(running ? [theme.fg("muted", running)] : []),
		];
		const meta = facts.join(sep);
		const room = Math.max(8, width - context.outputPad * 2 - 2 - (meta ? visibleWidth(meta) + 3 : 0));
		const head = typeof summary.head === "function" ? summary.head(room) : truncateToWidth(summary.head, room, "…");
		const line = `${pad}${glyph(state, theme)} ${head}${meta ? sep : ""}${meta}`;
		return [summary.quiet ? theme.fg("dim", stripVTControlCharacters(line)) : line];
	});
}
/** A line cut to one row, or to two when it reads like an error: the message is usually at its end. */
function fitted(line: string, room: number): string[] {
	if (visibleWidth(line) <= room || !ERROR_SHAPE.test(stripVTControlCharacters(line)))
		return [truncateToWidth(line, room, "…")];
	const [first, ...rest] = wrapTextWithAnsi(line, room);
	return [first, truncateToWidth(rest.join(" "), room, "…")];
}
/**
 * A component's lines under the head line, behind a bar in the glyph's column: red when the call failed.
 * A failure's lines wrap, so no part of an error is cut off.
 */
function indented(child: Component | string[], state: RowState, theme: Theme, context: Context): Component {
	return lines((width) => {
		const indent = `${" ".repeat(context.outputPad)}${theme.fg(state.failed ? "error" : "dim", "│")} `;
		const room = Math.max(8, width - visibleWidth(indent) - context.outputPad);
		const rows = Array.isArray(child)
			? child.flatMap((line) => (state.failed ? wrapTextWithAnsi(line, room) : fitted(line, room)))
			: child.render(room).filter((line) => stripVTControlCharacters(line).trim());
		return rows.map((line) => indent + line);
	});
}
/** A component with the glyph in front of its first line, for a tool that draws its own call. */
function glyphed(child: Component, state: RowState, theme: Theme, context: Context): Component {
	return lines((width) => {
		const pad = " ".repeat(context.outputPad);
		const rows = child.render(Math.max(8, width - context.outputPad * 2 - 2));
		return rows.map((line, index) => `${pad}${index === 0 ? glyph(state, theme) : " "} ${line}`);
	});
}
/** Half of the shell Pi draws around a tool: the status background, with a blank line on the outer edge. */
function piShell(child: Component, theme: Theme, context: Context, edge: "top" | "bottom"): Component {
	return {
		invalidate: () => child.invalidate(),
		render(width) {
			const background = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
			const pad = " ".repeat(context.outputPad);
			const paint = (line: string) =>
				theme.bg(background, line + " ".repeat(Math.max(0, width - visibleWidth(line))));
			const rows = child.render(Math.max(1, width - context.outputPad * 2)).map((line) => paint(pad + line));
			return edge === "top" ? [paint(""), ...rows] : [...rows, paint("")];
		},
	};
}

/**
 * Collapsed, a row is a glyph line and a few indented lines, with no background. Expanded it is Pi's own rendering,
 * as is a failure Pi draws. Pi's renderers always run, to keep their timers and previews current.
 */
function compactRenderers(
	toolName: string,
	pi: ToolRenderers | undefined,
	summarize: Summarize | undefined,
): ToolRenderers {
	const framed = pi?.renderShell !== "self";
	const showsPi = (context: Context) => context.expanded || (context.isError && PI_DRAWS_FAILURE.has(toolName));
	const fallback = summarize ?? plainSummary(toolName);
	// A tool that draws its own call is left on screen while it runs: it may show progress no summary has.
	const drawsOwn = !summarize && pi?.renderCall !== undefined;
	if (drawsOwn) drawsOwnRow.add(toolName);
	/**
	 * The row's summary: without its output once a later step followed a call that succeeded, or a failed
	 * command passed on a later run.
	 */
	const summary = (args: any, state: RowState, theme: Theme, context: Context): Summary => {
		if (!state.result) return fallback(args, undefined, theme, context);
		state.summary ??= fallback(args, state.result, theme, context);
		const full = state.summary;
		if (state.failed) {
			if (!passedLater(context.toolCallId)) return full;
			return { ...full, body: [], meta: [...(full.meta ?? []), "passed later"], count: 0, quiet: true };
		}
		return !full.keep && superseded(context.toolCallId) ? { ...full, body: [] } : full;
	};
	/**
	 * True while the call shows only in the live area: nothing has followed its step yet. A failure, a write and
	 * an edit are not held back once they end.
	 */
	const held = (args: any, state: RowState, theme: Theme, context: Context): boolean => {
		if (drawsOwn || showsPi(context) || !unsettled(context.toolCallId)) return false;
		return !state.result || !(state.failed || summary(args, state, theme, context).keep);
	};
	/** Pi updated the row: what was kept from its last state is stale. */
	const refresh = (state: RowState, context: Context) => {
		state.summary = undefined;
		state.headLine = undefined;
		state.bodyLines = undefined;
		state.expanded = context.expanded;
	};
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = rowState(context);
			refresh(state, context);
			state.piCall = pi?.renderCall?.(args, theme, { ...context, lastComponent: state.piCall });
			if (showsPi(context)) {
				const full =
					state.piCall ??
					lines((width) =>
						wrapTextWithAnsi(
							`${title(theme, toolName)}\n${theme.fg("muted", JSON.stringify(args, null, 2))}`,
							width,
						),
					);
				return framed ? piShell(full, theme, context, "top") : full;
			}
			if (!summarize && state.piCall) return glyphed(state.piCall, state, theme, context);
			const head = (width: number) => {
				const drawn = summary(args, state, theme, context);
				if (!state.result) return headLine(drawn, state, theme, context).render(width);
				const key = `${width} ${drawn.body?.length ?? 0} ${drawn.quiet} ${drawn.meta?.length}`;
				if (state.headLine?.key !== key)
					state.headLine = { key, rows: headLine(drawn, state, theme, context).render(width) };
				return state.headLine.rows;
			};
			const id = context.toolCallId;
			const folded = () =>
				!state.expanded &&
				state.result !== undefined &&
				!state.result.content?.some((block) => block.type === "image") &&
				!summary(args, state, theme, context).body?.length &&
				superseded(id);
			transcript.rows.set(id, {
				head,
				command: toolName === "bash" ? String((args as any)?.command ?? "").trim() : undefined,
				folded,
				silent: () => folded() && summary(args, state, theme, context).silent === true,
			});
			const tally = (count: number) =>
				`${" ".repeat(context.outputPad)}${theme.fg("dim", `⋮ ${plural(count, "call")}`)}`;
			return lines((width) => {
				if (held(args, state, theme, context)) return [];
				const call = foldedRow(transcript.calls.get(id));
				if (!call) return head(width);
				// A folded row followed by another in its block draws nothing: the last row of the run draws them all.
				return closesUp(call, transcript.order[call.index + 1]) ? [] : foldedRun(call, width, tally);
			});
		},
		renderResult(result, options, theme, context) {
			const state = rowState(context);
			state.result = options.isPartial ? undefined : result;
			state.failed = context.isError;
			state.durationMs = context.durationMs;
			refresh(state, context);
			const command = transcript.rows.get(context.toolCallId)?.command;
			if (command !== undefined && state.result && !state.failed) {
				const passed = transcript.passed.get(command) ?? new Set();
				transcript.passed.set(command, passed.add(context.toolCallId));
			}
			state.piResult = pi?.renderResult?.(result, options, theme, { ...context, lastComponent: state.piResult });
			if (showsPi(context)) {
				const full =
					state.piResult ??
					lines((width) =>
						wrapTextWithAnsi(
							outputLines(result)
								.map((line) => theme.fg("toolOutput", line))
								.join("\n"),
							width,
						),
					);
				return framed ? piShell(full, theme, context, "bottom") : full;
			}
			// Running output, and the result of a tool that draws its own, are Pi's lines without the box.
			if (state.piResult && (options.isPartial || !summarize)) {
				const partial = indented(state.piResult, state, theme, context);
				return lines((width) => (held(context.args, state, theme, context) ? [] : partial.render(width)));
			}
			return lines((width) => {
				if (held(context.args, state, theme, context)) return [];
				const body = summary(context.args, state, theme, context).body ?? [];
				if (body.length === 0) return [];
				const key = `${width} ${body.length}`;
				if (state.bodyLines?.key !== key)
					state.bodyLines = { key, rows: indented(body, state, theme, context).render(width) };
				return state.bodyLines.rows;
			});
		},
	};
}

export default function (pi: ExtensionAPI) {
	const reload = (_event: unknown, ctx: { isIdle(): boolean; sessionManager: { getBranch(): any[] } }) => {
		resetTranscript();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			startMessage(entry.message);
			noteMessage(entry.message);
		}
		// With no run under way, nothing more follows the last step.
		if (ctx.isIdle()) settle(transcript.turn);
		// Rows of the session that was left are dropped; rows this session drew before the event are kept.
		for (const id of transcript.rows.keys()) if (!transcript.calls.has(id)) transcript.rows.delete(id);
		for (const [command, ids] of transcript.passed) {
			for (const id of ids) if (!transcript.calls.has(id)) ids.delete(id);
			if (ids.size === 0) transcript.passed.delete(command);
		}
	};
	pi.on("session_start", reload);
	pi.on("session_tree", reload);
	pi.on("session_compact", reload);
	pi.on("message_start", (event) => startMessage(event.message));
	pi.on("message_update", (event) => noteMessage(event.message));
	pi.on("message_end", (event) => noteMessage(event.message));

	let run = newRun();
	/** Redraws the live area; unset while the receipt or nothing is shown. */
	let redraw: (() => void) | undefined;
	pi.on("agent_start", (_event, ctx) => {
		run = newRun();
		if (ctx.hasUI) ctx.ui.setWidget(AREA, undefined);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		run.tried.set(event.toolCallId, attempt(event.toolName, event.args));
		// A call made by another tool, such as a codemode script, shows inside that tool's row.
		if (event.parentToolCallId) return;
		run.calls++;
		run.shown.set(event.toolCallId, {
			toolName: event.toolName,
			args: event.args,
			startedAt: Date.now(),
			output: [],
		});
		if (redraw || !ctx.hasUI || drawsOwnRow.has(event.toolName)) return redraw?.();
		const shown = run;
		ctx.ui.setWidget(AREA, (tui, theme) => {
			redraw = () => tui.requestRender();
			// Keeps the time of a running call current. Unreferenced: it must not keep the process alive.
			const clock = setInterval(redraw, 1000).unref();
			return {
				invalidate() {},
				render: (width) => liveArea(shown, theme, ctx.cwd, width),
				dispose() {
					clearInterval(clock);
					redraw = undefined;
				},
			};
		});
	});
	pi.on("tool_execution_update", (event) => {
		const call = run.shown.get(event.toolCallId);
		if (!call) return;
		call.output = outputLines(event.partialResult).slice(-AREA_LINES);
		redraw?.();
	});
	pi.on("tool_execution_end", (event) => {
		const call = run.shown.get(event.toolCallId);
		if (call)
			Object.assign(call, { result: event.result ?? {}, failed: event.isError, durationMs: event.durationMs });
		redraw?.();
		const tried = run.tried.get(event.toolCallId) ?? event.toolCallId;
		if (event.isError) {
			run.open.add(tried);
			return;
		}
		run.open.delete(tried);
		if (event.toolName === "edit" || event.toolName === "write") run.changed.add(tried.slice(tried.indexOf(" ") + 1));
	});
	pi.on("agent_end", (_event, ctx) => {
		// Nothing more follows the last step, also when the run was stopped.
		settle(transcript.turn);
		if (!ctx.hasUI) return;
		const line = receipt(run, ctx.ui.theme);
		ctx.ui.setWidget(AREA, line ? [line] : undefined);
	});
	pi.registerToolRenderer((toolName, next) => {
		const renderers = next();
		// A tool that draws its own shell keeps it, unless its row has a summary here.
		if (renderers?.renderShell === "self" && !SUMMARIES[toolName]) {
			drawsOwnRow.add(toolName);
			return renderers;
		}
		return compactRenderers(toolName, renderers, SUMMARIES[toolName]);
	});
}
