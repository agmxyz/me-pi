import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// --- Model pools ----------------------------------------------------------------------------------

export interface ModelEntry {
	model: string;
	thinking: string;
}

export interface ModelPool {
	/**
	 * The first entry is the role default (`review` may start on a later eligible entry while other reviews run,
	 * see resolveRuns); every entry sets the thinking level when a run names or is allocated that model.
	 */
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

function rolePool(role: string, set: ModelSet): { poolName: "scout" | "worker" | "review"; pool: ModelPool } {
	const poolName = role === "scout" ? "scout" : role === "review" && set.review ? "review" : "worker";
	return { poolName, pool: set[poolName] ?? set.worker };
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
	const { poolName, pool } = rolePool(role, set);
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

/** How a run's model was chosen: `shared` counts the other in-flight review runs already reserved on it. */
export interface RunAllocation {
	source: "pool" | "explicit" | "session";
	/** The pool entry a default run starts on (the first entry of duplicate aliases). */
	poolIndex?: number;
	shared: number;
}

export interface AllocatedRun extends ResolvedRun {
	allocation: RunAllocation;
}

export interface ResolveRunsOptions {
	sessionModel?: string;
	sessionThinking?: string;
	registry?: unknown;
	/** In-flight `review` runs per canonical model in this Pi process; read for `review` only. */
	occupied?: ReadonlyMap<string, number>;
}

/**
 * Resolve one call's runs to canonical models. `review` runs without a model start on the least-occupied eligible
 * entry of the review pool, counting `occupied` and runs placed earlier in the call; ties go to config order, so
 * a review started alone gets the first entry (no rotation). Entry 0 is always eligible; a later entry only when
 * Pi's registry resolves it to a usable model (metadata only, no probe). Entries with the same canonical identity
 * are one candidate. Explicit models stay exact and count as occupancy. Every other role keeps the first entry.
 */
export function resolveRuns(role: string, specs: RunSpec[], set: ModelSet, options: ResolveRunsOptions = {}) {
	const { sessionModel, sessionThinking, registry, occupied = new Map() } = options;
	const canonical = (model: string | undefined) =>
		model && model !== sessionModel ? canonicalModel(model, registry) : model;
	const { pool } = rolePool(role, set);
	const allocating = role === "review" && pool.models.length > 0;
	const load = new Map(allocating ? occupied : []);
	const reserve = (model: string | undefined) => {
		const shared = model ? (load.get(model) ?? 0) : 0;
		if (allocating && model) load.set(model, shared + 1);
		return shared;
	};
	const explicit = specs.map((spec) => {
		if (!spec.model) return undefined;
		const run = resolveRun(role, spec, set, sessionModel, sessionThinking);
		return { ...run, model: canonical(run.model) };
	});
	// Explicit runs reserve first, so a default run in the same call avoids them when it can.
	const explicitShared = explicit.map((run) => (run ? reserve(run.model) : 0));
	// Built on the first default run only, so an ambiguous entry 0 fails exactly when it would be dispatched.
	let candidates: { model: string; thinking: string; index: number }[] | undefined;
	const eligible = () => {
		if (candidates) return candidates;
		const first = pool.models[0];
		const found = [{ model: canonical(first.model) as string, thinking: first.thinking, index: 0 }];
		for (let index = 1; index < pool.models.length && isModelRefRegistry(registry); index++) {
			const entry = pool.models[index];
			const result = resolveModelRef(entry.model, registry);
			// Unknown, ambiguous, unauthenticated, or unavailable later entries are skipped, never an error.
			if (result.status !== "resolved" || !result.usable) continue;
			if (!found.some((c) => c.model === result.model))
				found.push({ model: result.model, thinking: entry.thinking, index });
		}
		candidates = found;
		return found;
	};
	return specs.map((spec, i): AllocatedRun => {
		const exact = explicit[i];
		if (exact) return { ...exact, allocation: { source: "explicit", shared: explicitShared[i] } };
		if (!allocating) {
			const run = resolveRun(role, spec, set, sessionModel, sessionThinking);
			const allocation: RunAllocation = pool.models.length
				? { source: "pool", poolIndex: 0, shared: 0 }
				: { source: "session", shared: 0 };
			return { ...run, model: canonical(run.model), allocation };
		}
		const pick = eligible().reduce((best, c) => ((load.get(c.model) ?? 0) < (load.get(best.model) ?? 0) ? c : best));
		const shared = reserve(pick.model);
		return {
			model: pick.model,
			thinking: spec.thinking ?? pick.thinking,
			allocation: { source: "pool", poolIndex: pick.index, shared },
		};
	});
}

export function configuredModels(set: ModelSet): string[] {
	return [
		...new Set(
			[...set.scout.models, ...set.worker.models, ...(set.review?.models ?? [])].map((entry) => entry.model),
		),
	];
}

interface CatalogModel {
	provider: string;
	id: string;
}

/** The part of Pi's ModelRegistry that model-reference resolution reads. */
export interface ModelRefRegistry {
	getAll(): readonly CatalogModel[];
	getAvailable(): readonly CatalogModel[];
	/** Pi's provider-level auth check; older Pi lacks it. */
	hasConfiguredAuth?(model: CatalogModel): boolean;
}

export type ModelRefResolution =
	| { status: "resolved"; model: string; provider: string; id: string; usable: boolean; authed: boolean }
	| { status: "ambiguous"; candidates: string[] }
	| { status: "unknown" };

export const isModelRefRegistry = (value: unknown): value is ModelRefRegistry =>
	!!value &&
	typeof (value as ModelRefRegistry).getAll === "function" &&
	typeof (value as ModelRefRegistry).getAvailable === "function";

/**
 * Resolve `provider/id` or a bare id like Pi's `--model` without fuzzy matching or thinking suffixes.
 * Mirrors pi-coding-agent dist/core/model-resolver.js `splitProviderPrefix` + `selectReference`.
 */
export function resolveModelRef(ref: string, registry: ModelRefRegistry): ModelRefResolution {
	const text = ref.trim();
	const all = registry.getAll();
	const available = registry.getAvailable();
	if (!Array.isArray(all) || !Array.isArray(available))
		throw new Error("Pi's model registry returned an invalid model list");
	// Pi breaks ties by provider-level configured auth (model-resolver.js `hasConfiguredAuth`).
	const authed = (m: CatalogModel) =>
		typeof registry.hasConfiguredAuth === "function"
			? registry.hasConfiguredAuth(m) === true
			: available.some((a) => a.provider === m.provider);
	const lower = text.toLowerCase();
	const raw = all.filter((m) => m.id.toLowerCase() === lower);
	let named: CatalogModel | undefined;
	const slash = text.indexOf("/");
	if (slash > 0) {
		const prefix = text.slice(0, slash).trim().toLowerCase();
		const rest = text
			.slice(slash + 1)
			.trim()
			.toLowerCase();
		const provider = rest ? all.find((m) => m.provider.toLowerCase() === prefix)?.provider : undefined;
		if (provider)
			named =
				all.find((m) => m.provider === provider && m.id.toLowerCase() === rest) ??
				raw.find((m) => m.provider === provider);
	}
	const others = raw.filter((m) => m !== named);
	const candidates = named ? [named, ...others] : others;
	const resolved = (m: CatalogModel): ModelRefResolution => ({
		status: "resolved",
		model: `${m.provider}/${m.id}`,
		provider: m.provider,
		id: m.id,
		usable: available.some((a) => a.provider === m.provider && a.id === m.id),
		authed: authed(m),
	});
	if (candidates.length === 0) return { status: "unknown" };
	if (new Set(candidates.map((m) => m.provider)).size === 1) return resolved(candidates[0]);
	if (named && authed(named)) return resolved(named);
	const authedOthers = others.filter(authed);
	if (authedOthers.length === 1) return resolved(authedOthers[0]);
	if (authedOthers.length === 0 && named) return resolved(named);
	return { status: "ambiguous", candidates: candidates.map((m) => `${m.provider}/${m.id}`) };
}

/** Validate unlisted explicit models without inspecting or returning credential material. */
export function validateOneOffModel(ref: string, registry: unknown): void {
	if (!isModelRefRegistry(registry))
		throw new Error(`cannot validate model ${JSON.stringify(ref)}: Pi's model registry lacks catalog/auth lookup`);
	const result = resolveModelRef(ref, registry);
	if (result.status !== "resolved") throw new Error(unresolvedMessage(ref, result));
	if (!result.usable && result.authed)
		throw new Error(`model ${JSON.stringify(ref)} is unavailable: Pi does not list it as available`);
	if (!result.usable)
		throw new Error(
			`model ${JSON.stringify(ref)} is unauthenticated: Pi lists no usable login for provider ${JSON.stringify(result.provider)}`,
		);
}

function unresolvedMessage(
	ref: string,
	result: Exclude<ModelRefResolution, { status: "resolved" }>,
	where = "",
): string {
	return result.status === "ambiguous"
		? `ambiguous model ${JSON.stringify(ref)}${where}: matches ${result.candidates.join(", ")}; write provider/id`
		: `unknown model ${JSON.stringify(ref)}${where}: no provider/id or model id match in Pi's catalog`;
}

/**
 * Canonical `provider/id` for a configured or one-off ref, so workers and retry correlation agree with Pi.
 * Without a registry, or for an unknown ref (Pi may still accept a custom id or `:thinking` suffix), the ref
 * passes through unchanged; an ambiguous ref fails as it would in Pi.
 */
export function canonicalModel(ref: string, registry: unknown): string {
	if (!isModelRefRegistry(registry)) return ref;
	const result = resolveModelRef(ref, registry);
	if (result.status === "unknown") return ref;
	if (result.status !== "resolved") throw new Error(unresolvedMessage(ref, result, ` in ${configPath()}`));
	return result.model;
}
