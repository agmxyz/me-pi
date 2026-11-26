// /autocompact <35-80|auto>: sets where Pi auto-compacts the current model, as a percentage of its context window.
// Pi does the compacting; this only writes compaction.modelOverrides["provider/id"].reserveTokens in the global
// settings file, since Pi compacts when context tokens exceed window - reserveTokens.
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export const MIN_PERCENT = 35;
export const MAX_PERCENT = 80;
// Pi keeps the most recent 20,000 tokens unsummarised by default; a threshold near that compacts almost every turn.
export const MIN_THRESHOLD_TOKENS = 60_000;

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

/** The share of `window` at which Pi compacts with `reserve` tokens reserved. */
export function thresholdPercent(window: number, reserve: number): number {
	return Math.max(0, Math.round((100 * (window - reserve)) / window));
}

export type Request = { kind: "show" } | { kind: "auto" } | { kind: "set"; percent: number } | { kind: "invalid" };

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
	return custom ? `auto ${thresholdPercent(model.contextWindow, resolveReserve(settings, model))}%` : "auto";
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
function writeGlobalReserve(manager: SettingsManager, key: string, reserve: number | undefined): boolean {
	// SettingsManager has no public setter for modelOverrides; its storage is private, so check the shape we rely on.
	const storage = (manager as any).storage;
	if (typeof storage?.withLock !== "function")
		throw new Error("this Pi version's SettingsManager has no settings storage to lock; nothing was written.");
	let changed = false;
	storage.withLock("global", (current: string | undefined) => {
		const settings = current ? JSON.parse(current.replace(/^\uFEFF/, "")) : {};
		if (!isObject(settings)) throw new Error("settings.json is not a JSON object; nothing was written.");
		changed = setModelReserve(settings, key, reserve);
		return changed ? JSON.stringify(settings, null, 2) : undefined;
	});
	return changed;
}

type Saved = { reserve: number; source: "project" | "global" | "setting" | "default" };

/** What the settings files on disk give `model`, and which part of them decides it. */
function savedReserve(manager: SettingsManager, model: ModelRef): Saved {
	const key = modelKey(model);
	const reserve = manager.getCompactionReserveTokens(model);
	if (manager.getProjectSettings().compaction?.modelOverrides?.[key]?.reserveTokens !== undefined)
		return { reserve, source: "project" };
	if (manager.getGlobalSettings().compaction?.modelOverrides?.[key]?.reserveTokens !== undefined)
		return { reserve, source: "global" };
	return { reserve, source: manager.getSettings().compaction?.reserveTokens !== undefined ? "setting" : "default" };
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
				`${thresholdPercent(window, reserve)}% (above ${tokens(window - reserve)} of ${tokens(window)} tokens)`;

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
			let changed = false;
			const lines: string[] = [];
			try {
				if (request.kind !== "show") changed = writeGlobalReserve(load(), key, reserve);
				const saved = savedReserve(load(), model);
				const active = resolveReserve(pi.getSettings(), model);
				const from = {
					project: `the override in ${projectPath}`,
					global: `the override in ${globalPath}`,
					setting: "compaction.reserveTokens (no per-model override)",
					default: "Pi's default (no override)",
				}[saved.source];
				if (request.kind === "set")
					lines.push(
						changed
							? `Saved ${request.percent}% for ${key} in ${globalPath}.`
							: `${key} is already at ${request.percent}%.`,
					);
				if (request.kind === "auto")
					lines.push(
						changed
							? `Removed the ${key} override from ${globalPath}.`
							: `${key} has no override in ${globalPath}.`,
					);
				lines.push(`${key} compacts at ${describe(saved.reserve)}, from ${from}.`);
				if (saved.source === "project" && request.kind !== "show")
					lines.push(`${projectPath} overrides this model, so the global value does not apply in this project.`);
				if (active === saved.reserve) return reply(`${lines.join("\n")}\nActive now.`);
				lines.push(`Not active yet: this session still compacts at ${describe(active)} until /reload.`);
			} catch (error) {
				return reply(`/autocompact: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			reply(`${lines.join("\n")}\n(${RELOAD_COST}.)`);
			// Never reload unasked: it ends background delegate jobs. Offer it only when it can run now.
			if (!changed || !ctx.hasUI || !ctx.isIdle()) return;
			// No comes first, so a reflexive Enter keeps running work; Escape keeps it too.
			const now = "Yes, reload now";
			const choice = await ctx.ui.select(`Reload to apply it? ${RELOAD_COST}.`, [
				"No, apply on the next /reload",
				now,
			]);
			if (choice !== now) return;
			try {
				await ctx.reload();
			} catch (error) {
				// Pi refuses a reload while streaming or compacting before it shuts anything down, so this ctx still works.
				reply(
					`Reload failed, so it is not active yet: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			// After a reload this ctx is stale: nothing may follow it.
		},
	});
}
