// /autocompact <35-80|auto>: sets where Pi auto-compacts the current model, as a percentage of its context window.
// Pi does the compacting; this only writes compaction.modelOverrides["provider/id"].reserveTokens in the global
// settings file (~/.pi/agent/settings.json, never a project file), since Pi compacts when context tokens exceed
// window - reserveTokens. The value follows the model across projects, but a project .pi/settings.json entry for the
// same model wins; the reply says so.
// - The write is a read-modify-write under Pi's own settings lock and keeps every other key; `auto` removes only
//   reserveTokens and drops an entry left empty.
// - A threshold under 60,000 tokens is refused: Pi keeps the last 20,000 tokens unsummarised by default, so it would
//   compact almost every turn.
// - A running session reads settings only on /reload, which ends background delegate jobs. So the command never
//   reloads unasked: the reply says whether the value is active now, and when the agent is idle it offers the reload
//   with "No" first.
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

const MIN_PERCENT = 35;
const MAX_PERCENT = 80;
// Pi keeps the most recent 20,000 tokens unsummarised by default; a threshold near that compacts almost every turn.
const MIN_THRESHOLD_TOKENS = 60_000;

type ModelRef = { provider: string; id: string };
type Settings = ReturnType<SettingsManager["getSettings"]>;

const modelKey = (model: ModelRef) => `${model.provider}/${model.id}`;
const tokens = (count: number) => count.toLocaleString("en-US");
const isObject = (value: unknown): value is Record<string, any> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The reserveTokens that makes Pi compact at `percent` of `window`. */
export function reserveTokensFor(window: number, percent: number): number {
	return Math.round(window * (1 - percent / 100));
}

/** The share of `window` at which Pi compacts with `reserve` tokens reserved; 0 when it compacts on any context. */
function thresholdPercent(window: number, reserve: number): number {
	return Math.max(0, Math.round((100 * (window - reserve)) / window));
}

type Request = { kind: "show" } | { kind: "auto" } | { kind: "set"; percent: number } | { kind: "invalid" };

export function parseRequest(args: string): Request {
	const arg = args.trim();
	if (arg === "") return { kind: "show" };
	if (arg === "auto") return { kind: "auto" };
	if (!/^\d+$/.test(arg)) return { kind: "invalid" };
	const percent = Number(arg);
	return percent >= MIN_PERCENT && percent <= MAX_PERCENT ? { kind: "set", percent } : { kind: "invalid" };
}

/** Reserve tokens Pi resolves for `model` from merged settings (model override, then compaction.reserveTokens, then default). */
function resolveReserve(settings: Settings, model: ModelRef): number {
	return SettingsManager.inMemory(settings).getCompactionReserveTokens(model);
}

/**
 * The footer's compaction label from the session's active settings: undefined when auto-compaction is off, "auto" on
 * Pi's default threshold, "auto 50%" when a setting moves it for this model. Throws on an invalid setting, as Pi does.
 */
export function compactionLabel(settings: Settings, model: (ModelRef & { contextWindow: number }) | undefined) {
	if (settings.compaction?.enabled === false) return undefined;
	if (!model || !(model.contextWindow > 0)) return "auto";
	const custom =
		settings.compaction?.reserveTokens !== undefined ||
		settings.compaction?.modelOverrides?.[modelKey(model)]?.reserveTokens !== undefined;
	if (!custom) return "auto";
	const reserve = resolveReserve(settings, model);
	// A reserve at or above the window makes Pi compact on every turn.
	return reserve >= model.contextWindow
		? "auto every turn"
		: `auto ${thresholdPercent(model.contextWindow, reserve)}%`;
}

/**
 * Sets (or with `reserve` undefined, removes) `reserveTokens` for `key` in a parsed settings object, keeping every
 * other key; an override entry left empty is dropped. Returns whether anything changed.
 */
export function setModelReserve(settings: Record<string, any>, key: string, reserve: number | undefined): boolean {
	const where = `compaction.modelOverrides["${key}"]`;
	if (settings.compaction !== undefined && !isObject(settings.compaction))
		throw new Error("compaction in settings.json is not an object; fix it by hand first.");
	const overrides = settings.compaction?.modelOverrides;
	if (overrides !== undefined && !isObject(overrides))
		throw new Error("compaction.modelOverrides in settings.json is not an object; fix it by hand first.");
	const entry = overrides?.[key];
	if (entry !== undefined && !isObject(entry))
		throw new Error(`${where} in settings.json is not an object; fix it by hand first.`);
	if (reserve === undefined) {
		if (entry?.reserveTokens === undefined) return false;
		delete entry.reserveTokens;
		if (Object.keys(entry).length === 0) delete overrides[key];
		return true;
	}
	if (entry?.reserveTokens === reserve) return false;
	settings.compaction ??= {};
	settings.compaction.modelOverrides ??= {};
	settings.compaction.modelOverrides[key] = { ...entry, reserveTokens: reserve };
	return true;
}

/** Read-modify-write of the global settings file under Pi's own settings lock, so concurrent Pi writes are not lost. */
export async function writeGlobalReserve(
	manager: SettingsManager,
	key: string,
	reserve: number | undefined,
): Promise<boolean> {
	// SettingsManager has no public setter for modelOverrides, so this reaches its private storage; replace it with that
	// setter, and drop these checks, once Pi has one.
	const storage = (manager as any).storage;
	if (typeof storage?.withLock !== "function")
		throw new Error("this Pi version's SettingsManager has no settings storage to lock; nothing was written.");
	let ran = false;
	let changed = false;
	// Pi 1.6's withLock is synchronous; awaiting also covers an async one, and `ran` catches one that never calls back.
	await storage.withLock("global", (current: string | undefined) => {
		ran = true;
		const settings = current ? JSON.parse(current.replace(/^\uFEFF/, "")) : {};
		if (!isObject(settings)) throw new Error("settings.json is not a JSON object; nothing was written.");
		changed = setModelReserve(settings, key, reserve);
		return changed ? JSON.stringify(settings, null, 2) : undefined;
	});
	if (!ran) throw new Error("Pi's settings lock returned without running the update; nothing was written.");
	return changed;
}

type Saved = {
	reserve: number;
	source: "project" | "global" | "project setting" | "global setting" | "default";
};

/** What the settings files on disk give `model`, and which part of them decides it. */
function savedReserve(manager: SettingsManager, model: ModelRef): Saved {
	const key = modelKey(model);
	const reserve = manager.getCompactionReserveTokens(model);
	if (manager.getProjectSettings().compaction?.modelOverrides?.[key]?.reserveTokens !== undefined)
		return { reserve, source: "project" };
	if (manager.getGlobalSettings().compaction?.modelOverrides?.[key]?.reserveTokens !== undefined)
		return { reserve, source: "global" };
	if (manager.getProjectSettings().compaction?.reserveTokens !== undefined)
		return { reserve, source: "project setting" };
	if (manager.getGlobalSettings().compaction?.reserveTokens !== undefined)
		return { reserve, source: "global setting" };
	return { reserve, source: "default" };
}

const RELOAD_COST = "/reload restarts extensions and ends running background delegate jobs";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("autocompact", {
		description: `Compact the current model at ${MIN_PERCENT}-${MAX_PERCENT}% of its window, or auto for Pi's setting: /autocompact [percent|auto]`,
		getArgumentCompletions: (prefix) =>
			["auto", "40", "50", "60", "70"]
				.filter((value) => value.startsWith(prefix.trim()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const reply = (message: string, type: "info" | "warning" | "error" = "info") => ctx.ui.notify(message, type);
			const request = parseRequest(args);
			if (request.kind === "invalid")
				return reply(
					`Usage: /autocompact [${MIN_PERCENT}-${MAX_PERCENT}|auto] (a whole percentage, or auto).`,
					"error",
				);
			const model = ctx.model;
			if (!model) return reply("No model selected; pick one with /model first.", "error");
			const key = modelKey(model);
			const window = model.contextWindow;
			if (!(window > 0)) return reply(`${key} reports no context window, so a percentage cannot be set.`, "error");
			const describe = (reserve: number) =>
				reserve >= window
					? `on every turn (its reserve of ${tokens(reserve)} tokens is not below its ${tokens(window)}-token window)`
					: `at ${thresholdPercent(window, reserve)}% (above ${tokens(window - reserve)} of ${tokens(window)} tokens)`;

			let reserve: number | undefined;
			if (request.kind === "set") {
				reserve = reserveTokensFor(window, request.percent);
				if (window - reserve < MIN_THRESHOLD_TOKENS)
					return reply(
						`Not set: ${request.percent}% of ${key}'s ${tokens(window)}-token window is ${tokens(window - reserve)} tokens, under the ${tokens(MIN_THRESHOLD_TOKENS)}-token floor. Pi keeps the last 20,000 tokens unsummarised by default, so it would compact almost every turn.`,
						"error",
					);
			}

			const globalPath = join(getAgentDir(), "settings.json");
			const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
			const load = () => SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
			const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
			let changed = false;
			try {
				if (request.kind !== "show") changed = await writeGlobalReserve(load(), key, reserve);
			} catch (error) {
				return reply(`/autocompact: nothing was written: ${message(error)}`, "error");
			}
			const lines: string[] = [];
			if (request.kind === "set")
				lines.push(
					changed
						? `Saved ${request.percent}% for ${key} in ${globalPath}.`
						: `${request.percent}% for ${key} was already saved in ${globalPath}.`,
				);
			if (request.kind === "auto")
				lines.push(
					changed ? `Removed the ${key} override from ${globalPath}.` : `${key} has no override in ${globalPath}.`,
				);
			let active: number;
			try {
				const manager = load();
				const saved = savedReserve(manager, model);
				active = resolveReserve(pi.getSettings(), model);
				const from = {
					project: `the override in ${projectPath}`,
					global: `the override in ${globalPath}`,
					"project setting": `compaction.reserveTokens in ${projectPath} (no per-model override)`,
					"global setting": `compaction.reserveTokens in ${globalPath} (no per-model override)`,
					default: "Pi's default (no override)",
				}[saved.source];
				lines.push(`${key} compacts ${describe(saved.reserve)}, from ${from}.`);
				if (saved.source === "project" && request.kind !== "show")
					lines.push(`${projectPath} overrides this model, so the global value does not apply in this project.`);
				if (!manager.getCompactionEnabled()) lines.push("Auto-compaction is off (compaction.enabled is false).");
				if (active === saved.reserve) return reply(`${lines.join("\n")}\nActive now.`);
			} catch (error) {
				// The write may already have happened: report it beside the failure, not as a failure alone.
				return reply([...lines, `Could not read the resulting threshold: ${message(error)}`].join("\n"), "error");
			}
			lines.push(`Not active yet: this session still compacts ${describe(active)} until /reload.`);
			// Never reload unasked: it ends background delegate jobs. Offer it after a change, only when it can run now.
			if (request.kind === "show" || !ctx.hasUI || !ctx.isIdle())
				return reply(`${lines.join("\n")}\n(${RELOAD_COST}.)`);
			// No comes first, so a reflexive Enter keeps running work; Escape keeps it too.
			const now = "Yes, reload now";
			const choice = await ctx.ui.select(`Reload to apply it? ${RELOAD_COST}.`, [
				"No, apply on the next /reload",
				now,
			]);
			if (choice !== now) return reply(`${lines.join("\n")}\n(${RELOAD_COST}.)`);
			reply(`${lines.slice(0, -1).join("\n")}\nReloading to make it active.`);
			try {
				await ctx.reload();
			} catch (error) {
				// Pi refuses a reload while streaming or compacting before it shuts anything down, so this ctx still works.
				reply(`Reload failed, so it is not active yet: ${message(error)}`, "warning");
			}
			// After a reload this ctx is stale: nothing may follow it.
		},
	});
}
