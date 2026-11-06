import type { FailedToolCallInput, FailedToolDisposition } from "./delegate-artifacts.ts";

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

/**
 * What a provider error says about the failure, never about effects: `infra` (provider HTTP/transport trouble),
 * `account` (quota, key, or billing limit; retrying cannot help), or `model/task`.
 */
export type FailureClass = "infra" | "account" | "model/task";

/** Names an infra or account failure and any same-model retries; a model/task failure needs no extra line. */
export function failureClassLine(r: { failureClass?: FailureClass; infraRetries?: string[] }): string {
	const retries = r.infraRetries?.length ?? 0;
	const retried = retries ? `; retried ${retries}× on the same model` : "";
	if (r.failureClass === "infra") return `\nFailure class: infra (provider or network, not the task)${retried}.`;
	if (r.failureClass === "account")
		return `\nFailure class: account (quota, key, or billing limit)${retried}; BLOCKER: retrying cannot help.`;
	return retries ? `\nFailure class: model/task${retried} after infra failures.` : "";
}

export type EventRecord = Record<string, any>;

export function eventRecord(value: unknown): EventRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as EventRecord) : undefined;
}

export function eventText(record: EventRecord | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

export function eventField(record: EventRecord | undefined, key: string): { present: boolean; value?: unknown } {
	if (!record || !Object.hasOwn(record, key)) return { present: false };
	return { present: true, value: record[key] };
}

function firstEventField(...fields: { present: boolean; value?: unknown }[]): { present: boolean; value?: unknown } {
	return fields.find((field) => field.present) ?? { present: false };
}

// Only the canonical status authorizes completion; known aliases can veto it, never replace it.
export function bashStatuses(resultValue: unknown): { exitCode?: number; diagnostics: string[] } {
	const result = eventRecord(resultValue);
	const structured = eventRecord(result?.structuredContent);
	const details = eventRecord(result?.details);
	const fields = [
		["structuredContent.exit_code", eventField(structured, "exit_code")],
		["structuredContent.exitCode", eventField(structured, "exitCode")],
		["details.exit_code", eventField(details, "exit_code")],
		["details.exitCode", eventField(details, "exitCode")],
		["exit_code", eventField(result, "exit_code")],
		["exitCode", eventField(result, "exitCode")],
	] as const;
	const canonical = fields[0][1].value;
	const valid =
		fields[0][1].present &&
		Number.isSafeInteger(canonical) &&
		fields
			.slice(1)
			.every(([, field]) => !field.present || (Number.isSafeInteger(field.value) && field.value === canonical));
	return {
		...(valid ? { exitCode: canonical as number } : {}),
		diagnostics: fields
			.filter(([, field]) => field.present)
			.map(([name, field]) => {
				const value = field.value;
				if (typeof value === "number") return `${name}=${value}`;
				// Only short numeric strings are useful status evidence; never serialize arbitrary metadata.
				if (typeof value === "string")
					return `${name}=string:${value.length <= 3 && /^\d+$/.test(value) ? value : "[REDACTED]"}`;
				if (typeof value === "boolean" || value === null) return `${name}=${String(value)}`;
				return `${name}=${typeof value}`;
			}),
	};
}

export function bashExitCode(resultValue: unknown): number | undefined {
	return bashStatuses(resultValue).exitCode;
}

export function toolResultText(result: EventRecord | undefined): string | undefined {
	if (!Array.isArray(result?.content)) return undefined;
	const text = result.content.flatMap((part: unknown) => {
		const item = eventRecord(part);
		return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
	});
	return text.length ? text.join("\n") : undefined;
}

export function failedToolResult(resultValue: unknown, toolName: string | undefined): FailedToolCallInput["result"] {
	const result = eventRecord(resultValue);
	const structured = eventRecord(result?.structuredContent);
	const details = eventRecord(result?.details);
	const content = toolResultText(result);
	const structuredOutput =
		eventText(structured, "output") ?? eventText(result, "output") ?? eventText(details, "output");
	const exitCode = firstEventField(
		eventField(structured, "exit_code"),
		eventField(structured, "exitCode"),
		eventField(details, "exit_code"),
		eventField(details, "exitCode"),
		eventField(result, "exit_code"),
		eventField(result, "exitCode"),
	);
	const structuredContent = eventField(result, "structuredContent");
	const summary = eventField(structured, "summary");
	const diagnostic = firstEventField(eventField(result, "childDiagnostics"), eventField(details, "childDiagnostics"));
	const diagnosticReferences = firstEventField(
		eventField(result, "childDiagnosticReferences"),
		eventField(details, "childDiagnosticReferences"),
	);
	const fullOutputPath = firstEventField(
		eventField(structured, "full_output_path"),
		eventField(structured, "fullOutputPath"),
		eventField(result, "full_output_path"),
		eventField(result, "fullOutputPath"),
		eventField(details, "full_output_path"),
		eventField(details, "fullOutputPath"),
	);
	const error = firstEventField(
		eventField(result, "error"),
		eventField(structured, "error"),
		eventField(details, "error"),
	);
	const summaryValue = summary.present ? summary.value : structuredContent.present ? structuredContent.value : content;
	return {
		...(exitCode.present ? { exitCode: exitCode.value as number } : {}),
		...(structuredOutput !== undefined || content !== undefined ? { outputText: structuredOutput ?? content } : {}),
		...(error.present ? { error: error.value as string } : {}),
		...(diagnostic.present ? { childDiagnostics: diagnostic.value as string | readonly string[] } : {}),
		...(toolName === "bash" && bashStatuses(resultValue).diagnostics.length
			? { statusDiagnostics: bashStatuses(resultValue).diagnostics }
			: {}),
		...(fullOutputPath.present ? { fullOutputPath: fullOutputPath.value as string } : {}),
		...(diagnosticReferences.present
			? { childDiagnosticReferences: diagnosticReferences.value as readonly string[] }
			: {}),
		...(toolName !== "bash" && summaryValue !== undefined ? { summary: summaryValue } : {}),
	};
}

// Read-only tools: a call, even a failed one, has no side effects.
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "Skill"]);

// Pi's edit tool throws these before it writes the file (core/tools/edit.js and edit-diff.js).
const EDIT_REJECTED_BEFORE_WRITE =
	/^(?:Could not find (?:the exact text|edits\[\d+\]) in |Found \d+ occurrences of |(?:edits\[\d+\]\.)?oldText must not be empty in |No changes made to |edits\[\d+\] and edits\[\d+\] overlap in |Could not edit file: |Edit tool input is invalid\.)/;

/** A failed read-only tool call, or an edit its tool rejected before writing, had no effect. */
export function failedWithoutEffect(toolName: string, result: unknown): boolean {
	if (READ_ONLY_TOOLS.has(toolName)) return true;
	return toolName === "edit" && EDIT_REJECTED_BEFORE_WRITE.test(toolResultText(eventRecord(result)) ?? "");
}

/** Names a failed call's cause for the failed-tools artifact, so readers need not infer it from the output text. */
export function failureDisposition(toolName: string | undefined, resultValue: unknown): FailedToolDisposition {
	const result = eventRecord(resultValue);
	const marker = eventRecord(result?.details)?.[TOOL_PROVENANCE_DETAIL_KEY];
	const causes = Array.isArray(marker) ? marker.filter(isStopFact).map((fact) => fact.cause) : [];
	if (causes.includes("wrap-up-limit")) return "budget-blocked";
	if (causes.includes("guard-denial") || causes.includes("worker-fence-denial")) return "guard-denied";
	if (causes.length) return "blocked";
	if (!toolName) return "unknown";
	if (toolName === "bash") {
		const exitCode = bashExitCode(resultValue);
		if (exitCode === 124 || /Command timed out after \d+ seconds/.test(toolResultText(result) ?? ""))
			return "timeout";
		return exitCode !== undefined && exitCode !== 0 ? "nonzero-exit" : "unknown";
	}
	if (!failedWithoutEffect(toolName, resultValue)) return "unknown";
	return toolName === "edit" ? "edit-rejected" : "read-failed";
}
