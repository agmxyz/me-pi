/**
 * Attempt ledger: interprets one worker attempt's Pi event records (tool capture, effect and stop provenance,
 * provider-retry correlation, usage and cost, failed-tool artifacts) into its RunResult. The caller owns the
 * process, timers, and abort signal; it feeds records here and asks the ledger to settle the result.
 */

import { type ArtifactWriteResult, boundedCallId, FAILED_TOOL_ARTIFACT_LIMITS } from "./delegate-artifacts.ts";
import { trackCheck } from "./delegate-implement.ts";
import {
	type AttemptProvenance,
	bashExitCode,
	bashStatuses,
	type EventRecord,
	eventField,
	eventRecord,
	eventText,
	type FailureClass,
	failedToolResult,
	failedWithoutEffect,
	failureDisposition,
	isProviderRetryFact,
	isStopFact,
	type ProviderRetryFact,
	READ_ONLY_TOOLS,
	type StopFact,
	type StopResource,
	TOOL_PROVENANCE_DETAIL_KEY,
	type ToolEffectFact,
} from "./delegate-provenance.ts";
import { costOf, type Job } from "./delegate-worker.ts";

export const MAX_TOOL_HISTORY = 8;
const PROGRESS_COALESCE_MS = 40;
const WORKER_TOOL_LABELS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"Skill",
	"web_search",
	"fetch_content",
	"get_search_content",
	"write",
	"edit",
	"bash",
]);

export interface RunResult {
	/** The model and thinking this run was started with (the model id Pi reports may lack the provider). */
	requested: { model?: string; thinking: string };
	web: boolean;
	/** With `output: true`: the worker's own fresh directory, and the files it holds after the run. */
	outDir?: string;
	files?: string[];
	model?: string;
	output: string;
	failure?: string;
	failureClass?: FailureClass;
	/** Failures of earlier attempts that were retried on the same model as infra failures. */
	infraRetries?: string[];
	provenance?: AttemptProvenance[];
	toolCallCount?: number;
	turns: number;
	usage: Record<string, any>;
	tools: string[];
	stderr: string;
	ms: number;
	failedToolCapture?: Exclude<ArtifactWriteResult, { status: "empty" }>;
}

const ACCOUNT_LIMIT =
	/usage limit|quota|insufficient[_ ](?:quota|credits|funds|balance)|billing|out of budget|available balance|key limit|(?:^|HTTP\s*|status(?:\s*code)?\s*:?\s*)40[13]\b|unauthori[sz]ed|invalid api key/i;
const INFRA_FAILURE =
	/(?:^|HTTP\s*|status(?:\s*code)?\s*:?\s*|code\s*:?\s*)(?:408|409|425|429|5\d\d)\b|overloaded|rate.?limit|too many requests|service.?(?:is.?)?(?:temporarily.?)?unavailable|server.?error|internal.?error|upstream|provider.?returned|network|connection|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|socket hang up|timed? ?out|timeout|stream ended|ended without|terminated/i;

export function classifyProviderError(message: string | undefined): FailureClass {
	if (!message) return "model/task";
	if (ACCOUNT_LIMIT.test(message)) return "account";
	return INFRA_FAILURE.test(message) ? "infra" : "model/task";
}

/** Adds numeric fields of a Pi usage object (including nested `cost`) into `total`. */
export function addUsage(total: Record<string, any>, usage: Record<string, any> | undefined) {
	for (const [key, value] of Object.entries(usage ?? {})) {
		if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
		else if (value && typeof value === "object") {
			total[key] ??= {};
			addUsage(total[key], value);
		}
	}
}

export interface AttemptBudget {
	/** The role's configured time limit, named in the timeout message; retries keep `hardDeadline`, so time left shrinks. */
	limitSecs: number;
	hardDeadline: number;
	hardCostCapUsd: number;
	toolDeadline: number;
	toolCostCapUsd: number;
	toolCalls: number | null;
}

type CapturedToolCall = {
	toolCallId?: string;
	toolName?: string;
	startedAt: number;
	rawArgsCommand?: string;
};

function toolLabel(name: string): string {
	const label = name
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 32);
	return WORKER_TOOL_LABELS.has(label) ? label : "tool";
}

export interface AttemptLedgerOptions {
	job: Job;
	run: { model?: string; thinking: string };
	cwd: string;
	outDir: string | undefined;
	budget: AttemptBudget;
	attemptIndex: number;
	onProgress: (r: RunResult) => void;
}

/**
 * One attempt's interpretation of Pi events. Records are handled synchronously in arrival order; a hard cost cap
 * reached while handling one calls the attached kill before `record` returns.
 */
export interface AttemptLedger {
	readonly result: RunResult;
	readonly provenance: AttemptProvenance;
	/** How the ledger stops the worker; without one (no pid), `stop` does nothing. */
	attach(kill: (() => void) | undefined): void;
	record(event: any): void;
	malformed(): void;
	stderr(chunk: string): void;
	killFailure(failure: string): void;
	parentFact(cause: StopFact["cause"], resource: StopResource, effect?: StopFact["effect"]): StopFact;
	/** Stops the worker once, unless the attempt already stopped or finished. */
	stop(reason: string, fact?: StopFact): void;
	/** Flushes unclosed calls, unknown effects, and pending progress; later stops are ignored (records are not guarded, as before). */
	close(): void;
	/** Derives the failure and its class from the exit and the events seen; call after `close`. */
	settle(code: number | null, problem?: string): RunResult;
}

export function createAttemptLedger({
	job,
	run,
	cwd,
	outDir,
	budget,
	attemptIndex,
	onProgress,
}: AttemptLedgerOptions): AttemptLedger {
	const { web, implement } = job;
	const provenance: AttemptProvenance = {
		jobId: job.jobId,
		attempt: attemptIndex,
		complete: true,
		stopFacts: [],
		toolEffects: [],
	};
	const result: RunResult = {
		requested: run,
		web,
		outDir,
		output: "",
		provenance: [provenance],
		toolCallCount: 0,
		turns: 0,
		usage: {},
		tools: [],
		stderr: "",
		ms: 0,
	};
	let kill: (() => void) | undefined;
	let stopped: string | undefined;
	let providerErrorClass: FailureClass | undefined;
	let finished = false;
	let lastStopReason: string | undefined;
	const calls = new Map<string, { tool: string; command: string }>();
	const captureCalls = new Map<string, CapturedToolCall[]>();
	const anonymousCaptureCalls: CapturedToolCall[] = [];
	const activeEffects = new Map<string, ToolEffectFact[]>();
	const seenToolCallIds = new Set<string>();
	// Separate from failed-tool artifacts: these are owner-reported successes with contradictory statuses.
	// The attempt-wide cap reuses maxDiagnosticsPerCall; each artifact record has its own childDiagnostics cap.
	const contradictorySuccesses: string[] = [];
	let omittedContradictorySuccesses = 0;
	let latestAssistantError: { provider: string; model: string; api: string } | undefined;

	let progressTimer: NodeJS.Timeout | undefined;
	let progressPending = false;
	const clearProgressTimer = () => {
		clearTimeout(progressTimer);
		progressTimer = undefined;
	};
	const cancelPendingProgress = () => {
		clearProgressTimer();
		progressPending = false;
	};
	const flushProgress = () => {
		clearProgressTimer();
		if (!progressPending) return;
		progressPending = false;
		onProgress(result);
	};
	const scheduleProgress = () => {
		progressPending = true;
		if (progressTimer) return;
		progressTimer = setTimeout(() => {
			progressTimer = undefined;
			if (!progressPending || finished) return;
			progressPending = false;
			onProgress(result);
		}, PROGRESS_COALESCE_MS);
	};
	const captureToolStart = (event: EventRecord) => {
		const collector = implement?.artifacts;
		if (!collector) return;
		const toolCallId = typeof event.toolCallId === "string" && event.toolCallId.length ? event.toolCallId : undefined;
		const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
		const args = eventRecord(event.args);
		const rawCommand = eventField(args, "command");
		if (toolName === "bash" && rawCommand.present && typeof rawCommand.value !== "string")
			collector.noteAnomaly("invalid-field");
		const call: CapturedToolCall = {
			toolCallId,
			toolName,
			startedAt: Date.now(),
			...(toolName === "bash" && typeof rawCommand.value === "string" ? { rawArgsCommand: rawCommand.value } : {}),
		};
		if (!toolName) collector.noteAnomaly("malformed-event");
		if (!toolCallId) {
			collector.noteAnomaly("missing-tool-call-id");
			anonymousCaptureCalls.push(call);
			return;
		}
		const callsForId = captureCalls.get(toolCallId) ?? [];
		callsForId.push(call);
		captureCalls.set(toolCallId, callsForId);
	};
	const captureToolEnd = (event: EventRecord) => {
		const collector = implement?.artifacts;
		if (!collector) return;
		const id = typeof event.toolCallId === "string" && event.toolCallId.length ? event.toolCallId : undefined;
		let call: CapturedToolCall | undefined;
		if (id) {
			const callsForId = captureCalls.get(id);
			call = callsForId?.shift();
			if (callsForId?.length === 0) captureCalls.delete(id);
			if (!call) collector.noteAnomaly("end-without-start");
		} else {
			collector.noteAnomaly("missing-tool-call-id");
			call = anonymousCaptureCalls.shift();
			if (!call) collector.noteAnomaly("end-without-start");
		}
		if (typeof event.isError !== "boolean") collector.noteAnomaly("malformed-event");
		const endedToolName = typeof event.toolName === "string" ? event.toolName : undefined;
		if (call?.toolName && endedToolName && call.toolName !== endedToolName) collector.noteAnomaly("malformed-event");
		if (event.isError === false && (call?.toolName ?? endedToolName) === "bash") {
			const status = bashStatuses(event.result);
			if (status.exitCode !== 0 && status.diagnostics.length) {
				if (contradictorySuccesses.length < FAILED_TOOL_ARTIFACT_LIMITS.maxDiagnosticsPerCall) {
					const bounded = boundedCallId(call?.toolCallId ?? id ?? "(missing)");
					const idText = bounded.truncated ? `${bounded.text} [truncated]` : bounded.text;
					contradictorySuccesses.push(`isError=false toolCallId=${idText} ${status.diagnostics.join("; ")}`);
				} else omittedContradictorySuccesses++;
			}
		}
		if (event.isError !== true) return;
		const endedAt = Date.now();
		const eventResult = eventRecord(event.result);
		const effectiveCommand =
			eventText(event, "effectiveCommand") ??
			eventText(eventResult, "effectiveCommand") ??
			eventText(eventRecord(eventResult?.structuredContent), "effectiveCommand");
		collector.record({
			attemptIndex,
			requestedModel: run.model,
			toolCallId: call?.toolCallId ?? id,
			toolName: call?.toolName ?? endedToolName,
			startedAt: call?.startedAt,
			endedAt,
			cwd: typeof event.cwd === "string" ? event.cwd : cwd,
			rawArgsCommand: call?.rawArgsCommand,
			effectiveCommand,
			disposition: failureDisposition(call?.toolName ?? endedToolName, event.result),
			isError: true,
			result: failedToolResult(event.result, call?.toolName ?? endedToolName),
		});
	};
	const flushUnclosedCalls = () => {
		const collector = implement?.artifacts;
		if (!collector) return;
		const retain = (call: CapturedToolCall) =>
			collector.recordUnmatchedStart({
				attemptIndex,
				requestedModel: run.model,
				...(call.toolCallId && { toolCallId: call.toolCallId }),
				...(call.toolName && { toolName: call.toolName }),
				startedAt: call.startedAt,
				cwd,
				...(call.rawArgsCommand !== undefined && { rawArgsCommand: call.rawArgsCommand }),
			});
		for (const callsForId of captureCalls.values()) for (const call of callsForId) retain(call);
		for (const call of anonymousCaptureCalls) retain(call);
		captureCalls.clear();
		anonymousCaptureCalls.length = 0;
	};
	const startToolEffect = (event: EventRecord) => {
		result.toolCallCount = (result.toolCallCount ?? 0) + 1;
		const toolCallId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : "";
		const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
		if (!toolCallId || toolName === "unknown") provenance.complete = false;
		if (toolCallId && seenToolCallIds.has(toolCallId)) {
			provenance.complete = false;
			implement?.artifacts.noteAnomaly("duplicate-tool-call-id");
			provenance.stopFacts.push({
				owner: "delegate-parent",
				jobId: job.jobId,
				attempt: attemptIndex,
				toolCallId,
				cause: "tool-failure",
				resource: "tool",
				effect: "unknown",
			});
		}
		if (toolCallId) seenToolCallIds.add(toolCallId);
		const fact: ToolEffectFact = {
			owner: "pi-runtime",
			jobId: job.jobId,
			attempt: attemptIndex,
			toolCallId: toolCallId || "(missing)",
			toolName,
			effect: "unknown",
			replaySafe: false,
		};
		provenance.toolEffects.push(fact);
		if (!toolCallId) return;
		const callsForId = activeEffects.get(toolCallId) ?? [];
		if (callsForId.length) provenance.complete = false;
		callsForId.push(fact);
		activeEffects.set(toolCallId, callsForId);
	};
	const observeToolEffectUpdate = (event: EventRecord) => {
		const toolCallId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : "";
		const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
		const calls = toolCallId ? activeEffects.get(toolCallId) : undefined;
		if (
			!calls ||
			calls.length !== 1 ||
			calls[0].toolName !== toolName ||
			!Object.hasOwn(event, "partialResult") ||
			!eventRecord(event.partialResult)
		) {
			provenance.complete = false;
			return;
		}
		// Pi's update event proves only that a tool reported partial output, not whether its side effects
		// completed or partially occurred. Keep the effect unknown unless its final owner boundary says otherwise.
		calls[0].partialResultObserved = true;
	};
	const endToolEffect = (event: EventRecord) => {
		const toolCallId = typeof event.toolCallId === "string" && event.toolCallId ? event.toolCallId : "";
		const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
		const callsForId = toolCallId ? activeEffects.get(toolCallId) : undefined;
		const fact = callsForId?.shift();
		if (callsForId?.length === 0 && toolCallId) activeEffects.delete(toolCallId);
		if (!toolCallId || !fact) provenance.complete = false;
		if (fact && fact.toolName !== toolName) provenance.complete = false;
		const resultRecord = eventRecord(event.result);
		const details = eventRecord(resultRecord?.details);
		const hasMarker = Boolean(details && Object.hasOwn(details, TOOL_PROVENANCE_DETAIL_KEY));
		const marker = details?.[TOOL_PROVENANCE_DETAIL_KEY];
		const ownerFacts: StopFact[] = [];
		if (hasMarker) {
			if (!Array.isArray(marker)) provenance.complete = false;
			else {
				for (const value of marker) {
					if (
						!isStopFact(value) ||
						value.jobId !== job.jobId ||
						value.attempt !== attemptIndex ||
						value.toolCallId !== toolCallId ||
						(value.owner !== "guard" && value.owner !== "delegate-worker")
					) {
						provenance.complete = false;
						continue;
					}
					ownerFacts.push(value);
					provenance.stopFacts.push(value);
				}
			}
		}
		if (!fact) {
			provenance.toolEffects.push({
				owner: "pi-runtime",
				jobId: job.jobId,
				attempt: attemptIndex,
				toolCallId: toolCallId || "(missing)",
				toolName,
				effect: "unknown",
				replaySafe: false,
			});
		}
		if (event.isError === true) {
			const denied = ownerFacts.length > 0 && ownerFacts.every((stopFact) => stopFact.effect === "denied");
			const exitCode = bashExitCode(event.result);
			const completedBashFailure =
				!stopped &&
				!ownerFacts.length &&
				fact?.toolName === "bash" &&
				fact.toolCallId === toolCallId &&
				toolName === "bash" &&
				Number.isInteger(exitCode) &&
				(exitCode as number) >= 1 &&
				(exitCode as number) <= 127 &&
				!provenance.stopFacts.some((stopFact) => stopFact.toolCallId === toolCallId);
			const noEffect =
				!denied &&
				!completedBashFailure &&
				!stopped &&
				!ownerFacts.length &&
				fact?.toolCallId === toolCallId &&
				fact.toolName === toolName &&
				failedWithoutEffect(toolName, event.result);
			if (fact) {
				fact.effect = denied
					? "denied"
					: completedBashFailure
						? "completed"
						: noEffect
							? READ_ONLY_TOOLS.has(toolName)
								? "completed"
								: "not-started"
							: "unknown";
				fact.replaySafe = noEffect && READ_ONLY_TOOLS.has(toolName);
			}
			if (!denied && !noEffect)
				provenance.stopFacts.push({
					owner: "delegate-parent",
					jobId: job.jobId,
					attempt: attemptIndex,
					...(toolCallId && { toolCallId }),
					cause: "tool-failure",
					resource: "tool",
					effect: completedBashFailure ? "completed" : "unknown",
				});
		} else if (event.isError === false && fact && !ownerFacts.length && fact.toolName === toolName) {
			if (fact.toolName === "bash" && bashExitCode(event.result) !== 0) {
				provenance.complete = false;
				fact.effect = "unknown";
				if (bashExitCode(event.result) !== undefined)
					provenance.stopFacts.push({
						owner: "delegate-parent",
						jobId: job.jobId,
						attempt: attemptIndex,
						toolCallId,
						cause: "tool-failure",
						resource: "tool",
						effect: "unknown",
					});
			} else {
				fact.effect = "completed";
				fact.replaySafe = READ_ONLY_TOOLS.has(fact.toolName);
			}
		} else {
			provenance.complete = false;
			if (fact) fact.effect = "unknown";
		}
	};
	const flushUnknownToolEffects = () => {
		if (activeEffects.size) provenance.complete = false;
		for (const callsForId of activeEffects.values())
			for (const fact of callsForId) {
				fact.effect = "unknown";
				fact.replaySafe = false;
			}
		activeEffects.clear();
	};
	const parentFact = (
		cause: StopFact["cause"],
		resource: StopResource,
		effect: StopFact["effect"] = "unknown",
	): StopFact => ({
		owner: "delegate-parent",
		jobId: job.jobId,
		attempt: attemptIndex,
		cause,
		resource,
		effect,
	});
	const retainParentFact = (cause: StopFact["cause"], resource: StopResource) => {
		if (
			!provenance.stopFacts.some(
				(fact) => fact.owner === "delegate-parent" && fact.cause === cause && fact.resource === resource,
			)
		)
			provenance.stopFacts.push(parentFact(cause, resource));
	};

	const processEvent = (event: any) => {
		if (event.type === "tool_execution_start") startToolEffect(event);
		if (event.type === "tool_execution_update") observeToolEffectUpdate(event);
		if (event.type === "tool_execution_end") endToolEffect(event);
		if (event.type === "tool_execution_start") {
			if (typeof event.toolName === "string") {
				result.tools.push(toolLabel(event.toolName));
				if (result.tools.length > MAX_TOOL_HISTORY) result.tools.shift();
				if (implement)
					calls.set(event.toolCallId, { tool: event.toolName, command: String(event.args?.command ?? "") });
				scheduleProgress();
			}
			if (implement) captureToolStart(event);
		}
		if (implement && event.type === "tool_execution_end") {
			trackCheck(implement.job, calls, event, cwd);
			captureToolEnd(event);
		}
		if (event.type === "auto_retry_start") {
			const failed = latestAssistantError;
			latestAssistantError = undefined;
			const slash = run.model?.indexOf("/") ?? -1;
			const retry = event.attempt;
			if (
				!failed ||
				slash <= 0 ||
				failed.provider !== run.model?.slice(0, slash) ||
				failed.model !== run.model?.slice(slash + 1) ||
				!Number.isSafeInteger(retry) ||
				retry < 1
			) {
				provenance.complete = false;
				return;
			}
			const providerRetry: ProviderRetryFact = {
				owner: "pi-runtime",
				jobId: job.jobId,
				attempt: attemptIndex,
				provider: failed.provider,
				model: failed.model,
				api: failed.api,
				sourceEvent: "auto_retry_start",
				retry,
			};
			if (!isProviderRetryFact(providerRetry)) {
				provenance.complete = false;
				return;
			}
			provenance.providerRetry = providerRetry;
			provenance.stopFacts.push({
				owner: "pi-runtime",
				jobId: job.jobId,
				attempt: attemptIndex,
				cause: "provider-retry-classified",
				resource: "provider",
				effect: "unknown",
			});
			// A budget already spent when Pi classifies a retry is retained as a stop fact, so the attempt is not replayed.
			const now = Date.now();
			if (now >= budget.hardDeadline) retainParentFact("hard-timeout", "hard-time");
			if (now >= budget.toolDeadline) retainParentFact("wrap-up-limit", "tool-time");
			const spentCost = costOf(result.usage);
			if (spentCost >= budget.hardCostCapUsd) retainParentFact("hard-cost-limit", "hard-cost");
			if (spentCost >= budget.toolCostCapUsd) retainParentFact("wrap-up-limit", "tool-cost");
			if (job.role === "scout" && budget.toolCalls !== null && (result.toolCallCount ?? 0) >= budget.toolCalls)
				retainParentFact("wrap-up-limit", "tool-calls");
			return;
		}
		if (event.type !== "message_end" || event.message?.role !== "assistant") return;
		const msg = event.message;
		result.turns++;
		addUsage(result.usage, msg.usage);
		if (typeof msg.model === "string") result.model = msg.model;
		const text = (Array.isArray(msg.content) ? msg.content : []).filter((p: any) => p?.type === "text");
		if (text.length) result.output = text.map((p: any) => p.text).join("\n");
		// Only the latest reply decides: Pi may retry after a transient error and then answer.
		lastStopReason = msg.stopReason;
		latestAssistantError =
			msg.stopReason === "error" &&
			typeof msg.provider === "string" &&
			typeof msg.model === "string" &&
			typeof msg.api === "string"
				? { provider: msg.provider, model: msg.model, api: msg.api }
				: undefined;
		providerErrorClass = msg.stopReason === "error" ? classifyProviderError(msg.errorMessage) : undefined;
		const bad = ["error", "aborted", "length"].includes(msg.stopReason);
		result.failure = bad ? msg.errorMessage || `model stopped: ${msg.stopReason}` : undefined;
		// Keep a final "stop" reply even over cap. For continuing replies, retain every spent dimension before
		// enforcing hard cost: stopping the child may prevent its later auto_retry_start event.
		if (msg.stopReason !== "stop") {
			const currentCost = costOf(result.usage);
			if (currentCost >= budget.toolCostCapUsd) retainParentFact("wrap-up-limit", "tool-cost");
			if (currentCost >= budget.hardCostCapUsd) {
				retainParentFact("hard-cost-limit", "hard-cost");
				stop(`cost cap $${budget.hardCostCapUsd} reached`);
			}
		}
		cancelPendingProgress();
		onProgress(result);
	};

	const stop = (reason: string, fact?: StopFact) => {
		if (finished || stopped || !kill) return;
		stopped = reason;
		if (fact) provenance.stopFacts.push(fact);
		kill();
	};
	const close = () => {
		if (finished) return;
		flushUnclosedCalls();
		flushUnknownToolEffects();
		flushProgress();
		finished = true;
		clearProgressTimer();
	};
	const settle = (code: number | null, problem?: string): RunResult => {
		// Derive the child's own tail before appending delegate diagnostics; appended text must not become the
		// reported child failure when the worker crashes without a final answer.
		const lastStderr = result.stderr.trim().split("\n").at(-1)?.slice(0, 300);
		if (contradictorySuccesses.length) {
			result.stderr += `\ndelegate: contradictory Bash success status diagnostics:\n${contradictorySuccesses.join("\n")}`;
			if (omittedContradictorySuccesses)
				result.stderr += `\ndelegate: ${omittedContradictorySuccesses} further status diagnostics omitted`;
		}
		// A final answer ("stop") counts even if a stop or stray pipe holder came after it.
		const answered = lastStopReason === "stop" && !result.failure && Boolean(result.output.trim());
		if (problem) provenance.complete = false;
		if (answered) {
			// Kept for the details only: what happened after the answer was complete.
			const after = [problem, stopped && `stopped: ${stopped}`, code !== 0 && `exit ${code}`].filter(Boolean);
			if (after.length) result.stderr += `\ndelegate: after the final answer: ${after.join("; ")}`;
		} else if (problem) result.failure = problem;
		else if (stopped)
			result.failure = result.failure ? `${result.failure}; stopped: ${stopped}` : `stopped: ${stopped}`;
		else if (code !== 0) result.failure = `exit ${code}: ${result.failure ?? (lastStderr || "no error message")}`;
		else if (!result.failure)
			result.failure = result.output.trim() ? "worker ended without a final answer" : "worker produced no answer";
		// Our own stops (limits, cancellation) are never infra, whatever the provider said before them.
		if (result.failure) result.failureClass = (!stopped && !problem && providerErrorClass) || "model/task";
		return result;
	};
	return {
		result,
		provenance,
		attach: (killWorker) => {
			kill = killWorker;
		},
		record: (event) => processEvent(event),
		malformed: () => {
			provenance.complete = false;
			implement?.artifacts.noteAnomaly("malformed-event"); // pi prints JSON lines in this mode.
		},
		stderr: (chunk) => {
			result.stderr = (result.stderr + chunk).slice(-4096);
		},
		killFailure: (failure) => {
			result.stderr += `\ndelegate: ${failure}`;
		},
		parentFact,
		stop,
		close,
		settle,
	};
}

/**
 * An infra failure is retried on the same model only when its attempt is fully accounted for and did nothing but
 * replay-safe reads; the only stop allowed is Pi's own exhausted retry. Any write, Bash call, or other stop keeps it.
 */
export function infraRetryable(r: RunResult): boolean {
	const last = r.provenance?.at(-1);
	return (
		r.failureClass === "infra" &&
		last !== undefined &&
		last.complete &&
		last.stopFacts.every((fact) => fact.cause === "provider-retry-classified") &&
		last.toolEffects.every((fact) => fact.effect === "completed" && fact.replaySafe)
	);
}

/** The latest attempt's result, with every attempt's provenance, usage, time, and tool history. */
export function mergeAttempts(previous: RunResult, next: RunResult): RunResult {
	const usage = {};
	addUsage(usage, previous.usage);
	addUsage(usage, next.usage);
	return {
		...next,
		infraRetries: [...(previous.infraRetries ?? []), previous.failure ?? "infra failure"],
		provenance: [...(previous.provenance ?? []), ...(next.provenance ?? [])],
		toolCallCount: (previous.toolCallCount ?? 0) + (next.toolCallCount ?? 0),
		turns: previous.turns + next.turns,
		usage,
		tools: [...previous.tools, ...next.tools].slice(-MAX_TOOL_HISTORY),
		ms: previous.ms + next.ms,
	};
}
