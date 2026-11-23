/**
 * Short rows for tool calls while tool output is collapsed. The transcript shows what was done, not what came
 * back: a row is one line with a status glyph, what ran, and facts about the result such as its line count.
 * Only a failure shows output, the end of it, because that is what the reader has to act on.
 *
 * A live area above the editor holds what is happening now. While the agent works, a call shows only there,
 * with the time a running one has taken and the end of its output; it leaves the area when its row enters the
 * transcript. A row enters the transcript once the next step shows what became of it:
 *
 * - Followed by another step, a call known to change nothing (a lookup, or a check that passed) keeps no line;
 *   those that open a stretch of work are one count. Any other call keeps its line, as does a passing run of
 *   a command that failed before: it shows how the failure ended.
 * - Followed by text, a call keeps its line, also a lookup: it is usually the check the reply rests on. The
 *   line stays when more steps follow that text: a line once drawn is not taken back, since changing a row
 *   that has scrolled away makes Pi repaint the whole screen.
 * - A failure, a write and an edit show as soon as the call ends, and stay. A failed command loses its output,
 *   and dims, once the same command passes later.
 *
 * One-line rows that follow each other close up into one block. When the agent stops, the live area becomes one
 * line that sums up the run: failures still open, files changed, calls, time.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	getCapabilities,
	hyperlink,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** A failed call keeps its end from the first line that reads like an error, looking this far back. */
const FAILED_LINES = 20;
/** A failed call with no such line keeps this many, which is also the least a failed call keeps. */
const FAILED_MIN_LINES = 5;
/** The most lines a failed call shows. An end longer than this shows only its error-like lines, each once. */
const FAILED_SHOWN = 8;
/** The most screen rows one line of a failed call takes. */
const FAILED_LINE_ROWS = 2;
const ERROR_LIKE =
	/error|fail|✖|✗|not found|no such|denied|cannot|exception|traceback|fatal|panic|refused|invalid|unexpected/i;
/** A line that reports something passing, though it holds an error-like word: `✔ cannot be empty`, `fail 0`. */
// A count of none ends there: `Error: 0 is not a valid port` reports no pass.
const PASSING =
	/^\s*(?:✔|✓|ok\b|PASS\b)|\b(?:fail(?:ed|ures?|ing)?|errors?)\s*(?:[:=]\s*)?0\b(?![.\d]|\s+\w)|\b0\s+(?:fail|error)/;
const errorLike = (line: string) => ERROR_LIKE.test(line) && !PASSING.test(line);
/** A line that gives the values of a failed comparison, or pytest's `E ` line: what went wrong, without an error-like word. */
const COMPARED = /^\s*(?:[-+]\s*)?(?:expected|actual|received|got|want)\b|^E\s/i;
/** A cut in the middle of a command must save at least this many columns over a cut at its end. */
const MIDDLE_CUT_MIN = 8;
/** A command that ran this long shows its duration as a warning. */
const SLOW_MS = 30_000;
type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];

/** One collapsed row: `head` after the status glyph, `meta` at the end of that line, `body` lines below a failure. */
interface Summary {
	/** A function gets the columns it may fill, for a head that shortens itself. */
	head: string | ((room: number) => string);
	meta?: string[];
	body?: string[];
	/** The directory a command ran in, short; unset for the working directory. */
	place?: string;
	/** Lines of output the call returned: a row that shows none of them says how many there were. */
	count?: number;
	/** The row shows as soon as the call ends: the call changed a file, or Pi draws an image under it. */
	keep?: boolean;
	/** The call is known to change nothing: once folded it keeps no line of its own. */
	silent?: boolean;
	/** Set on a folded row that no longer needs attention: the whole line is dim. */
	quiet?: boolean;
	/** The call passed, but its exit code speaks only for its last statement: the glyph is `?`, not `✓`. */
	unproven?: boolean;
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
	/** The row's summary and its drawn first line, kept until Pi next updates the row: Pi draws every row on every frame. */
	summary?: Summary;
	headLine?: { key: string; rows: string[] };
	bodyLines?: { key: string; rows: string[] };
	/** How many lines the row's two parts drew last. */
	callRows?: number;
	resultRows?: number;
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
	name: string;
	/** An estimate, never too low, of the lines of text the session had before the call. */
	textAbove: number;
	/** The call was in the session when it was loaded, so its row was first drawn with all that followed it. */
	loaded: boolean;
}
/** The working directory, as a row names it. */
const HERE = ".";
/** What a drawn row tells its neighbours. */
interface Row {
	/** True when the row is one line or none, so it can close up with the rows around it. */
	folded: () => boolean;
	/** True when the row keeps no line: it is counted with the silent rows next to it. */
	silent: () => boolean;
	head: (width: number) => string[];
	/** The command a `bash` row ran, as `sameCommand` has it: a failure is settled once the same command passes. */
	command?: string;
	/** Where that command ran, as the row names it. */
	place: () => string;
	/** True for a finished call whose row does not wait for the next step: a failure, a write, an edit. */
	atOnce: () => boolean;
	/** The lines the row takes on screen, the blank one above it included; unknown while Pi draws it. */
	height: () => number;
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
	/** The calls that ran each command and passed, and those that ran it and failed. */
	passed: new Map<string, Set<string>>(),
	failed: new Map<string, Set<string>>(),
	turn: 0,
	block: 0,
	run: 0,
	/** The newest turn with a call, by run. */
	newest: new Map<number, number>(),
	/** The last turn whose calls have their place in the transcript; later calls show only in the live area. */
	settled: 0,
	/** Turns whose calls were followed by text: their rows were drawn with a line each, and keep it. */
	spoken: new Set<number>(),
	textSeen: false,
	/** Estimated lines of text before the current message, and up to where that message stands. */
	textBefore: 0,
	textSoFar: 0,
	/** Failed calls whose command passed later, and whether their row gave up its output for it. */
	shrunk: new Map<string, boolean>(),
	/** The newest turn whose message is complete: every call of it is known. */
	closed: 0,
};
function resetTranscript(): void {
	transcript.calls.clear();
	transcript.newest.clear();
	transcript.spoken.clear();
	transcript.shrunk.clear();
	Object.assign(transcript, { order: [], turn: 0, block: 0, run: 0, settled: 0, textSeen: false });
	Object.assign(transcript, { textBefore: 0, textSoFar: 0, closed: 0 });
}
/** Columns a line of text is taken to wrap at when its height is estimated: narrower than any real pane. */
const NARROW = 40;
/** The lines a block of text may take on screen: two for each line of source, so a table's rules are covered. */
const textHeight = (text: unknown) =>
	typeof text === "string" && text.trim()
		? text.split("\n").reduce((rows, line) => rows + 2 + Math.floor(line.length / NARROW), 2)
		: 0;
function startMessage(message: any): void {
	transcript.textBefore = transcript.textSoFar;
	if (message?.role === "user") {
		const said = Array.isArray(message.content) ? message.content.map((block: any) => block.text) : [message.content];
		transcript.textBefore += said.reduce((rows: number, text: unknown) => rows + textHeight(text), 0);
		transcript.textSoFar = transcript.textBefore;
		settle(transcript.turn);
		transcript.run++;
		transcript.block++;
	} else if (message?.role === "assistant") {
		transcript.turn++;
		transcript.textSeen = false;
	}
}
/** Takes in an assistant message as it stands; called again as the message streams in. */
function noteMessage(message: any, loaded = false): void {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
	let textAbove = transcript.textBefore;
	for (const block of message.content) {
		const text = block.type === "text" && block.text?.trim();
		textAbove += textHeight(block.type === "text" ? block.text : block.thinking);
		transcript.textSoFar = textAbove;
		// The message's first text or call shows what became of the step before it. After text the step shows
		// with its output, and folds if a call follows after all.
		if (text || block.type === "toolCall") settle(transcript.turn - 1);
		if (text && !transcript.textSeen) {
			// Text that comes before any call of its message is what the reader saw the step before it end on.
			if (transcript.newest.get(transcript.run) !== transcript.turn) transcript.spoken.add(transcript.turn - 1);
			transcript.textSeen = true;
			transcript.block++;
		}
		if (block.type !== "toolCall" || transcript.calls.has(block.id)) continue;
		const { turn, run } = transcript;
		const call = {
			id: block.id,
			index: transcript.order.length,
			turn,
			run,
			block: transcript.block,
			name: block.name,
			textAbove,
			loaded,
		};
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
/** Tools whose row has a summary here or Pi's own lines behind a glyph: never in the live area. */
const drawsOwnRow = new Set<string>();
/**
 * Tools that draw their own shell: their renderers are passed on. The line such a call draws is a heading
 * for the calls of its message, as the `plan` tool's step is, so the first row of the message draws it.
 */
const ownShell = new Set<string>();
/** The call component of each such call, and the lines its call and result drew last: a tool may draw none. */
const ownCalls = new Map<string, Component>();
const ownLines = new Map<string, { call?: number; result?: number }>();
/** Columns a part is drawn at to learn whether it has lines at all, before the screen draws it. */
const PROBE_WIDTH = 80;
/**
 * A component that notes how many lines one part of a call's row has. It is drawn once at once: the rows
 * above it are drawn first on each frame, and must already know whether this one shows. With `elsewhere`
 * true its lines are another row's to draw.
 */
function counted(
	inner: Component,
	toolCallId: string,
	part: "call" | "result",
	elsewhere = () => false,
): Component & { inner: Component } {
	ownLines.set(toolCallId, { ...ownLines.get(toolCallId), [part]: inner.render(PROBE_WIDTH).length });
	return {
		inner,
		invalidate: () => inner.invalidate(),
		render(width) {
			const drawn = inner.render(width);
			ownLines.set(toolCallId, { ...ownLines.get(toolCallId), [part]: drawn.length });
			return elsewhere() ? [] : drawn;
		},
	};
}
/** The first call of the message that has a row of this module's: it draws the message's headings. */
function carrier(call: Call): Call | undefined {
	let at = call.index;
	while (transcript.order[at - 1]?.turn === call.turn) at--;
	for (; transcript.order[at]?.turn === call.turn; at++)
		if (!ownShell.has(transcript.order[at].name)) return transcript.order[at];
	return undefined;
}
/**
 * True when the call line of a tool with its own shell is not drawn at the call's place: another row draws
 * it, or the message is still coming in and may yet bring that row.
 */
function drawnElsewhere(toolCallId: string): boolean {
	const call = transcript.calls.get(toolCallId);
	return call !== undefined && (call.turn > transcript.closed || carrier(call) !== undefined);
}
/** True for a call that has lines at its own place, without this module holding them back. */
function showsOwn(call: Call): boolean {
	const drawn = ownLines.get(call.id);
	if ((drawn?.result ?? 0) > 0) return true;
	return (drawn?.call ?? 0) > 0 && !(ownShell.has(call.name) && drawnElsewhere(call.id));
}
/** True for a call that leaves nothing at its place: its row is empty, or another row draws its line. */
const placeless = (call: Call) => ownShell.has(call.name) && !showsOwn(call);
/** The headings a row draws above its line: the call lines of the tools with their own shell in its message. */
function headings(call: Call | undefined, width: number): string[] {
	if (!call || !hasHeading(call)) return [];
	let at = call.index;
	while (transcript.order[at - 1]?.turn === call.turn) at--;
	const drawn: string[] = [];
	for (; transcript.order[at]?.turn === call.turn; at++)
		if (ownShell.has(transcript.order[at].name))
			drawn.push(...(ownCalls.get(transcript.order[at].id)?.render(width) ?? []));
	return drawn;
}
/** True when the row draws a heading above its line. Asked for every row on every frame, so nothing is drawn. */
function hasHeading(call: Call): boolean {
	if (call.turn > transcript.closed || carrier(call) !== call) return false;
	let at = call.index;
	while (transcript.order[at - 1]?.turn === call.turn) at--;
	for (; transcript.order[at]?.turn === call.turn; at++)
		if (ownShell.has(transcript.order[at].name) && (ownLines.get(transcript.order[at].id)?.call ?? 0) > 0)
			return true;
	return false;
}
/** A row with its message's headings above it. */
function headed(child: Component, toolCallId: string): Component {
	return {
		invalidate: () => child.invalidate(),
		render: (width) => [...headings(transcript.calls.get(toolCallId), width), ...child.render(width)],
	};
}
/** The nearest call above or below that has a place in the transcript. */
function neighbour(call: Call, step: 1 | -1): Call | undefined {
	let at = call.index + step;
	while (transcript.order[at] && placeless(transcript.order[at])) at += step;
	return transcript.order[at];
}
/**
 * True when a later call of the same message already shows. The call then shows too, also while it still
 * runs, and keeps its line: a line added above a drawn row moves it, and Pi repaints the whole screen when
 * that row has scrolled away.
 */
function overtaken(toolCallId: string): boolean {
	const call = transcript.calls.get(toolCallId);
	if (!call) return false;
	for (let at = call.index + 1; transcript.order[at]?.turn === call.turn; at++) {
		const later = transcript.order[at];
		// A tool that draws its own row draws it as soon as it is called, if it draws one at all.
		if (showsOwn(later) || transcript.rows.get(later.id)?.atOnce()) return true;
	}
	return false;
}
/**
 * True once another step followed the call with no text in between: a call of the next message. A step that
 * text followed was drawn with its line, and a line once drawn stays, so a later call does not count.
 */
function superseded(toolCallId: string): boolean {
	const call = transcript.calls.get(toolCallId);
	if (!call || transcript.spoken.has(call.turn)) return false;
	return call.turn < (transcript.newest.get(call.run) ?? 0);
}
/** Lines below the transcript that the screen also holds: the status line, the live area, the editor, the footer. */
const BELOW_TRANSCRIPT = 14;
/**
 * True when the call's row and all that follows it surely fit on the screen, so the row can change without
 * Pi repainting. Text is estimated high; a row Pi draws itself counts as too far, and one not drawn yet as
 * nothing. Messages of other roles are not counted, which the room left below the transcript has to cover.
 */
function onScreen(call: Call): boolean {
	let rows = transcript.textSoFar - call.textAbove + BELOW_TRANSCRIPT;
	for (const later of transcript.order.slice(call.index)) {
		if (placeless(later)) continue;
		rows += transcript.rows.get(later.id)?.height() ?? Number.POSITIVE_INFINITY;
	}
	// Without a terminal there is no screen to repaint.
	return rows <= (process.stdout.rows ?? Number.POSITIVE_INFINITY);
}
/**
 * True for a failed command that a later call ran again and passed, when its row gives up its output for
 * that. It does when it is still on screen as the pass comes in, or when the session was loaded with the
 * pass in it; a row that has scrolled away stays as it was drawn. Decided once.
 */
function passedLater(toolCallId: string): boolean {
	const decided = transcript.shrunk.get(toolCallId);
	if (decided !== undefined) return decided;
	const call = transcript.calls.get(toolCallId);
	const command = transcript.rows.get(toolCallId)?.command;
	if (!call || command === undefined) return false;
	for (const id of transcript.passed.get(command) ?? []) {
		const pass = transcript.calls.get(id);
		if (!pass || pass.index <= call.index) continue;
		transcript.shrunk.set(toolCallId, pass.loaded || onScreen(call));
		return transcript.shrunk.get(toolCallId) === true;
	}
	return false;
}
/** True for a command an earlier call ran and failed: this run of it is the one that shows how that ended. */
function failedBefore(toolCallId: string): boolean {
	const call = transcript.calls.get(toolCallId);
	const command = transcript.rows.get(toolCallId)?.command;
	if (!call || command === undefined) return false;
	for (const part of proved(command))
		for (const id of transcript.failed.get(part) ?? [])
			if ((transcript.calls.get(id)?.index ?? call.index) < call.index) return true;
	return false;
}
/**
 * The directory a command row names: none when the command row above it ran in the same place. The first
 * command row of a run names any directory but the working one.
 */
function placeNamed(toolCallId: string): string | undefined {
	const call = transcript.calls.get(toolCallId);
	const row = transcript.rows.get(toolCallId);
	if (row?.command === undefined) return undefined;
	const place = row.place();
	if (!call) return place === HERE ? undefined : place;
	for (let at = call.index - 1; at >= 0 && transcript.order[at].run === call.run; at--) {
		const above = transcript.rows.get(transcript.order[at].id);
		if (above?.command === undefined || above.silent()) continue;
		return above.place() === place ? undefined : place;
	}
	return place === HERE ? undefined : place;
}
const foldedRow = (call: Call | undefined) => (call && transcript.rows.get(call.id)?.folded() ? call : undefined);
/** True when two folded rows, one above the other, are drawn as one run. A row with a heading starts its own. */
const joins = (above: Call | undefined, below: Call | undefined): boolean =>
	above !== undefined &&
	below !== undefined &&
	above.block === below.block &&
	foldedRow(above) !== undefined &&
	foldedRow(below) !== undefined &&
	!hasHeading(below);
/**
 * The lines of the run of folded rows that ends with this one: a line for each row that keeps one. Rows that
 * keep none are one count when they open their block or stand under a heading, so a stretch of work always
 * leaves a trace, and the count stays when rows with lines follow it.
 */
function foldedRun(call: Call, width: number, tally: (count: number) => string): string[] {
	const run = [call];
	for (let above = neighbour(call, -1); above && joins(above, run[0]); above = neighbour(above, -1))
		run.unshift(above);
	const rows = run.map(({ id }) => transcript.rows.get(id));
	const heading = headings(run[0], width);
	const opensBlock = neighbour(run[0], -1)?.block !== call.block || heading.length > 0;
	const firstKept = rows.findIndex((row) => !row?.silent());
	const leading = opensBlock ? (firstKept < 0 ? rows.length : firstKept) : 0;
	const drawn = rows.flatMap((row) => (row?.silent() ? [] : (row?.head(width) ?? [])));
	return [...heading, ...(leading > 0 ? [tally(leading)] : []), ...drawn];
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
	/** Failed calls by what they tried, with how each ended; dropped when the same thing later succeeds. */
	open: Map<string, string>;
	tried: Map<string, string>;
	/** Calls whose passing would not settle a failure: a piped command passes whatever its first program did. */
	unproven: Set<string>;
	/** The calls of the live area, oldest first. */
	shown: Map<string, Shown>;
}
/** The widget above the editor: the live area while the agent works, the receipt once it stops. */
const AREA = "compact-tools";
/** The live area's height. It does not change while the agent works, so the editor below it stays in place. */
const AREA_LINES = 3;
const newRun = (): Run => ({
	startedAt: Date.now(),
	calls: 0,
	changed: new Set(),
	open: new Map(),
	tried: new Map(),
	unproven: new Set(),
	shown: new Map(),
});
/** Columns of the receipt an open failure's command or file may take. */
const OPEN_WIDTH = 32;
/** What a call tried: a command, or a tool on a file. A retry of the same thing settles an earlier failure. */
function attempt(toolName: string, args: any): string {
	const target = toolName === "bash" ? sameCommand(args?.command) : (args?.path ?? args?.file_path ?? "");
	return `${toolName} ${target}`;
}
/** The run in one line, what needs attention first; nothing for a run that called no tool. */
function receipt(run: Run, theme: Theme): string | undefined {
	if (run.calls === 0) return undefined;
	// The newest open failure is named, so it need not be looked up in the transcript.
	const [tried, ending] = [...run.open].at(-1) ?? [];
	const named = `${truncateToWidth((tried ?? "").replace(/^bash /, "").split("\n")[0], OPEN_WIDTH, "…")}${ending ? ` · ${ending}` : ""}`;
	const others = run.open.size > 1 ? ` (+${run.open.size - 1} more)` : "";
	const facts = [
		...(run.open.size > 0 ? [theme.fg("error", `✗ open: ${named}${others}`)] : []),
		...(run.changed.size > 0 ? [theme.fg("muted", `${plural(run.changed.size, "file")} changed`)] : []),
		theme.fg("dim", plural(run.calls, "call")),
		theme.fg("dim", formatDuration(Date.now() - run.startedAt)),
	];
	return facts.join(theme.fg("dim", " · "));
}
/**
 * The live area: one line for each call the transcript does not show yet, newest last, at most three. Lines
 * left over show the end of the newest call's output, so a result can be read before its row is drawn. Blank
 * lines above keep the height fixed.
 */
function liveArea(run: Run, theme: Theme, cwd: string, width: number): string[] {
	const rows: { head: string[]; call: Shown; context: Context; printed: boolean }[] = [];
	for (const [id, call] of [...run.shown].toReversed()) {
		if (rows.length >= AREA_LINES) break;
		if (drawsOwnRow.has(call.toolName) || (transcript.calls.has(id) && !unsettled(id))) continue;
		// A call made before one that shows at once is in the transcript too.
		if (overtaken(id)) continue;
		const context = { cwd, isError: call.failed === true, outputPad: 1, state: { compactTools: call } } as Context;
		const summarize = SUMMARIES[call.toolName] ?? plainSummary(call.toolName);
		const summary = summarize(call.args, call.result, theme, context);
		// A failure, a write and an edit are in the transcript as soon as they end.
		if (call.result && (call.failed || summary.keep)) continue;
		const head = headLine(summary, call, theme, context).render(width);
		// A read's result is the file, not something the call printed: it has no count.
		rows.unshift({ head, call, context, printed: !call.result || (summary.count ?? 0) > 0 });
	}
	const newest = rows.at(-1);
	const room = AREA_LINES - rows.length;
	const output =
		newest?.printed && room > 0 ? (newest.call.result ? outputLines(newest.call.result) : newest.call.output) : [];
	const end = output.slice(-room).map((line) => theme.fg("toolOutput", line));
	const drawn = [
		...rows.flatMap((row) => row.head),
		...(newest && end.length > 0 ? indented(end, newest.call, theme, newest.context).render(width) : []),
	];
	return [...Array(Math.max(0, AREA_LINES - drawn.length)).fill(""), ...drawn];
}

/** `cd <dir>` in front of a command says where it ran, not what it did. */
const CD_PREFIX = /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;|\n)\s*/;
/** A runner in front of a program: with or without it, the same check ran. */
const RUNNER = /^(?:uv\s+run(?:\s+--[\w-]+)*|npx(?:\s+--?[\w-]+)*|poetry\s+run|bundle\s+exec)\s+/;
/**
 * What tells one command from another when asking whether a failure was run again and passed: the command
 * without its output plumbing and without a runner in front of it.
 */
function sameCommand(command: unknown): string {
	const [first, ...rest] = String(command ?? "")
		.trim()
		.replace(SHELL_OPTIONS, "")
		.split("\n");
	const merged = first.replace(STDERR_MERGE, "");
	return [((rest.length === 0 && merged.replace(OUTPUT_CAP, "")) || merged).replace(RUNNER, ""), ...rest].join("\n");
}
/**
 * The commands a passing run proves passed: itself, and each command of an `&&` chain, since the chain stops
 * at the first that fails. Only a plain chain counts: with `;`, `||`, a pipe or `&` a part may have failed
 * unseen, and after a `cd`, a `source`, an `export` or a change of branch the parts ran in another place or
 * state than the command that failed.
 */
const MOVES = /^(?:cd|pushd|source|\.|export|git\s+(?:checkout|switch|stash))(?=\s|$)/;
/** Quoted text and `2>&1` hold no operator; both keep their length so parts can be cut from the command. */
const bareCommand = (command: string) =>
	command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"|\d*>&\d+/g, (held) => "q".repeat(held.length));
function proved(command: string): string[] {
	const bare = bareCommand(command);
	const parts: string[] = [];
	let from = 0;
	for (const match of bare.matchAll(/&&/g)) {
		parts.push(command.slice(from, match.index).trim());
		from = match.index + 2;
	}
	parts.push(command.slice(from).trim());
	const plain = !/[;|\n`]|&(?!&)(?<!&&)|\$\(/.test(bare) && parts.every((part) => part && !MOVES.test(part));
	return parts.length > 1 && plain ? [command, ...parts.map(sameCommand)] : [command];
}
/**
 * True when a passing command says its first program passed: with a pipe, the shell reports only the last
 * program's exit code, so `npm test | tail -5` passes whatever the tests did.
 */
const provesPass = (command: unknown) =>
	/pipefail/.test(String(command)) ||
	!/(?<!\|)\|(?!\|)/.test(String(command).replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "q"));
/**
 * True when a passing command is a sequence, statements cut by `;` or a newline: the shell reports only the
 * last one's exit code, so an earlier one may have failed unseen. A leading `cd` and `set` are not statements
 * of their own, and once `set -e` has run the shell stops at the first failure.
 */
function sequence(command: string): boolean {
	let rest = command.trim();
	for (let lead = leadingPlumbing(rest); lead; lead = leadingPlumbing(rest)) {
		if (ERREXIT.test(lead)) return false;
		rest = rest.slice(lead.length);
	}
	const statements = bareCommand(rest)
		.split(/[;\n]/)
		.map((statement) => statement.trim())
		.filter(Boolean);
	const errexit = statements.findIndex((statement) => ERREXIT.test(statement));
	const unseen = statements.slice(0, errexit < 0 ? -1 : errexit);
	return unseen.some((statement) => !/^set\s/.test(statement));
}
const ERREXIT = /^set\s+(?:-[a-z]*e|-o\s+errexit)/;
const leadingPlumbing = (command: string) => (command.match(SHELL_OPTIONS) ?? command.match(CD_PREFIX))?.[0];
/** Plumbing that shapes a command's output for the model and tells a reader nothing about what ran. */
const SHELL_OPTIONS = /^set\s+[-+][a-z]+(?:\s+pipefail)?\s*(?:&&|;|\n)\s*/;
const STDERR_MERGE = /\s+2>&1(?=\s|$)/g;
const OUTPUT_CAP = /\s*\|\s*(?:tail|head)(?:\s+-n?\s*\d+)?\s*$/;

/** Programs that read, wait or report, and checks: test runs, linters, type checks. None leaves a change behind. */
const CHANGES_NOTHING = new RegExp(
	`^(?:${[
		"rg|grep|ls|cat|head|tail|sed|find|fd|wc|tree(?!.*\\s-o)|stat|file|which|pwd",
		"echo|printf|sort(?!.*\\s-o)|uniq(?:\\s+-\\w+)*\\s*$|cut|tr|column",
		"jq|nl|du|df|diff|cmp|awk|seq|date|sleep|true|false|ps|pgrep|basename|dirname|realpath|shasum|whoami|uname",
		"cd|test|\\[|exit|break|continue|wait|read|type|env\\s*$|printenv|export|set|xargs\\s+(?:rg|grep|ls|cat|wc|head|tail)",
		"git\\s+(?:status|log|diff|show|rev-parse|rev-list|ls-files|ls-tree|ls-remote|blame|grep|describe|merge-base|merge-tree|cat-file|reflog(?!\\s+(?:expire|delete|drop))|shortlog|check-ignore|config\\s+--get)",
		// A fetch only moves remote-tracking branches, unless an option or a refspec makes it do more.
		"git\\s+fetch(?!.*(?:\\s-[a-zA-Z]*[pfPt]|\\s--(?!quiet\\b|no-tags\\b)|\\stag\\s|[:+]))",
		"git\\s+(?:branch|tag|remote|stash\\s+list|worktree\\s+list)(?:\\s+(?:-[arvl]+|--(?:list|show-current|all|remotes|verbose|merged|no-merged|porcelain|sort|format)(?:=\\S+)?))*\\s*$",
		"gh\\s+(?:pr|issue|run|release|repo|workflow|search)\\s+(?:view|list|checks|diff|status|watch|prs|issues|code)",
		"gh\\s+api(?!.*\\s(?:-X|--method|-f|-F|--raw-field|--field|--input))",
		"herdr\\s+(?:pane\\s+(?:read|get|list|current|process-info)|agent\\s+(?:list|get|status|read|wait)|(?:workspace|tab)\\s+list)",
		"npm\\s+(?:test|ls|view|outdated|run\\s+(?:check|test|lint|typecheck))(?!.*\\s(?:-u|--update)\\b)",
		"node\\s+--test|(?:npx\\s+)?tsc(?=.*\\s--noEmit\\b)|npx\\s+(?:vitest|jest)(?!.*\\s(?:-u|--update)\\b)",
		"npx\\s+biome\\s+(?:check|lint)(?!.*--(?:write|fix))",
		"(?:uv\\s+run\\s+(?:--(?:offline|frozen|locked|no-sync|quiet)\\s+)*)?(?:pytest|ruff\\s+(?:check|format\\s+--check)|mypy|pyright)(?!.*\\s--(?:fix|add-noqa|install-types|snapshot-update|createstub))",
		"shellcheck|markdownlint(?:-cli2)?(?!.*\\s(?:--fix|-o))|shfmt\\s+-d(?!.*\\s-\\w*w)",
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
/** A redirect to a file, an option that names an output file, or a `find` that deletes, writes or runs a program. */
const MAY_CHANGE =
	/(?<![0-9])>(?!&)(?!\s*\/dev\/null)|[0-9]>(?!&|\s*\/dev\/null)|\s--output\b|\s-(?:delete|exec\w*|ok\w*|fprint\w*|fls)\b/;
/**
 * An `awk` program that may write a file or run a command; it sits in quotes, so it is looked for in the
 * command as typed.
 */
const PROGRAM_CHANGES = /\bawk\b[^|;&\n]*(?:>|\|\s*"|system\(|-i\s+inplace)/;
/**
 * The one use of `sed` known to change nothing: printing lines by number or pattern, as in `sed -n '3,9p'`. A `sed`
 * script can also write files and run commands, so any other use keeps its line, as does an option after the
 * script: `-i` or a second script with `-e`.
 */
const SED_ADDRESS = "(?:\\d+|\\$|\\/(?:[^\\/\\\\'\"]|\\\\.)*\\/)";
const SED_PRINTS = new RegExp(
	`\\bsed\\s+(?:-E\\s+)?-nE?\\s+(?:-E\\s+)?(['"]?)(?:${SED_ADDRESS}(?:,${SED_ADDRESS})?p;?)+\\1(?=\\s|$)(?![^|;&\\n]*\\s-)`,
	"g",
);
/**
 * Scratch work: a redirect to a file under the temp directory, a `tee` to one, a directory made there. It
 * counts as changing nothing, unless it lands in a directory the work is done in. A path with `..` or a
 * variable in it is not known to stay under the temp directory, and a `tee` or `mkdir` with more than one
 * path may name one outside it.
 */
const SCRATCH =
	/(?:[0-9&]?>>?\s*|\b(?:tee\s+(?:-a\s+)?|mkdir\s+(?:-p\s+)?)(?=\S+\s*(?:[;|&)\n]|$)))(\/(?:private\/)?tmp\/[^\s;|&()<>]+)/g;
/** A directory with `/` at its end and the temp directory under one name, to tell what lies inside what. */
const inTemp = (path: string) => `${path}/`.replace(/^\/private\/tmp\//, "/tmp/");
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
function changesNothing(command: string, work: string[]): boolean {
	if (PROGRAM_CHANGES.test(command)) return false;
	if ((command.match(/\bsed\b/g)?.length ?? 0) !== (command.match(SED_PRINTS)?.length ?? 0)) return false;
	const scripts: string[] = [];
	const ran: string[] = [];
	// A here-document is text for the program in front of it: its body is no command.
	let rest = takeOut(command.replace(/\\\n/g, " "), HERE_DOCUMENT, (match) => {
		scripts.push(match[4]);
		return ` «${scripts.length - 1}»${match[3]}`;
	});
	rest = takeOut(rest, INLINE_SCRIPT, (match) => (SCRIPT_CHANGES.test(match[1] ?? match[2]) ? undefined : "true"));
	// Nothing runs inside single quotes; a substitution runs a command of its own; double quotes are then text.
	// A process substitution is not looked into: such a command keeps its line.
	rest = takeOut(rest?.replace(/'[^']*'/g, "q"), /\$\(([^()`]*)\)|`([^`]*)`/, (match) => {
		ran.push(match[1] ?? match[2]);
		return "q";
	})?.replace(/"(?:[^"\\]|\\.)*"/g, "q");
	// What is left stands for the part taken out: nothing for a redirect, a harmless program otherwise.
	rest = rest?.replace(SCRATCH, (match, path: string) => {
		if (/\.\.|\$/.test(path) || work.some((dir) => inTemp(path).startsWith(inTemp(dir)))) return match;
		return match.includes(">") ? " " : "true";
	});
	if (rest === undefined || /\$\(|`|<<|<\(/.test(rest) || MAY_CHANGE.test(rest)) return false;
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
	return harmless && ran.every((inner) => changesNothing(inner, work));
}

/** `src/a.ts:12` or `src/a.ts:12:5` in output: a place in a file, which a terminal can open. */
const FILE_REFERENCE = /(?<![\w/.-])((?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[a-z]{1,5}):(\d+)(?::\d+)?/g;

/**
 * An output line in its colour, with file references linked where the terminal supports links. Only a failed
 * call marks its error-like lines: in passing output the same words are mostly matches in code, not errors.
 */
function outputLine(line: string, theme: Theme, context: Context): string {
	const paint = (text: string) => theme.fg(context.isError && errorLike(line) ? "error" : "toolOutput", text);
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
/**
 * The lines a failed command shows: its end from the first error-like line among the last twenty. When that
 * is more than a screen can spare, only the error-like lines in it and the values of failed comparisons, each
 * once, the newest kept.
 */
function failedTail(output: string[]): string[] {
	const window = output.slice(-FAILED_LINES);
	const first = window.findIndex(errorLike);
	const kept = Math.min(output.length, Math.max(FAILED_MIN_LINES, first < 0 ? 0 : window.length - first));
	const end = output.slice(output.length - kept);
	if (end.length <= FAILED_SHOWN) return end;
	const errors = end.filter(
		(line, index) =>
			(errorLike(line) || COMPARED.test(line)) &&
			end.findLastIndex((other) => other.trim() === line.trim()) === index,
	);
	return errors.slice(-FAILED_SHOWN);
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
		const whole = String(args?.command ?? "...");
		let command = whole.trim();
		const meta: string[] = [];
		let place: string | undefined;
		let where = context.cwd;
		const options = command.match(SHELL_OPTIONS);
		if (options && command.length > options[0].length) command = command.slice(options[0].length);
		const cd = command.match(CD_PREFIX);
		if (cd && command.length > cd[0].length) {
			command = command.slice(cd[0].length);
			where = cd[1].replace(/^["']|["']$/g, "").replace(/\/$/, "");
			const dir = shortPath(where, context.cwd);
			if (dir !== HERE) place = dir;
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
		if (!result) return { head, meta, place };
		const silent = !context.isError && changesNothing(command, [context.cwd, where]);
		const output = outputLines(result);
		// Pi ends a failed command's output with this line; the head line carries the code instead.
		const exit = context.isError ? output.at(-1)?.match(/^Command exited with code (\d+)$/)?.[1] : undefined;
		if (exit) output.pop();
		// Pi's stand-in for a command that printed nothing is not a line of output.
		if (output.length === 1 && output[0] === "(no output)") output.pop();
		if (exit) meta.push(theme.fg("error", `exit ${exit}`));
		const ms = rowState(context).durationMs ?? 0;
		if (ms >= 1000) meta.push(theme.fg(ms >= SLOW_MS ? "warning" : "muted", formatDuration(ms)));
		if (!context.isError) return { head, meta, place, count: output.length, silent, unproven: sequence(whole) };
		const kept = failedTail(output);
		const body = [
			...(output.length > kept.length
				? [theme.fg("muted", `⋮ ${plural(output.length - kept.length, "more line")}`)]
				: []),
			...kept.map((line) => outputLine(line, theme, context)),
		];
		return { head, meta, place, body, count: output.length, silent };
	},
	read(args, result, theme, context) {
		const head = `${title(theme, "read")} ${filePath(args, theme, context.cwd)}${theme.fg("warning", lineRange(args))}`;
		if (!result) return { head };
		if (context.isError) return { head, body: outputLines(result).map((line) => theme.fg("toolOutput", line)) };
		const blocks = result.content ?? [];
		// Pi draws the image under the row as soon as the call ends; a head line added later would push it down.
		if (blocks.some((block) => block.type === "image"))
			return { head, meta: [theme.fg("muted", "image")], keep: true };
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
		return { head, meta, keep: true };
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
		return {
			head: `${title(theme, toolName)} ${theme.fg("muted", pairs.join(" "))}`,
			body: context.isError ? output.slice(-FAILED_LINES).map((line) => theme.fg("toolOutput", line)) : [],
			count: output.length,
		};
	};

function glyph(state: RowState, theme: Theme, unproven = false): string {
	if (!state.result) return theme.fg("accent", "●");
	if (state.failed) return theme.fg("error", "✗");
	return unproven ? theme.fg("muted", "?") : theme.fg("success", "✓");
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
		// Room after the margins and the glyph with its space.
		const inner = width - context.outputPad * 2 - 2;
		const unseen = summary.body?.length ? 0 : (summary.count ?? 0);
		const factsIn = (place: string | undefined) =>
			[
				...(unseen > 0 ? [theme.fg("muted", plural(unseen, "line"))] : []),
				...(place ? [theme.fg("muted", `in ${place}`)] : []),
				...(summary.meta ?? []),
				...(running ? [theme.fg("muted", running)] : []),
			].join(sep);
		const headIn = (room: number) =>
			typeof summary.head === "function" ? summary.head(room) : truncateToWidth(summary.head, room, "…");
		const roomBeside = (meta: string) => Math.max(8, inner - (meta ? visibleWidth(meta) + 3 : 0));
		let meta = factsIn(summary.place);
		// A row too wide for the line cuts its directory to at most half the line, keeping its end: where the command ran.
		if (summary.place && visibleWidth(headIn(inner)) > roomBeside(meta))
			meta = factsIn(startCut(summary.place, Math.max(8, Math.floor(inner / 2) - 3)));
		const head = headIn(roomBeside(meta));
		// The head keeps at least its minimum room, so facts too wide for the rest are cut at the line's end.
		const line = truncateToWidth(
			`${pad}${glyph(state, theme, summary.unproven)} ${head}${meta ? sep : ""}${meta}`,
			width,
			"…",
		);
		return [summary.quiet ? theme.fg("dim", stripVTControlCharacters(line)) : line];
	});
}
/** A path cut at its start to fit: it keeps its last whole folders, or the end of the last one when that alone is too long. */
function startCut(text: string, room: number): string {
	if (visibleWidth(text) <= room) return text;
	const folders = text.split("/");
	let kept = "";
	for (let at = folders.length - 1; at > 0; at--) {
		const next = `/${folders[at]}${kept}`;
		if (visibleWidth(next) > room - 1) break;
		kept = next;
	}
	if (kept) return `…${kept}`;
	const chars = [...text];
	let from = chars.length;
	while (from > 0 && visibleWidth(chars.slice(from - 1).join("")) <= room - 1) from--;
	return `…${chars.slice(from).join("")}`;
}
/** A failed call's line, wrapped: a long one keeps its start, where the message is. */
function wrapped(line: string, room: number): string[] {
	const rows = wrapTextWithAnsi(line, room);
	if (rows.length <= FAILED_LINE_ROWS) return rows;
	return [...rows.slice(0, FAILED_LINE_ROWS - 1), truncateToWidth(`${rows[FAILED_LINE_ROWS - 1]}…`, room, "…")];
}
/**
 * A component's lines under the head line, behind a bar in the glyph's column: red when the call failed.
 * A failure's lines wrap to two rows at most; any other line is cut to one row.
 */
function indented(child: Component | string[], state: RowState, theme: Theme, context: Context): Component {
	return lines((width) => {
		const indent = `${" ".repeat(context.outputPad)}${theme.fg(state.failed ? "error" : "dim", "│")} `;
		const room = Math.max(8, width - visibleWidth(indent) - context.outputPad);
		const rows = Array.isArray(child)
			? child.flatMap((line) => (state.failed ? wrapped(line, room) : [truncateToWidth(line, room, "…")]))
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
	/** The row's summary: a failed command loses its output once the same command passed on a later run. */
	const summary = (args: any, state: RowState, theme: Theme, context: Context): Summary => {
		if (!state.result) return fallback(args, undefined, theme, context);
		state.summary ??= fallback(args, state.result, theme, context);
		const full = state.summary;
		if (!state.failed || !passedLater(context.toolCallId)) return full;
		return { ...full, body: [], meta: [...(full.meta ?? []), "passed later"], count: 0, quiet: true };
	};
	/**
	 * True while the call shows only in the live area: nothing has followed its step yet. A failure, a write and
	 * an edit are not held back once they end.
	 */
	const held = (args: any, state: RowState, theme: Theme, context: Context): boolean => {
		if (drawsOwn || showsPi(context) || !unsettled(context.toolCallId)) return false;
		if (overtaken(context.toolCallId)) return false;
		return !state.result || !(state.failed || summary(args, state, theme, context).keep);
	};
	/** Pi updated the row: what was kept from its last state is stale. */
	const refresh = (state: RowState) => {
		state.summary = undefined;
		state.headLine = undefined;
		state.bodyLines = undefined;
	};
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = rowState(context);
			refresh(state);
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
				const shell = framed ? piShell(full, theme, context, "top") : full;
				// With every row expanded, a heading shows at its own call.
				return context.expanded ? shell : headed(shell, context.toolCallId);
			}
			if (!summarize && state.piCall)
				return counted(
					headed(glyphed(state.piCall, state, theme, context), context.toolCallId),
					context.toolCallId,
					"call",
				);
			const id = context.toolCallId;
			const head = (width: number) => {
				const drawn = { ...summary(args, state, theme, context), place: placeNamed(id) };
				if (!state.result) return headLine(drawn, state, theme, context).render(width);
				const key = `${width} ${drawn.body?.length ?? 0} ${drawn.quiet} ${drawn.meta?.length} ${drawn.place}`;
				if (state.headLine?.key !== key)
					state.headLine = { key, rows: headLine(drawn, state, theme, context).render(width) };
				return state.headLine.rows;
			};
			const folded = () =>
				!showsPi(context) &&
				state.result !== undefined &&
				!held(args, state, theme, context) &&
				!state.result.content?.some((block) => block.type === "image") &&
				!summary(args, state, theme, context).body?.length;
			transcript.rows.set(id, {
				head,
				command: toolName === "bash" ? sameCommand((args as any)?.command) : undefined,
				folded,
				silent: () =>
					folded() &&
					superseded(id) &&
					summary(args, state, theme, context).silent === true &&
					!failedBefore(id) &&
					!overtaken(id),
				place: () => summary(args, state, theme, context).place ?? HERE,
				atOnce: () =>
					state.result !== undefined &&
					(state.failed === true || summary(args, state, theme, context).keep === true),
				height() {
					if (showsPi(context)) return Number.POSITIVE_INFINITY;
					// Pi puts the blank line only above a row that draws something.
					const drawn = (state.callRows ?? 0) + (state.resultRows ?? 0);
					return drawn > 0 ? drawn + 1 : 0;
				},
			});
			const tally = (count: number) =>
				`${" ".repeat(context.outputPad)}${theme.fg("dim", `⋮ ${plural(count, "call")}, nothing changed`)}`;
			const call = (width: number) => {
				if (held(args, state, theme, context)) return [];
				const call = foldedRow(transcript.calls.get(id));
				if (!call) return [...headings(transcript.calls.get(id), width), ...head(width)];
				// A folded row that the next one joins draws nothing: the last row of the run draws them all.
				return joins(call, neighbour(call, 1)) ? [] : foldedRun(call, width, tally);
			};
			return lines((width) => {
				const drawn = call(width);
				state.callRows = drawn.length;
				return drawn;
			});
		},
		renderResult(result, options, theme, context) {
			const state = rowState(context);
			state.result = options.isPartial ? undefined : result;
			state.failed = context.isError;
			state.durationMs = context.durationMs;
			refresh(state);
			const command = transcript.rows.get(context.toolCallId)?.command;
			if (command !== undefined && state.result && (state.failed || provesPass((context.args as any)?.command))) {
				const ended = state.failed ? transcript.failed : transcript.passed;
				for (const part of state.failed ? [command] : proved(command))
					ended.set(part, (ended.get(part) ?? new Set()).add(context.toolCallId));
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
				// A running row that shows beside a drawn one is one line: its output would move the rows below it.
				const hidden = () =>
					held(context.args, state, theme, context) || (summarize !== undefined && overtaken(context.toolCallId));
				return lines((width) => {
					const drawn = hidden() ? [] : partial.render(width);
					state.resultRows = drawn.length;
					return drawn;
				});
			}
			const output = (width: number) => {
				if (held(context.args, state, theme, context)) return [];
				const body = summary(context.args, state, theme, context).body ?? [];
				if (body.length === 0) return [];
				const key = `${width} ${body.length}`;
				if (state.bodyLines?.key !== key)
					state.bodyLines = { key, rows: indented(body, state, theme, context).render(width) };
				return state.bodyLines.rows;
			};
			return lines((width) => {
				const drawn = output(width);
				state.resultRows = drawn.length;
				return drawn;
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
			noteMessage(entry.message, true);
		}
		// With no run under way, nothing more follows the last step.
		if (ctx.isIdle()) settle(transcript.turn);
		// Rows of the session that was left are dropped; rows this session drew before the event are kept.
		for (const kept of [transcript.rows, ownCalls, ownLines])
			for (const id of kept.keys()) if (!transcript.calls.has(id)) kept.delete(id);
		// Every message of a loaded session is complete.
		transcript.closed = transcript.turn;
		for (const ended of [transcript.passed, transcript.failed])
			for (const [command, ids] of ended) {
				for (const id of ids) if (!transcript.calls.has(id)) ids.delete(id);
				if (ids.size === 0) ended.delete(command);
			}
	};
	pi.on("session_start", reload);
	pi.on("session_tree", reload);
	pi.on("session_compact", reload);
	pi.on("message_start", (event) => startMessage(event.message));
	pi.on("message_update", (event) => noteMessage(event.message));
	pi.on("message_end", (event) => {
		noteMessage(event.message);
		if (event.message?.role === "assistant") transcript.closed = transcript.turn;
	});

	let run = newRun();
	/** Redraws the live area; unset while the receipt or nothing is shown. */
	let redraw: (() => void) | undefined;
	pi.on("agent_start", (_event, ctx) => {
		run = newRun();
		if (ctx.hasUI) ctx.ui.setWidget(AREA, undefined);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		run.tried.set(event.toolCallId, attempt(event.toolName, event.args));
		if (event.toolName === "bash" && !provesPass(event.args?.command)) run.unproven.add(event.toolCallId);
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
			const exit = outputLines(event.result)
				.at(-1)
				?.match(/^Command exited with code (\d+)$/)?.[1];
			// Set again so the newest failure is the last one.
			run.open.delete(tried);
			run.open.set(tried, exit ? `exit ${exit}` : "");
			return;
		}
		if (!run.unproven.has(event.toolCallId)) {
			const [tool, command] = [tried.slice(0, tried.indexOf(" ")), tried.slice(tried.indexOf(" ") + 1)];
			for (const part of tool === "bash" ? proved(command) : [command]) run.open.delete(`${tool} ${part}`);
		}
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
			ownShell.add(toolName);
			// Its renderers are passed on as they are; each gets back the component it made, not the counting one.
			const own = (context: Context) => ({ ...context, lastComponent: (context.lastComponent as any)?.inner });
			const { renderCall, renderResult } = renderers;
			return {
				...renderers,
				renderCall:
					renderCall &&
					((args, theme, context) => {
						const id = context.toolCallId;
						const drawn = renderCall(args, theme, own(context));
						ownCalls.set(id, drawn);
						// With every row expanded, the call's line shows at its own place.
						return counted(drawn, id, "call", () => !context.expanded && drawnElsewhere(id));
					}),
				renderResult:
					renderResult &&
					((result, options, theme, context) => {
						const id = context.toolCallId;
						const drawn = counted(renderResult(result, options, theme, own(context)), id, "result");
						// Pi asks for the call's line before the result's, and a tool may draw the call from what its
						// result left behind: measured again here, the rows above know of that line on this frame.
						const call = ownCalls.get(id)?.render(PROBE_WIDTH).length;
						if (call !== undefined) ownLines.set(id, { ...ownLines.get(id), call });
						return drawn;
					}),
			};
		}
		return compactRenderers(toolName, renderers, SUMMARIES[toolName]);
	});
}
