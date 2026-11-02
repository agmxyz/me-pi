/**
 * TUI rendering for delegate: call preview, live progress, and collapsed/expanded Markdown results.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";

/** The emoji and phrase a running worker shows; picked once per worker so rerenders keep it. */
export interface Persona {
	emoji: string;
	phrase: string;
}

/** The five Fitzpatrick skin-tone modifiers, light to dark. */
export const SKIN_TONES = ["\u{1F3FB}", "\u{1F3FC}", "\u{1F3FD}", "\u{1F3FE}", "\u{1F3FF}"] as const;

/** Scouts are elves; every other worker is a chef or a farmer. Each gets a random skin tone. */
export function pickPersona(role: string, random: () => number = Math.random): Persona {
	const pick = <T>(items: readonly T[]): T => items[Math.min(items.length - 1, Math.floor(random() * items.length))];
	const tone = pick(SKIN_TONES);
	if (role === "scout") return { emoji: `\u{1F9DD}${tone}`, phrase: "what do your elf-eyes see?" };
	return pick([
		{ emoji: `\u{1F9D1}${tone}\u200D\u{1F373}`, phrase: "letting him cook" },
		{ emoji: `\u{1F9D1}${tone}\u200D\u{1F33E}`, phrase: "doing honest work" },
	]);
}

// Views from older sessions carry no persona.
const DEFAULT_PERSONA: Persona = { emoji: "🧑‍🍳", phrase: "" };

export interface RunView {
	persona?: Persona;
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
	activity?: string[];
	output: string;
	outDir?: string;
	files?: string[];
}

export interface DelegateView {
	stage: "Workers" | "Rebuttal" | "Done";
	web: boolean;
	runs: RunView[];
	/** Totals and notes (round-1 file, skipped rebuttal) under the final result. */
	footer?: string;
}

/** Safe, prompt-independent details for one active worker in the main-session widget. */
export interface ActivityWidgetRow {
	/** Collision-safe internal call identity; never displayed when a compact label is available. */
	id: string;
	displayId?: string;
	worker: number;
	workerCount: number;
	role: string;
	model: string;
	thinking: string;
	startedAt: number;
	lastTool?: string;
	stage: "Workers" | "Rebuttal";
	persona: Persona;
}

const stripWidgetControls = (value: string) =>
	value
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

/** A compact, prompt-free activity panel; its caller supplies only sanitized worker metadata. */
export function activityWidget(rows: () => readonly ActivityWidgetRow[], theme: Theme): Component {
	return {
		render(width: number): string[] {
			const current = rows();
			if (!current.length) return [];
			const fg: Fg = theme.fg.bind(theme);
			const shown = current.slice(0, 4).map((row) => {
				const id = stripWidgetControls(row.displayId ?? row.id);
				const model = stripWidgetControls(row.model);
				const role = stripWidgetControls(row.role);
				const thinking = stripWidgetControls(row.thinking);
				const tool = row.lastTool ? stripWidgetControls(row.lastTool) : "";
				const workerId = row.workerCount > 1 ? `${id}#${row.worker}` : id;
				const elapsed = Math.max(0, Math.floor((Date.now() - row.startedAt) / 1000));
				const stage = row.stage === "Rebuttal" ? fg("warning", " R2") : "";
				const phrase = row.persona.phrase ? ` · ${fg("dim", row.persona.phrase)}` : "";
				const tail = `${fg("dim", `@${thinking} ${elapsed}s`)}${tool ? ` · ${fg("toolTitle", tool)}` : ""}${phrase}`;
				return `${fg("warning", row.persona.emoji)} ${fg("accent", workerId)} ${fg("muted", role)}${stage} ${fg("accent", model)} ${tail}`;
			});
			const overflow = current.length - shown.length;
			const lines = [
				fg("toolTitle", "Delegate activity"),
				...shown,
				...(overflow > 0 ? [fg("dim", `… ${overflow} more worker${overflow === 1 ? "" : "s"}`)] : []),
			];
			return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
		},
		invalidate(): void {},
	};
}

type Fg = (color: any, text: string) => string;
const plain: Fg = (_color, text) => text;
type RenderStatus = { isPartial: boolean; isError: boolean };

function truncationEllipsis(theme: Theme, context?: RenderStatus): string | undefined {
	if (!context) return undefined;
	const background = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
	return theme.bg(background, "...");
}

class Lines implements Component {
	private readonly lines: string[];
	private readonly ellipsis: string | undefined;
	constructor(lines: string[], ellipsis?: string) {
		this.lines = lines;
		this.ellipsis = ellipsis;
	}
	render(width: number): string[] {
		// A line break inside a line has no width but still moves the cursor: flatten it first.
		return this.lines.map((line) =>
			truncateToWidth(line.replace(/[\r\n\t]/g, " "), Math.max(1, width), this.ellipsis ?? "..."),
		);
	}
	invalidate(): void {}
}

/** `anthropic/claude-haiku-5-5` as `claude-haiku-5-5`. */
export const shortModel = (model: string) => model.split("/").pop() ?? model;
const firstLine = (text: string) =>
	text
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l && !l.startsWith("```")) ?? "";
const FALLBACK_LINES = 5;
// A collapsed preview is plain text: drop bold and code marks and a heading's leading #s.
const plainPreview = (text: string) =>
	firstLine(text)
		.replace(/\*\*|`/g, "")
		.replace(/^#+\s*/, "");

function icon(run: RunView, fg: Fg): string {
	if (!run.done) return fg("warning", (run.persona ?? DEFAULT_PERSONA).emoji);
	return run.failure || run.round2Failure ? fg("error", "✗") : fg("success", "✓");
}

/** `✓ haiku-5-5 @low web $0.0017 6s`, plus the file count with `output`. */
function runHeader(run: RunView, fg: Fg): string {
	const web = run.web ? " web" : "";
	const files = run.files ? ` · ${run.files.length} file${run.files.length === 1 ? "" : "s"}` : "";
	const meta = `@${run.thinking}${web} $${run.cost.toFixed(4)} ${Math.round(run.ms / 1000)}s${files}`;
	return `${icon(run, fg)} ${fg("accent", shortModel(run.model))} ${fg("dim", meta)}`;
}

function problem(run: RunView): string | undefined {
	if (run.failure) return run.failure;
	if (run.round2Failure) return `round 2 failed: ${run.round2Failure} (round-1 answer kept)`;
	return undefined;
}

/** Live progress, one line per run; also the plain text that non-TUI modes show. */
export function progressLines(view: DelegateView, fg: Fg = plain, expanded = false): string[] {
	const header = fg("toolTitle", view.stage) + (view.web ? fg("muted", " [web]") : "");
	const runs = view.runs.flatMap((r) => {
		const phrase = !r.done && r.persona?.phrase ? `· ${r.persona.phrase}` : undefined;
		const tail = [r.lastTool, phrase]
			.filter(Boolean)
			.map((text) => fg("dim", text as string))
			.join(" ");
		const row = `${icon(r, fg)} ${fg("accent", shortModel(r.model))} ${fg("dim", `@${r.thinking} turn ${r.turns} $${r.cost.toFixed(4)}`)}${tail ? ` ${tail}` : ""}`;
		return [row, ...(expanded ? (r.activity ?? []).map((tool) => fg("dim", `  ${tool}`)) : [])];
	});
	return [header, ...runs];
}

export function renderCall(args: any, theme: Theme, context?: RenderStatus): Component {
	const fg: Fg = theme.fg.bind(theme);
	const ellipsis = truncationEllipsis(theme, context);
	const runs: any[] = Array.isArray(args?.runs) && args.runs.length ? args.runs : [{}];
	const models = runs
		.map((r) => `${r?.model ? shortModel(String(r.model)) : "default"}${r?.thinking ? `@${r.thinking}` : ""}`)
		.join(", ");
	const badges = [args?.web === true && "web", args?.rebuttal && "rebuttal", args?.output && "output"].filter(Boolean);
	const task = firstLine(typeof args?.task === "string" ? args.task : "...");
	const check = typeof args?.check === "string" ? ` ${fg("muted", `check \`${firstLine(args.check)}\``)}` : "";
	const line =
		`${theme.bold(fg("toolTitle", "delegate"))} ${fg("accent", args?.role ?? "general")} ${fg("muted", models)}` +
		(badges.length ? ` ${fg("warning", `[${badges.join(", ")}]`)}` : "") +
		check +
		` ${fg("dim", task)}`;
	return new Lines([line], ellipsis);
}

export function renderResult(
	result: { content: { type: string; text?: string }[]; details?: any },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context?: RenderStatus,
): Component {
	const fg: Fg = theme.fg.bind(theme);
	const ellipsis = truncationEllipsis(theme, context);
	const view: DelegateView | undefined = result.details?.view;
	if (!view) {
		// Calls without a view: show wrapped text, capped to FALLBACK_LINES when collapsed.
		const lines = result.content
			.map((c) => c.text ?? "")
			.join("\n")
			.split("\n");
		const more = lines.length - FALLBACK_LINES;
		const shown =
			options.expanded || more <= 0 ? lines : [...lines.slice(0, FALLBACK_LINES), `\u2026 (${more} more lines)`];
		return new Text(fg("toolOutput", shown.join("\n")), 0, 0);
	}
	if (options.isPartial || view.stage !== "Done")
		return new Lines(progressLines(view, fg, options.expanded), ellipsis);

	const footer = view.footer ? [fg("dim", view.footer)] : [];
	if (!options.expanded) {
		const lines = view.runs.map((r) => {
			const trouble = problem(r);
			const preview = trouble ? fg("error", trouble) : fg("toolOutput", plainPreview(r.output) || "(empty answer)");
			return `${runHeader(r, fg)} ${preview}`;
		});
		return new Lines([...lines, ...footer], ellipsis);
	}

	const container = new Container();
	const markdown = getMarkdownTheme();
	view.runs.forEach((r, i) => {
		if (i > 0) container.addChild(new Spacer(1));
		container.addChild(new Lines([runHeader(r, fg)], ellipsis));
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
