/**
 * Short rows for finished tool calls while tool output is collapsed. A row is one line (a status glyph, what ran,
 * then facts about the result) and a few indented output lines, with no background box.
 *
 * The numbers below were picked by replaying 40 past sessions through Pi's row component and by checking which
 * lines a reader needs: the first output line often carries the answer or a table header, the last ones the result.
 *
 * A finished call keeps its output on screen only while it is the newest step. Once the model calls another tool
 * the row folds to its first line, and folded rows that follow each other close up into one block. Failures, the
 * changed lines of an edit, and the last step before a reply stay: that step is usually the check the reply
 * rests on, and folding it later would redraw a screen the reader has already scrolled past.
 *
 * A folded row is dim when the call only looked something up, so the rows left at full weight are the ones that
 * changed something. A failed command folds too, and dims, once the same command passes later.
 *
 * When the agent stops, one line above the editor sums up the run: failures still open, files changed, calls, time.
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
	/** The call only looked something up: its folded row is dim. */
	lookup?: boolean;
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
	/** When the call started running, and the redraw that keeps its elapsed time current until it settles. */
	startedAt?: number;
	clock?: ReturnType<typeof setInterval>;
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
	/** True when the row is one folded line, so it can close up with the rows around it. */
	folded: () => boolean;
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
	textSeen: false,
};
function resetTranscript(): void {
	transcript.calls.clear();
	transcript.newest.clear();
	Object.assign(transcript, { order: [], turn: 0, block: 0, run: 0, textSeen: false });
}
function startMessage(message: any): void {
	if (message?.role === "user") {
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
		if (block.type === "text" && block.text?.trim() && !transcript.textSeen) {
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
/** A folded row followed by another in its block draws nothing: the last row of the run draws them all. */
function drawnByNext(toolCallId: string): boolean {
	const call = foldedRow(transcript.calls.get(toolCallId));
	return call !== undefined && closesUp(call, transcript.order[call.index + 1]);
}
/** The first lines of the folded rows that close up above this one. */
function runAbove(toolCallId: string, width: number): string[] {
	const call = foldedRow(transcript.calls.get(toolCallId));
	const rows: string[] = [];
	for (let at = (call?.index ?? 0) - 1; call && at >= 0 && closesUp(call, transcript.order[at]); at--)
		rows.unshift(...(transcript.rows.get(transcript.order[at].id)?.head(width) ?? []));
	return rows;
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

/** What one run did, from the prompt to the agent stopping. */
interface Run {
	startedAt: number;
	calls: number;
	changed: Set<string>;
	/** Failed calls by what they tried, dropped when the same thing later succeeds. */
	open: Set<string>;
	tried: Map<string, string>;
}
const RECEIPT = "compact-tools-receipt";
const newRun = (): Run => ({ startedAt: Date.now(), calls: 0, changed: new Set(), open: new Set(), tried: new Map() });
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

/** `cd <dir>` in front of a command says where it ran, not what it did. */
const CD_PREFIX = /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;|\n)\s*/;
/** Plumbing that shapes a command's output for the model and tells a reader nothing about what ran. */
const SHELL_OPTIONS = /^set\s+[-+][a-z]+(?:\s+pipefail)?\s*(?:&&|;|\n)\s*/;
const STDERR_MERGE = /\s+2>&1(?=\s|$)/g;
const OUTPUT_CAP = /\s*\|\s*(?:tail|head)(?:\s+-n?\s*\d+)?\s*$/;

/** Commands that read and change nothing; a command line made only of these is a lookup. */
const READS =
	/^(?:command\s+)?(?:rg|grep|ls|cat|head|tail|sed\s+-n|find|fd|wc|tree|stat|file|which|pwd|echo|sort|uniq|cut|tr|column|jq|nl|du|diff|git\s+(?:status|log|diff|show|branch|rev-parse|ls-files|blame|grep))(?:\s|$)/;
const WRITES = />(?!&|\s*\/dev\/null)|\s-(?:delete|exec)\b|\$\(|`/;
function isLookup(command: string): boolean {
	if (command.includes("\n") || WRITES.test(command)) return false;
	return command.split(/&&|\|\||[;|]/).every((part) => READS.test(part.trim()));
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
		const lookup = isLookup(command);
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
		return { head, meta, body, count: output.length, lookup };
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
		return { head, meta: [theme.fg("muted", plural(count, "line"))], lookup: true };
	},
	write(args, _result, theme, context) {
		const content = typeof args?.content === "string" ? args.content.trimEnd() : "";
		const size = content ? [theme.fg("muted", plural(content.split("\n").length, "line"))] : [];
		return { head: `${title(theme, "write")} ${filePath(args, theme, context.cwd)}`, meta: size };
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

/** Starts the row's clock when the call starts running, and stops it once the call has its final result. */
function keepTime(state: RowState, context: Context): void {
	if (state.result) {
		clearInterval(state.clock);
		state.clock = undefined;
	} else if (context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		// Unreferenced: a call that never settles must not keep the process alive.
		state.clock = setInterval(() => context.invalidate(), 1000).unref();
	}
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
 * A failure's lines wrap, so no part of an error is cut off. The head line shows a running call's time, so Pi's
 * own `Elapsed` line is dropped.
 */
function indented(child: Component | string[], state: RowState, theme: Theme, context: Context): Component {
	return lines((width) => {
		const indent = `${" ".repeat(context.outputPad)}${theme.fg(state.failed ? "error" : "dim", "│")} `;
		const room = Math.max(8, width - visibleWidth(indent) - context.outputPad);
		const rows = Array.isArray(child)
			? child.flatMap((line) => (state.failed ? wrapTextWithAnsi(line, room) : fitted(line, room)))
			: child.render(room).filter((line) => !/^(Elapsed \d.*)?$/.test(stripVTControlCharacters(line).trim()));
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
		return !full.keep && superseded(context.toolCallId) ? { ...full, body: [], quiet: full.lookup } : full;
	};
	/** Pi updated the row: what was kept from its last state is stale. */
	const refresh = (state: RowState, context: Context) => {
		state.summary = undefined;
		state.headLine = undefined;
		state.bodyLines = undefined;
		state.expanded = context.expanded;
		keepTime(state, context);
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
			transcript.rows.set(id, {
				head,
				command: toolName === "bash" ? String((args as any)?.command ?? "").trim() : undefined,
				folded: () =>
					!state.expanded &&
					state.result !== undefined &&
					!state.result.content?.some((block) => block.type === "image") &&
					!summary(args, state, theme, context).body?.length &&
					superseded(id),
			});
			return lines((width) => (drawnByNext(id) ? [] : [...runAbove(id, width), ...head(width)]));
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
			if (state.piResult && (options.isPartial || !summarize))
				return indented(state.piResult, state, theme, context);
			return lines((width) => {
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
	const reload = (_event: unknown, ctx: { sessionManager: { getBranch(): any[] } }) => {
		resetTranscript();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			startMessage(entry.message);
			noteMessage(entry.message);
		}
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
	pi.on("agent_start", (_event, ctx) => {
		run = newRun();
		if (ctx.hasUI) ctx.ui.setWidget(RECEIPT, undefined);
	});
	pi.on("tool_execution_start", (event) => {
		run.tried.set(event.toolCallId, attempt(event.toolName, event.args));
		if (!event.parentToolCallId) run.calls++;
	});
	pi.on("tool_execution_end", (event) => {
		const tried = run.tried.get(event.toolCallId) ?? event.toolCallId;
		if (event.isError) {
			run.open.add(tried);
			return;
		}
		run.open.delete(tried);
		if (event.toolName === "edit" || event.toolName === "write") run.changed.add(tried.slice(tried.indexOf(" ") + 1));
	});
	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const line = receipt(run, ctx.ui.theme);
		ctx.ui.setWidget(RECEIPT, line ? [line] : undefined);
	});
	pi.registerToolRenderer((toolName, next) => {
		const renderers = next();
		// A tool that draws its own shell keeps it, unless its row has a summary here.
		if (renderers?.renderShell === "self" && !SUMMARIES[toolName]) return renderers;
		return compactRenderers(toolName, renderers, SUMMARIES[toolName]);
	});
}
