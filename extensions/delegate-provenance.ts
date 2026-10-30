export type StopCause =
	| "wrap-up-limit"
	| "hard-timeout"
	| "hard-cost-limit"
	| "provider-retry-classified"
	| "guard-denial"
	| "worker-fence-denial"
	| "tool-failure"
	| "cancelled"
	| "session-ended"
	| "coordinator-lost"
	| "lock-refusal"
	| "integrity-tripwire";

export type StopResource =
	| "tool-time"
	| "hard-time"
	| "tool-cost"
	| "hard-cost"
	| "tool-calls"
	| "provider"
	| "guard"
	| "tool"
	| "coordination"
	| "checkout-lock"
	| "integrity"
	| "cancellation";

export type EffectState = "not-started" | "denied" | "completed" | "partial" | "unknown";
export type StopOwner = "delegate-parent" | "delegate-worker" | "guard" | "pi-runtime" | "implement";

/** Small owner-emitted stop fact. Cause is intentionally independent from the exhausted resource.
 * A correlated parent-owned Bash `tool-failure/completed` records a reported ordinary command exit; it never implies replay safety.
 */
export interface StopFact {
	owner: StopOwner;
	jobId: string;
	attempt: number;
	toolCallId?: string;
	cause: StopCause;
	resource: StopResource;
	effect: EffectState;
}

/** Outcome of one tool call. `completed` records the reported tool termination; only explicitly safe reads are replay-safe. */
export interface ToolEffectFact {
	owner: "pi-runtime";
	jobId: string;
	attempt: number;
	toolCallId: string;
	toolName: string;
	effect: EffectState;
	replaySafe: boolean;
	/** Pi observed partial tool output; this does not classify side effects. */
	partialResultObserved?: true;
}

/** Pi's structured auto_retry_start is the only available generic transient-provider verdict. */
export interface ProviderRetryFact {
	owner: "pi-runtime";
	jobId: string;
	attempt: number;
	provider: string;
	model: string;
	api: string;
	sourceEvent: "auto_retry_start";
	retry: number;
}

export interface AttemptProvenance {
	jobId: string;
	attempt: number;
	complete: boolean;
	stopFacts: StopFact[];
	toolEffects: ToolEffectFact[];
	providerRetry?: ProviderRetryFact;
}

/** Stored in tool-execution-end result details by the owning worker extension. */
export const TOOL_PROVENANCE_DETAIL_KEY = "__mePiDelegateProvenance";

export function isStopFact(value: unknown): value is StopFact {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const fact = value as Record<string, unknown>;
	return (
		["delegate-parent", "delegate-worker", "guard", "pi-runtime", "implement"].includes(String(fact.owner)) &&
		typeof fact.jobId === "string" &&
		Number.isSafeInteger(fact.attempt) &&
		(fact.attempt as number) > 0 &&
		(fact.toolCallId === undefined || typeof fact.toolCallId === "string") &&
		[
			"wrap-up-limit",
			"hard-timeout",
			"hard-cost-limit",
			"provider-retry-classified",
			"guard-denial",
			"worker-fence-denial",
			"tool-failure",
			"cancelled",
			"session-ended",
			"coordinator-lost",
			"lock-refusal",
			"integrity-tripwire",
		].includes(String(fact.cause)) &&
		[
			"tool-time",
			"hard-time",
			"tool-cost",
			"hard-cost",
			"tool-calls",
			"provider",
			"guard",
			"tool",
			"coordination",
			"checkout-lock",
			"integrity",
			"cancellation",
		].includes(String(fact.resource)) &&
		["not-started", "denied", "completed", "partial", "unknown"].includes(String(fact.effect))
	);
}

export function isProviderRetryFact(value: unknown): value is ProviderRetryFact {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const fact = value as Record<string, unknown>;
	return (
		fact.owner === "pi-runtime" &&
		typeof fact.jobId === "string" &&
		Number.isSafeInteger(fact.attempt) &&
		(fact.attempt as number) > 0 &&
		typeof fact.provider === "string" &&
		typeof fact.model === "string" &&
		typeof fact.api === "string" &&
		fact.sourceEvent === "auto_retry_start" &&
		Number.isSafeInteger(fact.retry) &&
		(fact.retry as number) > 0
	);
}
