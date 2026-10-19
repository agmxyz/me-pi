/**
 * `/delegate` command: `status` (the default) shows the scout/worker pools, missing tools, running workers,
 * and recent runs; `models` picks each ordered model pool and thinking level, then writes delegate.json.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type ModelSet, THINKING_LEVELS } from "./delegate.ts";
import { ModelSetPicker } from "./delegate-picker.ts";
import { shortModel as short } from "./delegate-render.ts";

/** One finished delegate call, kept for `/delegate status`. */
export interface CallRecord {
	at: number;
	role: string;
	models: string[];
	cost: number;
	ms: number;
	failed: boolean;
}

/** A delegate call that is running now. */
export interface ActiveCall {
	role: string;
	models: string[];
	start: number;
}

export interface CommandDeps {
	configPath: () => string;
	loadModelSet: () => ModelSet;
	writeModelSet: (set: ModelSet) => void;
	history: CallRecord[];
	active: Map<string, ActiveCall>;
}

// Tools that other extensions add; without them workers lose skills or the web.
const DEPENDENCIES = [
	["Skill", "this repo's extensions/skill.ts"],
	["web_search", "pi-web-access"],
	["fetch_content", "pi-web-access"],
	["get_search_content", "pi-web-access"],
];
const SUBCOMMANDS = ["status", "models"];

const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);

/** The status report, one line per fact. */
export function statusLines(pi: ExtensionAPI, ctx: ExtensionCommandContext, deps: CommandDeps): string[] {
	const lines = [`Model pools: ${deps.configPath()}`];
	try {
		const set = deps.loadModelSet();
		const usable = new Set(ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`));
		for (const [name, pool] of [
			["Scout", set.scout],
			["Worker", set.worker],
		] as const) {
			const models = pool.models.length
				? pool.models
						.map((m, i) => {
							const state = usable.has(m) ? "\u2713" : "\u2717 not available (no login or unknown id)";
							return `${i + 1}. ${m} ${state}`;
						})
						.join("; ")
				: "session model (no fallback models)";
			lines.push(`  ${name} pool (${pool.thinking}): ${models}`);
		}
	} catch (err: any) {
		lines.push(`  \u2717 ${err?.message ?? err}`);
	}

	const tools = new Set(pi.getAllTools().map((t) => t.name));
	const missing = DEPENDENCIES.filter(([name]) => !tools.has(name));
	lines.push(
		missing.length
			? `Tools: missing ${missing.map(([name, from]) => `${name} (${from})`).join(", ")}`
			: "Tools: Skill and the web tools are installed",
	);

	const now = Date.now();
	const active = [...deps.active.values()];
	lines.push(active.length ? `Running (${active.length}):` : "Running: none");
	for (const a of active) lines.push(`  ${a.role}: ${a.models.map(short).join(", ")} ${seconds(now - a.start)}`);

	const total = deps.history.reduce((sum, r) => sum + r.cost, 0);
	lines.push(deps.history.length ? `Last ${deps.history.length} calls, $${total.toFixed(4)}:` : "Last calls: none");
	for (const r of [...deps.history].reverse()) {
		const mark = r.failed ? "\u2717" : "\u2713";
		lines.push(
			`  ${clock(r.at)} ${mark} ${r.role} ${r.models.map(short).join(", ")} $${r.cost.toFixed(4)} ${seconds(r.ms)}`,
		);
	}
	return lines;
}

/** Picks both ordered pools and their thinking levels, then writes only after confirmation. */
// Returns true when the user wants a reload; the caller does it last, because the ctx is stale after it.
async function pickModels(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<boolean> {
	const ui = ctx.ui;
	const stop = (message: string, type: "info" | "warning" = "info") => {
		ui.notify(message, type);
		return false;
	};
	const models = ctx.modelRegistry
		.getAvailable()
		.map((m) => ({ id: `${m.provider}/${m.id}`, name: m.name, cost: m.cost }));
	if (!models.length) return stop("Delegate models: no model is available; log in to a provider first.", "warning");
	let current: ModelSet = {
		version: 2,
		scout: { models: [], thinking: "low" },
		worker: { models: [], thinking: "max" },
	};
	try {
		current = deps.loadModelSet();
	} catch (err: any) {
		ui.notify(
			`Delegate models: the current pools are unreadable, starting empty (${err?.message ?? err}).`,
			"warning",
		);
	}
	const pickPool = async (title: string, chosen: string[]) =>
		ui.custom<string[] | null>(
			(_tui, theme, _keybindings, done) => new ModelSetPicker(models, chosen, theme.fg.bind(theme), done, title),
		);
	const scoutModels = await pickPool("Scout model pool (ordered)", current.scout.models);
	if (scoutModels === undefined)
		throw new Error("/delegate models needs the interactive TUI; edit delegate.json by hand instead.");
	if (scoutModels === null) return stop("Delegate models: cancelled, nothing written.");
	const scoutThinking = await ui.select("Scout thinking", [
		current.scout.thinking,
		...["low", "off"].filter((x) => x !== current.scout.thinking),
	]);
	if (scoutThinking === undefined) return stop("Delegate models: cancelled, nothing written.");

	const workerModels = await pickPool("Worker model pool (ordered)", current.worker.models);
	if (workerModels === undefined)
		throw new Error("/delegate models needs the interactive TUI; edit delegate.json by hand instead.");
	if (workerModels === null) return stop("Delegate models: cancelled, nothing written.");
	const workerThinking = await ui.select("Worker thinking", [
		current.worker.thinking,
		...THINKING_LEVELS.filter((x) => x !== current.worker.thinking),
	]);
	if (workerThinking === undefined) return stop("Delegate models: cancelled, nothing written.");

	const set: ModelSet = {
		version: 2,
		scout: { models: scoutModels, thinking: scoutThinking },
		worker: { models: workerModels, thinking: workerThinking },
	};
	const lines = (name: string, pool: ModelSet["scout"]) =>
		`${name} (${pool.thinking}): ${pool.models.length ? pool.models.join(" → ") : "session model only"}`;
	const summary = `${lines("Scout pool", set.scout)}\n${lines("Worker pool", set.worker)}`;
	if (!(await ui.confirm(`Write ${deps.configPath()}?`, summary)))
		return stop("Delegate models: nothing written.", "info");
	deps.writeModelSet(set);

	// The tool's parameters show the set from the last load; a reload stops running workers.
	if (deps.active.size || !ctx.isIdle())
		return stop("Delegate models: written. Run /reload when no workers run to show the new pools.", "info");
	if (await ui.confirm("Reload now?", "The tool's parameters show the pools from the last load.")) return true;
	return stop("Delegate models: written. Calls use them now; run /reload to show them in the tool's parameters.");
}

export function registerDelegateCommand(pi: ExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("delegate", {
		description: "Delegate workers: status (default), or models to pick the scout/worker pools and thinking levels",
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const sub = args.trim() || "status";
			if (sub === "status") return ctx.ui.notify(statusLines(pi, ctx, deps).join("\n"), "info");
			if (sub === "models") {
				// Thrown errors reach Pi's extension error report in every mode; notify may show nothing.
				if (!ctx.hasUI) throw new Error("/delegate models needs the interactive UI.");
				if (await pickModels(ctx, deps)) await ctx.reload(); // The ctx is stale after this.
				return;
			}
			throw new Error(`Unknown /delegate subcommand "${sub}". Use: ${SUBCOMMANDS.join(", ")}.`);
		},
	});
}
