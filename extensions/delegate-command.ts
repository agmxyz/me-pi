/**
 * `/delegate` command: `status` (the default) shows the model set, missing tools, running workers, and
 * recent runs; `models` picks the model set from the models you can use and writes delegate.json.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ModelSet } from "./delegate.ts";

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

const short = (model: string) => model.split("/").pop() ?? model;
const seconds = (ms: number) => `${Math.round(ms / 1000)}s`;
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5);

/** The status report, one line per fact. */
export function statusLines(pi: ExtensionAPI, ctx: ExtensionCommandContext, deps: CommandDeps): string[] {
	const lines = [`Model set: ${deps.configPath()}`];
	try {
		const set = deps.loadModelSet();
		if (!set.models.length) lines.push("  none: workers use the session model; a call can name any model");
		const usable = new Set(ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`));
		const fallbackDefault = set.default ?? set.models.at(-1);
		set.models.forEach((m, i) => {
			const roles = [i === 0 && "scout", m === fallbackDefault && "default"].filter(Boolean).join(", ");
			const state = usable.has(m) ? "\u2713" : "\u2717 not available (no login or unknown id)";
			lines.push(`  ${i + 1}. ${m}${roles ? ` (${roles})` : ""} ${state}`);
		});
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

/** Picks the set step by step: filter, models in order (first = scout), default, confirm. */
// Returns true when the user wants a reload; the caller does it last, because the ctx is stale after it.
async function pickModels(ctx: ExtensionCommandContext, deps: CommandDeps): Promise<boolean> {
	const ui = ctx.ui;
	const stop = (message: string, type: "info" | "warning" = "info") => {
		ui.notify(message, type);
		return false;
	};
	const title = "Filter models: the start of provider/id, else any part (empty for all)";
	const filter = (await ui.input(title, "anthropic/"))?.trim().toLowerCase();
	if (filter === undefined) return stop("Delegate models: cancelled, nothing written.", "info");
	const all = ctx.modelRegistry.getAvailable().map((m) => ({ id: `${m.provider}/${m.id}`, cost: m.cost }));
	// "anthropic/" should not also list openrouter/anthropic/...: prefer ids that start with the filter.
	const starting = all.filter((m) => m.id.toLowerCase().startsWith(filter));
	const available = starting.length ? starting : all.filter((m) => m.id.toLowerCase().includes(filter));
	if (!available.length) return stop(`Delegate models: no available model matches "${filter}".`, "warning");

	const label = (m: (typeof available)[number]) => `${m.id}  $${m.cost.input}/$${m.cost.output} per M tokens`;
	const chosen: string[] = [];
	const done = "Done";
	for (;;) {
		const left = available.filter((m) => !chosen.includes(m.id));
		if (!left.length) break;
		const options = [...(chosen.length ? [done] : []), ...left.map(label)];
		const title = chosen.length
			? `Add model ${chosen.length + 1}, or Done (chosen: ${chosen.map(short).join(", ")})`
			: "Model 1 (the scout model; pick a cheap, fast one)";
		const pick = await ui.select(title, options);
		if (pick === undefined) return stop("Delegate models: cancelled, nothing written.", "info");
		if (pick === done) break;
		chosen.push(left[options.indexOf(pick) - (chosen.length ? 1 : 0)].id);
	}

	const last = `Last model (${short(chosen.at(-1) as string)})`;
	const pickedDefault =
		chosen.length > 1 ? await ui.select("Default model for the other roles", [last, ...chosen]) : last;
	if (pickedDefault === undefined) return stop("Delegate models: cancelled, nothing written.", "info");
	const set: ModelSet = { models: chosen, default: pickedDefault === last ? undefined : pickedDefault };

	const summary = `${chosen.map((m, i) => `${i + 1}. ${m}`).join("\n")}\nDefault: ${set.default ?? "the last model"}`;
	if (!(await ui.confirm(`Write ${deps.configPath()}?`, summary)))
		return stop("Delegate models: nothing written.", "info");
	deps.writeModelSet(set);

	// The tool's parameters show the set from the last load; a reload stops running workers.
	if (deps.active.size || !ctx.isIdle())
		return stop("Delegate models: written. Run /reload when no workers run to show the new set.", "info");
	if (await ui.confirm("Reload now?", "The tool's parameters show the model set from the last load.")) return true;
	return stop("Delegate models: written. Calls use it now; run /reload to show it in the tool's parameters.");
}

export function registerDelegateCommand(pi: ExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("delegate", {
		description: "Delegate workers: status (default), or models to pick the model set",
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
