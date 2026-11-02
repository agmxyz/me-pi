import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// --- Model pools ----------------------------------------------------------------------------------

export interface ModelEntry {
	model: string;
	thinking: string;
}

export interface ModelPool {
	/** The first entry is the role default; every entry sets the thinking level when a run names that model. */
	models: ModelEntry[];
	/** Thinking for models without an entry (the session model when the pool is empty); omitted means the main session's level. */
	thinking?: string;
}

export interface ModelSet {
	version: 3;
	scout: ModelPool;
	worker: ModelPool;
	review?: ModelPool;
	/** Skills read-only workers may see and load; omitted means all. `implement` always sees all. */
	readOnlySkills?: string[];
}

const defaultModelSet = (): ModelSet => ({
	version: 3,
	scout: { models: [] },
	worker: { models: [] },
});

export function configPath(): string {
	return process.env.ME_PI_DELEGATE_CONFIG || join(HOME, ".pi", "agent", "delegate.json");
}

/** A missing file means both pools use the main session's model and thinking. */
export function loadModelSet(path = configPath()): ModelSet {
	if (!existsSync(path)) return defaultModelSet();
	const where = `delegate config ${path}`;
	let raw: any;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (err: any) {
		throw new Error(`${where}: ${err?.message ?? err}`);
	}
	return validModelSet(raw, where);
}

function modelEntries(value: unknown, where: string, scout: boolean): ModelEntry[] {
	if (!Array.isArray(value)) throw new Error(`${where} must be an array of { model, thinking } entries`);
	const seen = new Set<string>();
	return value.map((entry, i) => {
		const itemWhere = `${where}[${i}]`;
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new Error(`${itemWhere}: expected an object`);
		const unknown = Object.keys(entry).filter((k) => k !== "model" && k !== "thinking");
		if (unknown.length)
			throw new Error(`${itemWhere}: unknown key(s) ${unknown.join(", ")} (allowed: model, thinking)`);
		if (typeof entry.model !== "string" || !entry.model.trim())
			throw new Error(`${itemWhere}.model must be a non-empty model id`);
		if (seen.has(entry.model)) throw new Error(`${where} lists model ${JSON.stringify(entry.model)} twice`);
		seen.add(entry.model);
		const levels = scout ? ["low", "off"] : THINKING_LEVELS;
		if (!levels.includes(entry.thinking))
			throw new Error(`${itemWhere}.thinking must be one of ${levels.join(", ")}`);
		return { model: entry.model, thinking: entry.thinking };
	});
}

function poolThinking(value: unknown, where: string, scout: boolean): string {
	const levels = scout ? ["low", "off"] : THINKING_LEVELS;
	if (typeof value !== "string" || !levels.includes(value))
		throw new Error(`${where} must be one of ${levels.join(", ")}`);
	return value as string;
}

function validV3Pool(raw: any, where: string, scout: boolean): ModelPool {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: expected an object`);
	const unknown = Object.keys(raw).filter((k) => k !== "models" && k !== "thinking");
	if (unknown.length) throw new Error(`${where}: unknown key(s) ${unknown.join(", ")} (allowed: models, thinking)`);
	const models = modelEntries(raw.models, `${where}.models`, scout);
	if (raw.thinking === undefined) return { models };
	return { models, thinking: poolThinking(raw.thinking, `${where}.thinking`, scout) };
}

function validModelSet(raw: any, where: string): ModelSet {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where}: expected a JSON object`);
	if (raw.version !== 3)
		throw new Error(
			`${where}: unsupported format (version ${JSON.stringify(raw.version ?? null)}); expected "version": 3 with { model, thinking } pool entries. Rewrite it as shown in docs/delegate.md ("Configure model pools").`,
		);
	const allowed = ["version", "scout", "worker", "review", "readOnlySkills"];
	const unknown = Object.keys(raw).filter((k) => !allowed.includes(k));
	if (unknown.length)
		throw new Error(`${where}: unknown key(s) ${unknown.join(", ")} (allowed: ${allowed.join(", ")})`);
	return {
		version: 3,
		scout: validV3Pool(raw.scout, `${where}.scout`, true),
		worker: validV3Pool(raw.worker, `${where}.worker`, false),
		...(raw.review !== undefined ? { review: validV3Pool(raw.review, `${where}.review`, false) } : {}),
		...(raw.readOnlySkills !== undefined ? { readOnlySkills: skillNames(raw.readOnlySkills, where) } : {}),
	};
}

function skillNames(value: unknown, where: string): string[] {
	if (!Array.isArray(value) || value.some((s) => typeof s !== "string" || !s.trim()))
		throw new Error(`${where}.readOnlySkills must be an array of skill names`);
	if (new Set(value).size !== value.length) throw new Error(`${where}.readOnlySkills lists a skill twice`);
	return value;
}

export interface RunSpec {
	model?: string;
	thinking?: string;
}

export interface ResolvedRun {
	/** An undefined model means Pi's session model. */
	model?: string;
	thinking: string;
}

/** Scouts use low/off; all other roles use the selected model's configured thinking level. */
export function resolveRun(
	role: string,
	run: RunSpec,
	set: ModelSet,
	sessionModel?: string,
	sessionThinking?: string,
): ResolvedRun {
	const scout = role === "scout";
	const poolName = scout ? "scout" : role === "review" && set.review ? "review" : "worker";
	const pool = set[poolName] ?? set.worker;
	// Models without an entry: the pool's level, else the main session's.
	const unlisted = () => {
		const thinking = run.thinking ?? pool.thinking ?? sessionThinking;
		if (!thinking)
			throw new Error(
				`the main session's thinking level is unknown; set ${poolName}.thinking in ${configPath()} or pass runs[].thinking`,
			);
		return thinking;
	};
	const configuredEntries = [...set.scout.models, ...set.worker.models, ...(set.review?.models ?? [])];
	const selected = run.model
		? {
				model: run.model,
				thinking:
					pool.models.find((entry) => entry.model === run.model)?.thinking ??
					configuredEntries.find((entry) => entry.model === run.model)?.thinking ??
					unlisted(),
			}
		: (pool.models[0] ?? { model: sessionModel, thinking: unlisted() });
	const requested = run.thinking ?? selected.thinking;
	return { model: selected.model, thinking: scout ? (requested === "off" ? "off" : "low") : requested };
}

export function configuredModels(set: ModelSet): string[] {
	return [
		...new Set(
			[...set.scout.models, ...set.worker.models, ...(set.review?.models ?? [])].map((entry) => entry.model),
		),
	];
}

export interface ModelAvailabilityRegistry {
	find(provider: string, modelId: string): { provider: string; id: string } | undefined;
	getAvailable(): readonly { provider: string; id: string }[];
	hasConfiguredAuth(model: { provider: string; id: string }): boolean;
}

/** Validate unlisted explicit models without inspecting or returning credential material. */
export function validateOneOffModel(modelId: string, registry: unknown): void {
	const separator = modelId.indexOf("/");
	if (separator <= 0 || separator === modelId.length - 1)
		throw new Error(`model ${JSON.stringify(modelId)} must be an exact Pi model ID in provider/model form`);
	const provider = modelId.slice(0, separator);
	const id = modelId.slice(separator + 1);
	const api = registry as ModelAvailabilityRegistry | undefined;
	if (
		!api ||
		typeof api.find !== "function" ||
		typeof api.getAvailable !== "function" ||
		typeof api.hasConfiguredAuth !== "function"
	)
		throw new Error(
			`cannot validate model ${JSON.stringify(modelId)}: Pi's model registry lacks catalog/auth lookup`,
		);
	const model = api.find(provider, id);
	if (!model || model.provider !== provider || model.id !== id)
		throw new Error(`unknown model ${JSON.stringify(modelId)}: no exact provider/model match in Pi's catalog`);
	const available = api.getAvailable();
	if (!Array.isArray(available)) throw new Error("Pi's model registry returned an invalid available-model list");
	if (available.some((candidate) => candidate.provider === provider && candidate.id === id)) return;
	if (!api.hasConfiguredAuth(model))
		throw new Error(
			`model ${JSON.stringify(modelId)} is unauthenticated: Pi has no configured authentication for provider ${JSON.stringify(provider)}`,
		);
	throw new Error(
		`model ${JSON.stringify(modelId)} is unavailable: Pi does not list it as available; provider authentication may not be usable`,
	);
}
