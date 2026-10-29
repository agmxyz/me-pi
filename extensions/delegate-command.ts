/**
 * `/delegate` command: `status` (the default) shows per-model pool settings, availability, running workers,
 * and recent runs; `models` prints the config path for manual editing; `cancel <id>` stops a background job.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModelSet } from "./delegate.ts";
import { type Persona, shortModel as short } from "./delegate-render.ts";

/** One finished delegate call, kept for `/delegate status`. */
export interface CallRecord {
	at: number;
	role: string;
	models: string[];
	cost: number;
	ms: number;
	failed: boolean;
	/** implement: `branch base..tip`, the check's state, and whether finish made a WIP commit. */
	range?: string;
	check?: string;
	wip?: boolean;
}

/** A delegate call that is running now. */
export interface ActiveWorker {
	index: number;
	model: string;
	thinking: string;
	startedAt: number;
	active: boolean;
	lastTool?: string;
	persona: Persona;
}

export interface ActiveCall {
	role: string;
	models: string[];
	start: number;
	/** The background job id, for /delegate cancel. */
	job?: string;
	/** Compact foreground/preparation label for the activity widget. */
	displayId?: string;
	/** Current per-worker activity, kept on the existing active-call record. */
	workers?: ActiveWorker[];
	stage?: "Workers" | "Rebuttal";
}

export interface CommandDeps {
	configPath: () => string;
	loadModelSet: () => ModelSet;
	history: CallRecord[];
	active: Map<string, ActiveCall>;
	/** Stops a background job; returns what happened. */
	cancel: (id: string) => string;
}

// Tools that other extensions add; without them workers lose skills or the web.
const DEPENDENCIES = [
	["Skill", "this repo's extensions/skill.ts"],
	["web_search", "pi-web-access"],
	["fetch_content", "pi-web-access"],
	["get_search_content", "pi-web-access"],
];
const SUBCOMMANDS = ["status", "models", "cancel"];

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
			...(set.review ? ([["Review", set.review]] as const) : []),
		] as const) {
			const models = pool.models.length
				? pool.models
						.map((entry, i) => {
							const state = usable.has(entry.model) ? "\u2713" : "\u2717 not available (no login or unknown id)";
							return `${i + 1}. ${entry.model} (${entry.thinking}) ${state}`;
						})
						.join("; ")
				: `main session model (${pool.thinking ?? (name === "Scout" ? "main session thinking, capped at low" : "main session thinking")}, no fallback models)`;
			lines.push(`  ${name} pool: ${models}`);
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
	for (const a of active) {
		lines.push(`  ${a.job ? `${a.job} ` : ""}${a.role}: ${a.models.map(short).join(", ")} ${seconds(now - a.start)}`);
		const workers = a.workers ?? [];
		if (workers.length === 0) continue;
		lines.push(`    Stage: ${a.stage ?? "Workers"}`);
		for (const worker of workers.filter((entry) => entry.active)) {
			const index = workers.length > 1 ? ` ${worker.index}` : "";
			const progress = `    Worker${index}: ${short(worker.model)} @${worker.thinking} ${seconds(now - worker.startedAt)}`;
			lines.push(worker.lastTool ? `${progress} · ${worker.lastTool}` : progress);
		}
	}

	const total = deps.history.reduce((sum, r) => sum + r.cost, 0);
	lines.push(deps.history.length ? `Last ${deps.history.length} calls, $${total.toFixed(4)}:` : "Last calls: none");
	for (const r of [...deps.history].reverse()) {
		const mark = r.failed ? "\u2717" : "\u2713";
		lines.push(
			`  ${clock(r.at)} ${mark} ${r.role} ${r.models.map(short).join(", ")} $${r.cost.toFixed(4)} ${seconds(r.ms)}${r.range ? ` ${r.range} check ${r.check ?? "?"}${r.wip ? " WIP" : ""}` : ""}`,
		);
	}
	return lines;
}

function manualModelsMessage(deps: CommandDeps): string {
	return `Edit ${deps.configPath()} to set ordered models and per-model thinking, then run /reload.`;
}

export function registerDelegateCommand(pi: ExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("delegate", {
		description: "Delegate workers: status (default), models to show the manual config path, or cancel <id>",
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const [sub = "status", id] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "cancel") {
				if (!id) throw new Error("Usage: /delegate cancel <id>, with an id from /delegate status.");
				return ctx.ui.notify(deps.cancel(id), "info");
			}
			if (sub === "status") return ctx.ui.notify(statusLines(pi, ctx, deps).join("\n"), "info");
			if (sub === "models") return ctx.ui.notify(manualModelsMessage(deps), "info");
			throw new Error(`Unknown /delegate subcommand "${sub}". Use: ${SUBCOMMANDS.join(", ")}.`);
		},
	});
}
