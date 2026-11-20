/**
 * Short rows for finished tool calls while tool output is collapsed. A row is one line (a status glyph, what ran,
 * then facts about the result) and a few indented output lines, with no background box.
 *
 * The numbers below were picked by replaying 40 past sessions through Pi's row component and by checking which
 * lines a reader needs: the first output line often carries the answer or a table header, the last ones the result.
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

/** `cd <dir>` in front of a command says where it ran, not what it did. */
const CD_PREFIX = /^cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;|\n)\s*/;
/** Plumbing that shapes a command's output for the model and tells a reader nothing about what ran. */
const SHELL_OPTIONS = /^set\s+[-+][a-z]+(?:\s+pipefail)?\s*(?:&&|;|\n)\s*/;
const STDERR_MERGE = /\s+2>&1(?=\s|$)/g;
const OUTPUT_CAP = /\s*\|\s*(?:tail|head)(?:\s+-n?\s*\d+)?\s*$/;

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
/** Text cut in the middle to fit: a command's start says what ran, its end what came out. */
function middleCut(text: string, room: number): string {
	if (visibleWidth(text) <= room) return text;
	const chars = [...text];
	const fit = (from: string[], width: number) => {
		let count = 0;
		while (count < from.length && visibleWidth(from.slice(0, count + 1).join("")) <= width) count++;
		return count;
	};
	const right = fit(chars.toReversed(), Math.floor((room - 1) / 3));
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
		const output = outputLines(result);
		// Pi ends a failed command's output with this line; the head line carries the code instead.
		const exit = context.isError ? output.at(-1)?.match(/^Command exited with code (\d+)$/)?.[1] : undefined;
		if (exit) output.pop();
		const whole = !context.isError && output.length <= WHOLE_LINES;
		const headCount = whole ? output.length : context.isError ? 0 : HEAD_LINES;
		const tailCount = whole ? 0 : context.isError ? failedTail(output) : TAIL_LINES;
		const hidden = output.length - headCount - tailCount;
		if (exit) meta.push(theme.fg("error", `exit ${exit}`));
		if (hidden > 0) meta.push(theme.fg("muted", `+${plural(hidden, "line")}`));
		const ms = rowState(context).durationMs ?? 0;
		if (ms >= 1000) meta.push(theme.fg(ms >= SLOW_MS ? "warning" : "muted", formatDuration(ms)));
		const shown = (rows: string[]) => rows.map((line) => outputLine(line, theme, context));
		const body = [
			...shown(output.slice(0, headCount)),
			...(headCount > 0 && hidden > 0 ? [theme.fg("dim", "⋮")] : []),
			...shown(tailCount > 0 ? output.slice(-tailCount) : []),
		];
		return { head, meta, body };
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
		return { head, meta: [theme.fg("muted", plural(count, "line"))] };
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
		return { head, meta, body };
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
			meta: output.length > kept ? [theme.fg("muted", plural(output.length, "line"))] : [],
			body: kept > 0 ? output.slice(-kept).map((line) => theme.fg("toolOutput", line)) : [],
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
		const facts = [...(summary.meta ?? []), ...(running ? [theme.fg("muted", running)] : [])];
		const meta = facts.join(sep);
		const room = Math.max(8, width - context.outputPad * 2 - 2 - (meta ? visibleWidth(meta) + 3 : 0));
		const head = typeof summary.head === "function" ? summary.head(room) : truncateToWidth(summary.head, room, "…");
		return [`${pad}${glyph(state, theme)} ${head}${meta ? sep : ""}${meta}`];
	});
}
/** A line cut to one row, or to two when it reads like an error: the message is usually at its end. */
function fitted(line: string, room: number): string[] {
	if (visibleWidth(line) <= room || !ERROR_LIKE.test(stripVTControlCharacters(line)))
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
	return {
		renderShell: "self",
		renderCall(args, theme, context) {
			const state = rowState(context);
			keepTime(state, context);
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
			return lines((width) =>
				headLine(fallback(args, state.result, theme, context), state, theme, context).render(width),
			);
		},
		renderResult(result, options, theme, context) {
			const state = rowState(context);
			state.result = options.isPartial ? undefined : result;
			state.failed = context.isError;
			state.durationMs = context.durationMs;
			keepTime(state, context);
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
			return lines((width) =>
				indented(fallback(context.args, result, theme, context).body ?? [], state, theme, context).render(width),
			);
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => {
		const renderers = next();
		// A tool that draws its own shell keeps it, unless its row has a summary here.
		if (renderers?.renderShell === "self" && !SUMMARIES[toolName]) return renderers;
		return compactRenderers(toolName, renderers, SUMMARIES[toolName]);
	});
}
