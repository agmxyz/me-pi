/**
 * TUI rendering for the delegate tool: a one-line call preview, live progress, and a collapsed result
 * (one line per run) that expands to the answers as Markdown. The model never sees this; it gets the
 * tool's text content. Every line is cut to the terminal width.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

/** One worker run as the renderer shows it. */
export interface RunView {
	model: string;
	thinking: string;
	web: boolean;
	done: boolean;
	failure?: string;
	/** Set when round 2 failed and the round-1 answer is shown instead. */
	round2Failure?: string;
	turns: number;
	cost: number;
	ms: number;
	lastTool?: string;
	output: string;
	outDir?: string;
	files?: string[];
}

/** The renderer's part of the tool details: the stage, and the runs shown in it. */
export interface DelegateView {
	stage: "Workers" | "Rebuttal" | "Done";
	web: boolean;
	runs: RunView[];
	/** Totals and notes (round-1 file, skipped rebuttal) under the final result. */
	footer?: string;
}

type Fg = (color: any, text: string) => string;
const plain: Fg = (_color, text) => text;

/** Lines cut to the width when drawn. */
class Lines implements Component {
	private readonly lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(width: number): string[] {
		// A line break inside a line has no width but still moves the cursor: flatten it first.
		return this.lines.map((line) => truncateToWidth(line.replace(/[\r\n\t]/g, " "), Math.max(1, width)));
	}
	invalidate(): void {}
}

/** `anthropic/claude-haiku-5-5` as `claude-haiku-5-5`. */
export const shortModel = (model: string) => model.split("/").pop() ?? model;
// The first line with text, skipping code fences.
const firstLine = (text: string) =>
	text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l && !l.startsWith("```")) ?? "";
// Collapsed results without a view show this many lines.
const FALLBACK_LINES = 5;
// A collapsed preview is plain text: drop bold and code marks and a heading's leading #s.
const plainPreview = (text: string) =>
	firstLine(text)
		.replace(/\*\*|`/g, "")
		.replace(/^#+\s*/, "");

function icon(run: RunView, fg: Fg): string {
	if (!run.done) return fg("warning", "⏳");
	return run.failure || run.round2Failure ? fg("error", "✗") : fg("success", "✓");
}

/** `✓ haiku-5-5 @low web $0.0017 6s`, plus the file count with `output`. */
function runHeader(run: RunView, fg: Fg): string {
	const web = run.web ? " web" : "";
	const files = run.files ? ` · ${run.files.length} file${run.files.length === 1 ? "" : "s"}` : "";
	const meta = `@${run.thinking}${web} $${run.cost.toFixed(4)} ${Math.round(run.ms / 1000)}s${files}`;
	return `${icon(run, fg)} ${fg("accent", shortModel(run.model))} ${fg("dim", meta)}`;
}

/** What went wrong with a run, or undefined. */
function problem(run: RunView): string | undefined {
	if (run.failure) return run.failure;
	if (run.round2Failure) return `round 2 failed: ${run.round2Failure} (round-1 answer kept)`;
	return undefined;
}

/** Live progress, one line per run; also the plain text that non-TUI modes show. */
export function progressLines(view: DelegateView, fg: Fg = plain): string[] {
	const header = fg("toolTitle", view.stage) + (view.web ? fg("muted", " [web]") : "");
	const runs = view.runs.map((r) => {
		const tail = r.lastTool ? ` ${fg("dim", r.lastTool)}` : "";
		return `${icon(r, fg)} ${fg("accent", shortModel(r.model))} turn ${r.turns} $${r.cost.toFixed(4)}${tail}`;
	});
	return [header, ...runs];
}

export function renderCall(args: any, theme: Theme): Component {
	const fg: Fg = theme.fg.bind(theme);
	const runs: any[] = Array.isArray(args?.runs) && args.runs.length ? args.runs : [{}];
	const models = runs
		.map((r) => `${r?.model ? shortModel(String(r.model)) : "default"}${r?.thinking ? `@${r.thinking}` : ""}`)
		.join(", ");
	const badges = [args?.web === true && "web", args?.rebuttal && "rebuttal", args?.output && "output"].filter(Boolean);
	const task = firstLine(typeof args?.task === "string" ? args.task : "...");
	const line =
		`${theme.bold(fg("toolTitle", "delegate"))} ${fg("accent", args?.role ?? "general")} ${fg("muted", models)}` +
		(badges.length ? ` ${fg("warning", `[${badges.join(", ")}]`)}` : "") +
		` ${fg("dim", task)}`;
	return new Lines([line]);
}

export function renderResult(
	result: { content: { type: string; text?: string }[]; details?: any },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Component {
	const fg: Fg = theme.fg.bind(theme);
	const view: DelegateView | undefined = result.details?.view;
	if (!view) {
		// Refused calls and results from older versions carry no view: show the text, wrapped, and
		// only its first lines when collapsed.
		const lines = result.content
			.map((c) => c.text ?? "")
			.join("\n")
			.split("\n");
		const more = lines.length - FALLBACK_LINES;
		const shown =
			options.expanded || more <= 0 ? lines : [...lines.slice(0, FALLBACK_LINES), `\u2026 (${more} more lines)`];
		return new Text(fg("toolOutput", shown.join("\n")), 0, 0);
	}
	if (options.isPartial || view.stage !== "Done") return new Lines(progressLines(view, fg));

	const footer = view.footer ? [fg("dim", view.footer)] : [];
	if (!options.expanded) {
		const lines = view.runs.map((r) => {
			const trouble = problem(r);
			const preview = trouble ? fg("error", trouble) : fg("toolOutput", plainPreview(r.output) || "(empty answer)");
			return `${runHeader(r, fg)} ${preview}`;
		});
		return new Lines([...lines, ...footer]);
	}

	const container = new Container();
	const markdown = getMarkdownTheme();
	view.runs.forEach((r, i) => {
		if (i > 0) container.addChild(new Spacer(1));
		container.addChild(new Lines([runHeader(r, fg)]));
		const trouble = problem(r);
		if (trouble) container.addChild(new Text(fg("error", trouble), 0, 0));
		if (r.output.trim()) container.addChild(new Markdown(r.output.trim(), 0, 0, markdown));
		if (r.outDir) {
			const files = r.files?.length ? r.files.join(", ") : "none written";
			container.addChild(new Text(fg("muted", `Files in ${r.outDir}: ${files}`), 0, 0));
		}
	});
	if (footer.length) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(footer[0], 0, 0));
	}
	return container;
}
