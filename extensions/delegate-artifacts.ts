import {
	chmodSync,
	closeSync,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

export const FAILED_TOOL_ARTIFACT_LIMITS = {
	maxFailedCalls: 100,
	maxTextBytes: 64 * 1024,
	maxArtifactBytes: 512 * 1024,
	maxReferencesPerCall: 20,
	maxDiagnosticsPerCall: 20,
	maxReferenceBytes: 2 * 1024,
} as const;

export const FAILED_TOOL_ARTIFACT_REDACTION = "explicit-patterns-v1; not guaranteed complete";

const MAX_JOB_ID_BYTES = 64;
const MAX_CALL_ID_BYTES = 256;
const MAX_TOOL_NAME_BYTES = 128;
const MAX_MODEL_BYTES = 256;
const TEXT_CAP = FAILED_TOOL_ARTIFACT_LIMITS.maxTextBytes;

export type ArtifactAnomalyKind =
	| "missing-tool-call-id"
	| "duplicate-tool-call-id"
	| "end-without-start"
	| "start-without-end"
	| "malformed-event"
	| "invalid-field"
	| "record-cap"
	| "aggregate-cap";

const ANOMALY_KINDS: ArtifactAnomalyKind[] = [
	"missing-tool-call-id",
	"duplicate-tool-call-id",
	"end-without-start",
	"start-without-end",
	"malformed-event",
	"invalid-field",
	"record-cap",
	"aggregate-cap",
];

type CaptureAnomalies = Record<ArtifactAnomalyKind, number>;

export type ArtifactText = {
	text: string;
	bytesOriginal: number | null;
	bytesRetained: number;
	truncated: boolean;
};

type TextField = { state: "provided" | "not-provided"; value: ArtifactText | null };
type TextList = { state: "provided" | "not-provided"; items: ArtifactText[]; omitted: number };
type ArtifactReference = { kind: "full-output-path" | "child-diagnostic"; value: ArtifactText };

export type FailedToolCallInput = {
	attemptIndex?: number;
	requestedModel?: string;
	toolCallId?: string;
	toolName?: string;
	startedAt?: string | number | Date;
	endedAt?: string | number | Date;
	cwd?: string;
	rawArgsCommand?: string;
	effectiveCommand?: string;
	isError: true;
	result?: {
		exitCode?: number;
		outputText?: string;
		error?: string;
		childDiagnostics?: string | readonly string[];
		fullOutputPath?: string;
		childDiagnosticReferences?: readonly string[];
		summary?: unknown;
	};
};

export type FailedToolArtifactEntry = {
	attempt: { index: number | null; requestedModel: ArtifactText | null };
	toolCallId: ArtifactText | null;
	toolName: ArtifactText | null;
	startedAt: string | null;
	endedAt: string | null;
	elapsedMs: number | null;
	cwd: TextField;
	command: null | { rawArgsCommand: TextField; effectiveCommand: TextField };
	isError: true;
	exitCode: { state: "provided" | "not-provided"; value: number | null };
	output: TextField;
	error: TextField;
	childDiagnostics: TextList;
	references: {
		fullOutputPathState: "provided" | "not-provided";
		childDiagnosticReferencesState: "provided" | "not-provided";
		items: ArtifactReference[];
		omitted: number;
	};
	resultSummary: TextField;
	missingFields: string[];
	truncated: boolean;
};

export type FailedToolArtifact = {
	version: 1;
	jobId: string;
	redaction: typeof FAILED_TOOL_ARTIFACT_REDACTION;
	entries: FailedToolArtifactEntry[];
	capture: {
		failureCount: number;
		recordedCount: number;
		omittedCount: number;
		truncated: boolean;
		anomalies: CaptureAnomalies;
	};
};

export type ArtifactWriteResult =
	| { status: "empty" }
	| { status: "written"; path: string; bytes: number; failureCount: number; truncated: boolean }
	| { status: "unavailable"; warning: string };

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;
const AUTH_HEADER = /((?:authorization|proxy-authorization)\s*:\s*)(?:Bearer|Basic|Token)\s+[^\s,;]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const CREDENTIAL_URL = /\b((?:https?|ssh):\/\/)[^/\s:@]+:[^@\s/]+@/gi;
const CREDENTIAL_ASSIGNMENT =
	/\b((?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|passwd|secret|token|credential|private[_-]?key)\b["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)/gi;
const TOKEN =
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const SECRET_HOME_PATH =
	/(?:~|\/(?:Users|home)\/[^/\\\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+)[/\\](?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker(?:[/\\]config\.json)?|\.config[/\\](?:gh|gcloud)|\.pi[/\\]agent[/\\]auth\.json)(?:[/\\][^\s"'`|;&)]*)?/gi;
const SECRET_FILE_PATH =
	/(?<![\w.-])(?:\.env(?:rc|\.[A-Za-z0-9_-]+)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)[A-Za-z0-9._-]*)(?=$|[/\\\s"'`|;&)])/gi;

/** Best-effort explicit-pattern redaction. This does not inspect environment or credential stores. */
export function redactSensitiveText(text: string): string {
	return text
		.replace(PRIVATE_KEY, "[REDACTED_PRIVATE_KEY]")
		.replace(AUTH_HEADER, "$1[REDACTED]")
		.replace(BEARER, "Bearer [REDACTED]")
		.replace(CREDENTIAL_URL, "$1[REDACTED]@")
		.replace(CREDENTIAL_ASSIGNMENT, (match) => {
			const delimiter = match.search(/[:=]/) + 1;
			const whitespace = match.slice(delimiter).match(/^\s*/)?.[0] ?? "";
			const prefix = match.slice(0, delimiter) + whitespace;
			const value = match.slice(prefix.length);
			return `${prefix}${value.startsWith("'") || value.startsWith('"') ? '"[REDACTED]"' : "[REDACTED]"}`;
		})
		.replace(TOKEN, "[REDACTED]")
		.replace(SECRET_HOME_PATH, "[REDACTED_PATH]")
		.replace(SECRET_FILE_PATH, "[REDACTED_PATH]");
}

function utf8Prefix(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= maxBytes) return text;
	let end = Math.max(0, maxBytes);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function boundedText(text: string, maxBytes = TEXT_CAP): ArtifactText {
	const bytesOriginal = Buffer.byteLength(text, "utf8");
	const redacted = redactSensitiveText(text);
	const retained = utf8Prefix(redacted, maxBytes);
	return {
		text: retained,
		bytesOriginal,
		bytesRetained: Buffer.byteLength(retained, "utf8"),
		truncated: retained !== redacted,
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	try {
		return Array.isArray(value) ? undefined : (value as Record<string, unknown>);
	} catch {
		return undefined;
	}
}

function field(record: Record<string, unknown> | undefined, key: string): { present: boolean; value?: unknown } {
	if (!record) return { present: false };
	try {
		if (!Object.hasOwn(record, key)) return { present: false };
		return { present: true, value: record[key] };
	} catch {
		return { present: false };
	}
}

function fieldText(
	record: Record<string, unknown> | undefined,
	key: string,
	maxBytes: number,
	missing: Set<string>,
	missingName: string,
	onInvalid: () => void,
): TextField {
	const current = field(record, key);
	if (!current.present || typeof current.value !== "string") {
		missing.add(missingName);
		if (current.present) onInvalid();
		return { state: "not-provided", value: null };
	}
	return { state: "provided", value: boundedText(current.value, maxBytes) };
}

function timestamp(value: unknown): { value: string | null; ms: number | null } {
	try {
		if (
			typeof value === "string" &&
			!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)
		)
			return { value: null, ms: null };
		const observed =
			value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value as string);
		if (!Number.isFinite(observed)) return { value: null, ms: null };
		const ms = Math.trunc(observed);
		return { value: new Date(ms).toISOString(), ms };
	} catch {
		return { value: null, ms: null };
	}
}

function safeIndex(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeExitCode(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function summaryText(value: unknown): { text: string; truncated: boolean } | undefined {
	if (typeof value === "string") return { text: value, truncated: false };
	const nodes = { count: 0, bytes: 0, truncated: false };
	const sanitize = (item: unknown, depth: number): unknown => {
		if (nodes.count++ >= 200 || depth > 4) {
			nodes.truncated = true;
			return "[summary truncated]";
		}
		if (typeof item === "string") {
			const remaining = Math.max(0, TEXT_CAP - nodes.bytes);
			const safe = boundedText(item, remaining);
			nodes.bytes += safe.bytesRetained;
			nodes.truncated ||= safe.truncated;
			return safe.text;
		}
		if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)))
			return item;
		if (Array.isArray(item)) {
			const result: unknown[] = [];
			for (const child of item.slice(0, 40)) result.push(sanitize(child, depth + 1));
			if (item.length > 40) nodes.truncated = true;
			return result;
		}
		const object = asRecord(item);
		if (!object) {
			nodes.truncated = true;
			return "[unsupported summary value]";
		}
		const result: Record<string, unknown> = {};
		let keys: string[];
		try {
			keys = Object.keys(object).slice(0, 40);
		} catch {
			nodes.truncated = true;
			return "[unreadable summary]";
		}
		for (const key of keys) {
			const safeKey = boundedText(key, 256).text;
			const current = field(object, key);
			if (current.present) result[safeKey] = sanitize(current.value, depth + 1);
			else nodes.truncated = true;
		}
		if (Object.keys(object).length > 40) nodes.truncated = true;
		return result;
	};
	try {
		const serialized = JSON.stringify(sanitize(value, 0));
		if (serialized === undefined) return undefined;
		const safe = boundedText(serialized);
		return { text: safe.text, truncated: nodes.truncated || safe.truncated };
	} catch {
		return { text: "[unserializable result summary]", truncated: true };
	}
}

function textValues(entry: FailedToolArtifactEntry): { value: ArtifactText; group: string }[] {
	const values: { value: ArtifactText; group: string }[] = [];
	if (entry.cwd.value) values.push({ value: entry.cwd.value, group: "command" });
	const addField = (item: TextField, group: string) => {
		if (item.value) values.push({ value: item.value, group });
	};
	if (entry.command) {
		addField(entry.command.rawArgsCommand, "command");
		addField(entry.command.effectiveCommand, "command");
	}
	addField(entry.error, "error");
	addField(entry.output, "output");
	for (const item of entry.childDiagnostics.items) values.push({ value: item, group: "diagnostics" });
	for (const item of entry.references.items) values.push({ value: item.value, group: "references" });
	addField(entry.resultSummary, "summary");
	return values;
}

function encodedStringBytes(text: string): number {
	return Buffer.byteLength(JSON.stringify(text), "utf8") - 2;
}

function prefixForEncodedBudget(text: string, budget: number): string {
	let low = 0;
	let high = Buffer.byteLength(text, "utf8");
	let best = "";
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const prefix = utf8Prefix(text, mid);
		if (encodedStringBytes(prefix) <= budget) {
			best = prefix;
			low = mid + 1;
		} else high = mid - 1;
	}
	return best;
}

function refreshEntryTruncation(entry: FailedToolArtifactEntry): void {
	entry.truncated ||= textValues(entry).some(({ value }) => value.truncated);
	entry.truncated ||= entry.childDiagnostics.omitted > 0 || entry.references.omitted > 0;
}

function fitArtifact(artifact: FailedToolArtifact): FailedToolArtifact {
	const encoded = () => JSON.stringify(artifact);
	if (Buffer.byteLength(encoded(), "utf8") <= FAILED_TOOL_ARTIFACT_LIMITS.maxArtifactBytes) return artifact;

	const candidates = artifact.entries.flatMap((entry) => {
		const all = textValues(entry);
		return all.map(({ value, group }) => ({
			entry,
			value,
			group,
			originalText: value.text,
			originalRetained: value.bytesRetained,
			initiallyTruncated: value.truncated,
		}));
	});
	for (const candidate of candidates) {
		candidate.value.text = "";
		candidate.value.bytesRetained = candidate.originalRetained;
		if (candidate.originalText) {
			candidate.value.truncated = true;
			candidate.entry.truncated = true;
		}
	}
	artifact.capture.truncated = true;
	artifact.capture.anomalies["aggregate-cap"]++;

	// Payload-free metadata is bounded by the entry, ID, and reference-count limits. If needed, shed
	// optional child records before failed-call provenance, then record every omitted item.
	const size = () => Buffer.byteLength(encoded(), "utf8");
	for (let i = artifact.entries.length - 1; size() > FAILED_TOOL_ARTIFACT_LIMITS.maxArtifactBytes && i >= 0; i--) {
		const entry = artifact.entries[i];
		while (entry.childDiagnostics.items.length && size() > FAILED_TOOL_ARTIFACT_LIMITS.maxArtifactBytes) {
			entry.childDiagnostics.items.pop();
			entry.childDiagnostics.omitted++;
			artifact.capture.truncated = true;
		}
		while (entry.references.items.length && size() > FAILED_TOOL_ARTIFACT_LIMITS.maxArtifactBytes) {
			entry.references.items.pop();
			entry.references.omitted++;
			artifact.capture.truncated = true;
		}
		refreshEntryTruncation(entry);
	}
	while (artifact.entries.length && size() > FAILED_TOOL_ARTIFACT_LIMITS.maxArtifactBytes) {
		artifact.entries.pop();
		artifact.capture.omittedCount++;
		artifact.capture.truncated = true;
		artifact.capture.recordedCount = artifact.entries.length;
	}

	let available = FAILED_TOOL_ARTIFACT_LIMITS.maxArtifactBytes - size();
	const retainedValues = new Set(artifact.entries.flatMap((entry) => textValues(entry).map(({ value }) => value)));
	const priorities = ["command", "error", "references", "output", "diagnostics", "summary"];
	for (const group of priorities) {
		let pending = candidates.filter(
			(candidate) =>
				retainedValues.has(candidate.value) && candidate.group === group && candidate.originalText.length > 0,
		);
		while (pending.length && available > 0) {
			const quota = Math.floor(available / pending.length);
			if (quota <= 0) break;
			const remaining: typeof pending = [];
			let consumed = 0;
			for (const candidate of pending) {
				const fullCost = encodedStringBytes(candidate.originalText);
				const prefix =
					fullCost <= quota ? candidate.originalText : prefixForEncodedBudget(candidate.originalText, quota);
				const cost = encodedStringBytes(prefix);
				candidate.value.text = prefix;
				candidate.value.bytesRetained = Buffer.byteLength(prefix, "utf8");
				candidate.value.truncated = candidate.initiallyTruncated || prefix !== candidate.originalText;
				consumed += cost;
				if (prefix !== candidate.originalText) remaining.push(candidate);
			}
			if (consumed === 0) break;
			available -= consumed;
			pending = remaining;
		}
	}
	for (const entry of artifact.entries) refreshEntryTruncation(entry);
	if (size() > FAILED_TOOL_ARTIFACT_LIMITS.maxArtifactBytes) {
		// This can only be reached if bounded metadata changes in a future schema; fail closed rather than write a large file.
		throw new Error("artifact metadata exceeds the aggregate byte limit");
	}
	return artifact;
}

function makeEntry(
	input: Record<string, unknown>,
	onAnomaly: (kind: ArtifactAnomalyKind) => void,
): FailedToolArtifactEntry {
	const missing = new Set<string>();
	const invalid = () => onAnomaly("invalid-field");
	const attemptIndexField = field(input, "attemptIndex");
	const attemptIndex = safeIndex(attemptIndexField.value);
	if (!attemptIndexField.present || attemptIndex === null) {
		missing.add("attempt.index");
		if (attemptIndexField.present) invalid();
	}
	const model = field(input, "requestedModel");
	let requestedModel: ArtifactText | null = null;
	if (typeof model.value === "string") requestedModel = boundedText(model.value, MAX_MODEL_BYTES);
	else {
		missing.add("attempt.requestedModel");
		if (model.present) invalid();
	}
	const callId = field(input, "toolCallId");
	const toolCallId =
		typeof callId.value === "string" && callId.value.length > 0 ? boundedText(callId.value, MAX_CALL_ID_BYTES) : null;
	if (!toolCallId) {
		missing.add("toolCallId");
		onAnomaly("missing-tool-call-id");
		if (callId.present) invalid();
	}
	const tool = field(input, "toolName");
	const toolName =
		typeof tool.value === "string" && tool.value.length > 0 ? boundedText(tool.value, MAX_TOOL_NAME_BYTES) : null;
	if (!toolName) {
		missing.add("toolName");
		if (tool.present) invalid();
	}

	const started = field(input, "startedAt");
	const startedAt = started.present ? timestamp(started.value) : { value: null, ms: null };
	if (!started.present || startedAt.value === null) {
		missing.add("startedAt");
		if (started.present) invalid();
	}
	const ended = field(input, "endedAt");
	const endedAt = ended.present ? timestamp(ended.value) : { value: null, ms: null };
	if (!ended.present || endedAt.value === null) {
		missing.add("endedAt");
		if (ended.present) invalid();
	}
	const elapsedMs =
		startedAt.ms !== null && endedAt.ms !== null && endedAt.ms >= startedAt.ms ? endedAt.ms - startedAt.ms : null;
	if (elapsedMs === null) missing.add("elapsedMs");

	const cwd = fieldText(input, "cwd", 4096, missing, "cwd", invalid);
	let command: FailedToolArtifactEntry["command"] = null;
	if (tool.value === "bash") {
		command = {
			rawArgsCommand: fieldText(input, "rawArgsCommand", TEXT_CAP, missing, "command.rawArgs.command", invalid),
			effectiveCommand: fieldText(input, "effectiveCommand", TEXT_CAP, missing, "command.effectiveCommand", invalid),
		};
	}

	const resultField = field(input, "result");
	const result = asRecord(resultField.value);
	if (!resultField.present || !result) {
		if (resultField.present) invalid();
		missing.add("result");
	}
	const exitField = field(result, "exitCode");
	const exitCode = safeExitCode(exitField.value);
	if (!exitField.present || exitCode === null) {
		missing.add("result.exitCode");
		if (exitField.present) invalid();
	}
	const output = fieldText(result, "outputText", TEXT_CAP, missing, "result.outputText", invalid);
	const error = fieldText(result, "error", TEXT_CAP, missing, "result.error", invalid);

	const diagnosticsField = field(result, "childDiagnostics");
	const diagnosticItems: ArtifactText[] = [];
	let diagnosticOmitted = 0;
	if (typeof diagnosticsField.value === "string") diagnosticItems.push(boundedText(diagnosticsField.value));
	else if (Array.isArray(diagnosticsField.value)) {
		const list = diagnosticsField.value as unknown[];
		for (let i = 0; i < Math.min(list.length, FAILED_TOOL_ARTIFACT_LIMITS.maxDiagnosticsPerCall); i++) {
			const item = list[i];
			if (typeof item === "string") diagnosticItems.push(boundedText(item));
			else {
				diagnosticOmitted++;
				invalid();
			}
		}
		diagnosticOmitted += Math.max(0, list.length - FAILED_TOOL_ARTIFACT_LIMITS.maxDiagnosticsPerCall);
	} else {
		missing.add("result.childDiagnostics");
		if (diagnosticsField.present) invalid();
	}
	if (diagnosticOmitted) onAnomaly("aggregate-cap");

	const fullPath = fieldText(
		result,
		"fullOutputPath",
		FAILED_TOOL_ARTIFACT_LIMITS.maxReferenceBytes,
		missing,
		"result.fullOutputPath",
		invalid,
	);
	const childReferencesField = field(result, "childDiagnosticReferences");
	const childReferences: ArtifactText[] = [];
	let referencesOmitted = 0;
	if (Array.isArray(childReferencesField.value)) {
		const list = childReferencesField.value as unknown[];
		for (let i = 0; i < Math.min(list.length, FAILED_TOOL_ARTIFACT_LIMITS.maxReferencesPerCall); i++) {
			const item = list[i];
			if (typeof item === "string")
				childReferences.push(boundedText(item, FAILED_TOOL_ARTIFACT_LIMITS.maxReferenceBytes));
			else {
				referencesOmitted++;
				invalid();
			}
		}
		referencesOmitted += Math.max(0, list.length - FAILED_TOOL_ARTIFACT_LIMITS.maxReferencesPerCall);
	} else {
		missing.add("result.childDiagnosticReferences");
		if (childReferencesField.present) invalid();
	}
	if (referencesOmitted) onAnomaly("aggregate-cap");

	const references: ArtifactReference[] = [];
	if (fullPath.value) references.push({ kind: "full-output-path", value: fullPath.value });
	for (const value of childReferences) {
		if (references.length >= FAILED_TOOL_ARTIFACT_LIMITS.maxReferencesPerCall) {
			referencesOmitted++;
			continue;
		}
		references.push({ kind: "child-diagnostic", value });
	}
	const resultSummaryField = field(result, "summary");
	let resultSummary: TextField = { state: "not-provided", value: null };
	if (tool.value !== "bash") {
		const summary = resultSummaryField.present ? summaryText(resultSummaryField.value) : undefined;
		if (summary === undefined) {
			missing.add("result.summary");
			if (resultSummaryField.present) invalid();
		} else {
			const value = boundedText(summary.text);
			value.truncated ||= summary.truncated;
			resultSummary = { state: "provided", value };
		}
	}

	const entry: FailedToolArtifactEntry = {
		attempt: { index: attemptIndex, requestedModel },
		toolCallId,
		toolName,
		startedAt: startedAt.value,
		endedAt: endedAt.value,
		elapsedMs,
		cwd,
		command,
		isError: true,
		exitCode: { state: exitCode === null ? "not-provided" : "provided", value: exitCode },
		output,
		error,
		childDiagnostics: {
			state:
				diagnosticsField.present &&
				(typeof diagnosticsField.value === "string" || Array.isArray(diagnosticsField.value))
					? "provided"
					: "not-provided",
			items: diagnosticItems,
			omitted: diagnosticOmitted,
		},
		references: {
			fullOutputPathState: fullPath.state,
			childDiagnosticReferencesState:
				childReferencesField.present && Array.isArray(childReferencesField.value) ? "provided" : "not-provided",
			items: references,
			omitted: referencesOmitted,
		},
		resultSummary,
		missingFields: [...missing],
		truncated: false,
	};
	entry.truncated =
		textValues(entry).some(({ value }) => value.truncated) || diagnosticOmitted > 0 || referencesOmitted > 0;
	return entry;
}

/** Job-scoped collector. Its input is normalized event-derived data; it never reads tool input beyond a Bash command. */
export class FailedToolArtifactCollector {
	readonly jobId: string;
	private readonly entries: FailedToolArtifactEntry[] = [];
	private failureCount = 0;
	private omittedCount = 0;
	private truncated = false;
	private readonly anomalies: CaptureAnomalies = Object.fromEntries(
		ANOMALY_KINDS.map((kind) => [kind, 0]),
	) as CaptureAnomalies;

	constructor(jobId: string) {
		this.jobId = redactSensitiveText(jobId).slice(0, MAX_JOB_ID_BYTES);
	}

	/** Add a call only when its actual end event says isError: true; returns false for successes or capped records. */
	record(input: FailedToolCallInput): boolean {
		const record = asRecord(input);
		if (!record || field(record, "isError").value !== true) return false;
		this.failureCount++;
		if (this.entries.length >= FAILED_TOOL_ARTIFACT_LIMITS.maxFailedCalls) {
			this.omittedCount++;
			this.truncated = true;
			this.noteAnomaly("record-cap");
			return false;
		}
		const entry = makeEntry(record, (kind) => this.noteAnomaly(kind));
		this.entries.push(entry);
		if (entry.truncated) this.truncated = true;
		return true;
	}

	/** Record correlation or lifecycle anomalies without retaining the source event or its payload. */
	noteAnomaly(kind: ArtifactAnomalyKind): void {
		this.anomalies[kind]++;
	}

	/** A detached, redacted, size-bounded schema snapshot; undefined means no failed calls were observed. */
	snapshot(): FailedToolArtifact | undefined {
		if (!this.failureCount) return undefined;
		const artifact: FailedToolArtifact = {
			version: 1,
			jobId: this.jobId,
			redaction: FAILED_TOOL_ARTIFACT_REDACTION,
			entries: structuredClone(this.entries),
			capture: {
				failureCount: this.failureCount,
				recordedCount: this.entries.length,
				omittedCount: this.omittedCount,
				truncated: this.truncated,
				anomalies: { ...this.anomalies },
			},
		};
		return fitArtifact(artifact);
	}

	/** Persist exclusively under an owner-private directory; capture errors are returned as warning state, never thrown. */
	write(directory: string): ArtifactWriteResult {
		let artifact: FailedToolArtifact | undefined;
		try {
			artifact = this.snapshot();
		} catch (error) {
			const candidate = error as { code?: unknown; message?: unknown };
			const message = typeof candidate?.code === "string" ? candidate.code : String(candidate?.message ?? error);
			return { status: "unavailable", warning: `capture unavailable: ${redactSensitiveText(message)}` };
		}
		if (!artifact) return { status: "empty" };
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(this.jobId) || Buffer.byteLength(this.jobId, "utf8") > MAX_JOB_ID_BYTES)
			return { status: "unavailable", warning: "capture unavailable: invalid job id" };
		if (!isAbsolute(directory))
			return { status: "unavailable", warning: "capture unavailable: artifact directory must be absolute" };

		let path: string | undefined;
		let fd: number | undefined;
		let created = false;
		try {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			const dirStat = lstatSync(directory);
			const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
			if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (uid !== undefined && dirStat.uid !== uid))
				throw new Error("artifact directory is not a private directory");
			chmodSync(directory, 0o700);
			if ((lstatSync(directory).mode & 0o777) !== 0o700)
				throw new Error("artifact directory permissions are not 0700");

			path = join(directory, `${this.jobId}-failed-tools.json`);
			const contents = JSON.stringify(artifact);
			const bytes = Buffer.byteLength(contents, "utf8");
			if (bytes > FAILED_TOOL_ARTIFACT_LIMITS.maxArtifactBytes)
				throw new Error("artifact exceeds the 512 KiB limit");
			fd = openSync(path, "wx", 0o600);
			created = true;
			fchmodSync(fd, 0o600);
			const fileStat = fstatSync(fd);
			if ((fileStat.mode & 0o777) !== 0o600 || (uid !== undefined && fileStat.uid !== uid))
				throw new Error("artifact file permissions are not private");
			writeFileSync(fd, contents, { encoding: "utf8" });
			closeSync(fd);
			fd = undefined;
			return {
				status: "written",
				path,
				bytes,
				failureCount: artifact.capture.failureCount,
				truncated: artifact.capture.truncated,
			};
		} catch (error) {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {}
			}
			if (created && path) {
				try {
					unlinkSync(path);
				} catch {}
			}
			const candidate = error as { code?: unknown; message?: unknown };
			const message = typeof candidate?.code === "string" ? candidate.code : String(candidate?.message ?? error);
			return { status: "unavailable", warning: `capture unavailable: ${redactSensitiveText(message)}` };
		}
	}
}
