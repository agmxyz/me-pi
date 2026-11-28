/**
 * delegate — runs read-only child Pi workers for token-heavy work (code search, web research, and reviews).
 *
 * Workers run as `pi --mode json -p` child processes with role-scoped tools, model pools,
 * and internal guardrails (secret-path read blocks, write directory fencing, and wrap-up budgets).
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AttemptBudget,
	addUsage,
	classifyProviderError,
	createAttemptLedger,
	infraRetryable,
	MAX_TOOL_HISTORY,
	mergeAttempts,
	type RunResult,
} from "./delegate-attempt.ts";
import { type ActiveCall, type ActiveWorker, type CallRecord, registerDelegateCommand } from "./delegate-command.ts";
import {
	configPath,
	configuredModels,
	loadModelSet,
	type ModelSet,
	type ResolvedRun,
	type RunSpec,
	resolveRuns,
	THINKING_LEVELS,
	validateOneOffModel,
} from "./delegate-config.ts";
import { isWorkerProcess } from "./delegate-env.ts";
import { startWorkerProcess } from "./delegate-process.ts";
import { failureClassLine } from "./delegate-provenance.ts";
import {
	type ActivityWidgetRow,
	activityWidget,
	type DelegateView,
	type Persona,
	pickPersona,
	progressLines,
	type RunView,
	renderCall,
	renderHandback,
	renderResult,
} from "./delegate-render.ts";
import {
	blockedLines,
	costOf,
	formatCutBlocked,
	handbackBlocked,
	type Job,
	RECOVERY_POINTER,
	ROLE_NAMES,
	ROLES,
	registerWorker,
	workerLaunch,
} from "./delegate-worker.ts";

/** Per-worker limits; exported so tests can shorten them. The cost cap is checked after each reply. */
export const LIMITS = {
	scoutTimeoutSecs: 300,
	timeoutSecs: 900,
	costCapUsd: 5,
	exitGraceMs: 1000,
	// Wrap-up budget, enforced inside the worker: past it, tool calls are blocked so the model answers
	// before a hard limit kills it without one.
	scoutToolCalls: 60,
	wrapUpShare: 0.8,
	// Same-model retries of an infra failure that had no effects, one per delay; they share the job's limits.
	infraRetryDelaysMs: [15_000, 60_000],
};
const MAX_RUNS = 4;
const HISTORY_SIZE = 20;
// One answer's share of a rebuttal prompt.
const ANSWER_CAP = 12 * 1024;
// What a read-only answer may put in the main context; the head carries findings, the tail the caveats.
const HANDBACK_CEILING = 4 * 1024;
const HANDBACK_TAIL = 600;
// A call's `answer` replaces the role's answer format; the cap keeps it a format, not a second task.
const MAX_FORMAT = 400;

const MAX_LISTED = 50;

/**
 * The files a worker wrote into its output directory, as `name (bytes B)`, at most MAX_LISTED. Names
 * come from the worker: one with control characters is quoted so it cannot add lines to the result.
 */
function listOutput(dir: string): string[] {
	const files = (readdirSync(dir, { recursive: true }) as string[])
		.filter((name) => statSync(join(dir, name)).isFile())
		.sort();
	const shown = (name: string) => (/[\x00-\x1f\x7f]/.test(name) ? JSON.stringify(name) : name);
	const listed = files.slice(0, MAX_LISTED).map((name) => `${shown(name)} (${statSync(join(dir, name)).size} B)`);
	return files.length > MAX_LISTED ? [...listed, `\u2026 ${files.length - MAX_LISTED} more`] : listed;
}

function initialActivity(
	runs: ResolvedRun[],
	personas: Persona[],
	sessionModel: string | undefined,
	startedAt: number,
): ActiveWorker[] {
	return runs.map((run, index) => ({
		index: index + 1,
		model: run.model ?? sessionModel ?? "session model",
		thinking: run.thinking,
		startedAt,
		active: true,
		persona: personas[index],
	}));
}

// --- Worker process -------------------------------------------------------------------------------

const HISTORY_KEY = Symbol.for("me-pi.delegate.history");
// Background job ids (bg<n>) count here, across /reload, so ids never repeat within one Pi process.
const JOB_COUNT_KEY = Symbol.for("me-pi.delegate.job-count");
// The abort reason of a session shutdown (/reload, /new, /resume, /fork, handoff, exit).
const SESSION_ENDED = "session ended";
function piCommand(args: string[]): { command: string; args: string[] } {
	if (process.env.PI_BIN) return { command: process.env.PI_BIN, args };
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && existsSync(script))
		return { command: process.execPath, args: [script, ...args] };
	if (/^(node|bun)(\.exe)?$/i.test(basename(process.execPath))) return { command: "pi", args };
	return { command: process.execPath, args };
}

function runWorkerAttempt(
	job: Job,
	prompt: string,
	run: { model?: string; thinking: string },
	cwd: string,
	signal: AbortSignal,
	onProgress: (r: RunResult) => void,
	outDir: string | undefined,
	budget: AttemptBudget,
	attemptIndex: number,
): Promise<RunResult> {
	const start = Date.now();
	const ledger = createAttemptLedger({ job, run, outDir, budget, attemptIndex, onProgress });
	const { result, provenance } = ledger;
	const launch = workerLaunch(job, {
		run,
		outDir: result.outDir,
		attemptIndex,
		budget: { tools: budget.toolCalls, deadline: budget.toolDeadline, cost: budget.toolCostCapUsd },
	});
	const timeoutMs = Math.max(0, budget.hardDeadline - start);

	return new Promise((done) => {
		if (signal.aborted) {
			const sessionEnded = signal.reason === SESSION_ENDED;
			provenance.stopFacts.push({
				owner: "delegate-parent",
				jobId: job.jobId,
				attempt: attemptIndex,
				cause: sessionEnded ? "session-ended" : "cancelled",
				resource: "cancellation",
				effect: "not-started",
			});
			return done({
				...result,
				failure: sessionEnded ? "session ended before start" : "cancelled before start",
			});
		}
		const { command, args: argv } = piCommand(launch.args);
		const proc = startWorkerProcess({
			command,
			args: argv,
			env: launch.env,
			cwd,
			// The prompt goes on stdin: no argv size limit, and a leading "-" or "@" is not parsed as an option.
			stdin: prompt,
			exitGraceMs: LIMITS.exitGraceMs,
			onRecord: (event) => ledger.record(event),
			onMalformed: () => ledger.malformed(),
			onStderr: (chunk) => ledger.stderr(chunk),
			onKillFailure: (failure) => ledger.killFailure(failure),
			onExit: (code, problem) => finish(code, problem),
		});
		const pid = proc.pid;
		ledger.attach(pid === undefined ? undefined : () => proc.stop());
		let finished = false;
		const finish = (code: number | null, problem?: string) => {
			if (finished) return;
			ledger.close();
			finished = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			result.ms = Date.now() - start;
			if (result.outDir) {
				try {
					result.files = listOutput(result.outDir);
				} catch (err: any) {
					result.files = [`(could not list: ${err?.message ?? err})`];
				}
			}
			done(ledger.settle(code, problem));
		};

		const timer = setTimeout(
			() => ledger.stop(`timeout after ${budget.limitSecs}s`, ledger.parentFact("hard-timeout", "hard-time")),
			timeoutMs,
		);
		// A session shutdown aborts with SESSION_ENDED; /delegate cancel and the turn's abort are a cancel.
		const onAbort = () =>
			ledger.stop(
				signal.reason === SESSION_ENDED ? "session ended" : "cancelled",
				ledger.parentFact(signal.reason === SESSION_ENDED ? "session-ended" : "cancelled", "cancellation"),
			);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function runWorker(
	job: Job,
	prompt: string,
	run: ResolvedRun,
	cwd: string,
	signal: AbortSignal,
	onProgress: (r: RunResult) => void,
): Promise<RunResult> {
	const start = Date.now();
	const secs = job.role === "scout" ? LIMITS.scoutTimeoutSecs : LIMITS.timeoutSecs;
	const hardDeadline = start + secs * 1000;
	const toolDeadline = start + LIMITS.wrapUpShare * secs * 1000;
	const hardCostCap = LIMITS.costCapUsd;
	const toolCostCap = LIMITS.wrapUpShare * hardCostCap;
	let outDir: string | undefined;
	if (job.output) {
		try {
			outDir = mkdtempSync(join(tmpdir(), "me-pi-delegate-out-")); // Mode 0700.
		} catch (err: any) {
			return {
				requested: { model: run.model, thinking: run.thinking },
				web: job.web,
				output: "",
				failure: `could not create the output directory: ${err?.message ?? err}`,
				turns: 0,
				usage: {},
				tools: [],
				stderr: "",
				ms: Date.now() - start,
			};
		}
	}

	const selected = Object.freeze({ model: run.model, thinking: run.thinking });
	const budget: AttemptBudget = {
		limitSecs: secs,
		hardDeadline,
		limitCostUsd: hardCostCap,
		hardCostCapUsd: hardCostCap,
		toolDeadline,
		toolCostCapUsd: toolCostCap,
		toolCalls: job.role === "scout" ? LIMITS.scoutToolCalls : null,
	};
	const runAttempt = (index: number, attemptBudget: AttemptBudget) =>
		runWorkerAttempt(job, prompt, selected, cwd, signal, onProgress, outDir, attemptBudget, index);
	let attempt = await runAttempt(1, budget);
	for (const delayMs of LIMITS.infraRetryDelaysMs) {
		if (!infraRetryable(attempt) || Date.now() + delayMs >= budget.toolDeadline) break;
		if (!(await sleepUnlessAborted(delayMs, signal))) break;
		const spent = costOf(attempt.usage);
		const next = await runAttempt((attempt.provenance?.length ?? 0) + 1, {
			...budget,
			hardCostCapUsd: budget.hardCostCapUsd - spent,
			toolCostCapUsd: budget.toolCostCapUsd - spent,
		});
		attempt = mergeAttempts(attempt, next);
	}
	return attempt;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	return new Promise((done) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			done(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			done(false);
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

// --- Result formatting ----------------------------------------------------------------------------

function cap(text: string, bytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= bytes) return text;
	let end = bytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // Never split a UTF-8 character.
	return `${buf.subarray(0, end).toString("utf8")}\n[answer truncated at ${bytes} bytes]`;
}

const modelName = (r: RunResult) => r.requested.model ?? r.model ?? "session model";
const label = (r: RunResult) =>
	`[${modelName(r).split("/").pop()} @${r.requested.thinking}${r.web ? " web" : ""} $${costOf(r.usage).toFixed(4)} ${Math.round(r.ms / 1000)}s]`;

// Full texts the main session may need but should not carry: truncated answers and round-1 answers.
let savedCount = 0;
export function saveFull(text: string): string {
	try {
		const dir = join(tmpdir(), `me-pi-delegate-${process.pid}`);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const path = join(dir, `answer-${Date.now()}-${++savedCount}.md`);
		writeFileSync(path, text, { mode: 0o600 });
		return path;
	} catch (err: any) {
		return `(not saved: ${err?.message ?? err})`;
	}
}

// The paths only: the main session copies or reads the drafts it needs.
const filesLine = (r: RunResult) =>
	r.outDir ? `\nFiles in ${r.outDir}: ${r.files?.length ? r.files.join(", ") : "none written"}` : "";

const withoutOutput = ({ output: _output, ...rest }: RunResult) => rest;

/** A run as the TUI shows it; `r` may be a run that has not reported yet. */
function runView(
	r: Pick<RunResult, "requested" | "web"> & Partial<RunResult>,
	done: boolean,
	round2Failure?: string,
	persona?: Persona,
): RunView {
	return {
		persona,
		model: r.requested.model ?? r.model ?? "session model",
		thinking: r.requested.thinking,
		web: r.web,
		done,
		failure: r.failure,
		round2Failure,
		turns: r.turns ?? 0,
		cost: costOf(r.usage ?? {}),
		ms: r.ms ?? 0,
		lastTool: r.tools?.at(-1),
		activity: r.tools?.slice(-MAX_TOOL_HISTORY),
		output: r.output ?? "",
		outDir: r.outDir,
		files: r.files,
	};
}

/** Cuts an answer past `HANDBACK_CEILING` to its head and tail, keeping the BLOCKED lines it cut (see `formatCutBlocked`) and a path to the rest. */
function trimMiddle(answer: string): string {
	const buf = Buffer.from(answer, "utf8");
	if (buf.length <= HANDBACK_CEILING) return answer;
	let headEnd = HANDBACK_CEILING - HANDBACK_TAIL;
	while (headEnd > 0 && (buf[headEnd] & 0xc0) === 0x80) headEnd--;
	let tailStart = buf.length - HANDBACK_TAIL;
	while (tailStart < buf.length && (buf[tailStart] & 0xc0) === 0x80) tailStart++;
	const head = buf.subarray(0, headEnd).toString("utf8");
	const tail = buf.subarray(tailStart).toString("utf8");
	const blocked = formatCutBlocked(blockedLines(answer).filter((l) => !head.includes(l) && !tail.includes(l)));
	return `${head}\n[${tailStart - headEnd} bytes cut]\n${blocked}${tail}\nFull answer: ${saveFull(answer)}`;
}

function formatRun(r: RunResult): string {
	const answer = r.output.trim() || "(empty answer)";
	let body: string;
	if (!r.failure) body = `${trimMiddle(answer)}${filesLine(r)}\n${label(r)}`;
	else {
		const partial = r.output.trim() ? `\nPartial answer:\n${trimMiddle(r.output.trim())}` : "";
		body = `✗ ${r.failure}${failureClassLine(r)}${partial}${filesLine(r)}\n${label(r)}\n${RECOVERY_POINTER}`;
	}
	return body;
}

function rebuttalPrompt(task: string, own: RunResult, others: RunResult[]): string {
	const answers = others
		.map((o) => `### ${modelName(o)}\n${cap(o.output.trim(), ANSWER_CAP)}${filesLine(o)}`)
		.join("\n\n");
	return `Task:\n${task}\n\n## Round 2 (rebuttal)\nYou already answered this task in round 1. Your round-1 answer:\n\n${cap(own.output.trim(), ANSWER_CAP)}${filesLine(own)}\n\nOther workers answered the same task independently:\n\n${answers}\n\nCheck their evidence against yours with your tools where needed. Keep, revise, or retract each of your claims and point out errors in theirs. Carry forward every objection, yours or theirs, that is still open. Final answer in the format your system prompt or the task sets, then \`Changed: yes|no\` with the reason and, for each change, what changed and why.`;
}

// --- Tool -----------------------------------------------------------------------------------------

function buildSchema() {
	const model = {
		type: "string",
		minLength: 1,
		description: "provider/id, or a bare id that one logged-in provider offers.",
	};
	return {
		type: "object",
		properties: {
			role: {
				type: "string",
				enum: ROLE_NAMES,
				description: "Omit for general: read-only work of any kind. scout: fast bounded read-only search.",
			},
			task: {
				type: "string",
				description:
					"Read-only workers cannot run commands: write diffs or command output to a temp file and pass its path.",
			},
			web: {
				type: "boolean",
				description:
					"Web tools are on only when this is true. Set it only when the task needs outside sources: fetched pages can steer a worker into sending local files out.",
			},
			answer: {
				type: "string",
				minLength: 1,
				maxLength: MAX_FORMAT,
				description: "Final answer format; replaces the role's.",
			},
			runs: {
				type: "array",
				minItems: 1,
				maxItems: MAX_RUNS,
				description:
					"An explicitly named model runs alone and never falls back; name one for a second opinion or to continue work on it.",
				items: {
					type: "object",
					additionalProperties: false,
					properties: { model, thinking: { type: "string", enum: THINKING_LEVELS } },
				},
			},
			output: {
				type: "boolean",
				description:
					"For a draft (docs, a plan, a patch): each worker may `write` only into its own temp directory; the result lists file paths, not contents. Copy what you keep and check the diff yourself.",
			},
			rebuttal: {
				type: "boolean",
				description:
					"In round 2 each worker sees the others' answers and keeps, revises, or retracts its claims; only round 2 returns.",
			},
			background: {
				type: "boolean",
				description:
					"Return a job id at once; the answer arrives later as a `delegate` message that starts a turn. Jobs end on /reload or exit; refused in print and JSON modes, where the run exits first.",
			},
		},
		required: ["task"],
		additionalProperties: false,
	};
}

export const PROMPT_SNIPPET = "Run read-only workers, alone or as a multi-model panel; get back only their answers";

export const PROMPT_GUIDELINES = [
	"Delegate only to keep a large read out of context or to work in the background; a few reads or a small edit stay inline, even one that needs a review. A read over ~3 files, ~300 lines, or ~12 KB (changelogs and docs run long), or of unknown scope, goes to `scout`, except your own brief and the files you will edit; web research to `general` with `web: true`, not your own web tools; independent judgment to `general`. Make a change yourself, however many files it spans; when it is too big for your context, say so and propose a split for the user or a chief. User, repo (use delegate for required subagents), or skill requirements come first.",
	"Work from handbacks: read only lines you will act on; spot-check only claims a decision rests on. Give a worker any diff or log as a temp file path; do not read or print it yourself. Resolve or report each BLOCKED line.",
	"Past ~50 changed lines of your own, on security or data risk, a breaking public-contract change, or when asked, give one `general` reviewer the diff file with `answer` set to severity-ranked findings, and fix them yourself. A skill's own review replaces this.",
	"Workers see only the brief, not this chat or loaded skill bodies: give scope, deliverable, context, acceptance evidence, and any skill to load with `Skill`. When a skill applies, you keep its user decisions and orchestration; a handback completes only its step.",
	"For several models on one question, make one call, one `runs` entry each, plus `rebuttal: true` to cross-check; report agreements, disagreements with evidence, and your verdict.",
	"New work is a branch in place by default; when the user asks for a worktree, or another session is writing here, run `git worktree add ../<repo>.worktrees/<name> -b <branch>` and give the user that path to start Pi in. Surface failed handbacks. Pushes, PRs, merges, and branch deletion are main-session only, with user authorization.",
	"Set `background: true` for work that takes minutes while you keep going with the user; tell them the job id; do not wait, poll, or repeat the call.",
];

/** The error for a call that still uses the removed `implement` role or its `check` parameter. */
export const IMPLEMENT_REMOVED =
	"the implement role and its `check` parameter were removed in @agmxyz/pi-workers 0.3.0: make the change yourself (the coordinator writes, checks, and commits), using scout or general for read-only help; see docs/delegate.md#migrating-from-implement";

const SPEND_WARN_SHARE = 0.8;

/**
 * Opt-in status for an external supervisor, which cannot see the coordinator's pane: `ME_PI_STATUS_LOG` gets one
 * line when a coordinator turn ends on a provider error (after Pi's own retries), and `ME_PI_SPEND_BUDGET_USD` warns,
 * there and in the UI, when the session's estimated spend (coordinator turns plus delegate workers) passes 80% and
 * then 100% of it. Pi-reported cost is an estimate, not the provider's counter. Returns the worker-spend sink.
 */
function coordinatorStatus(pi: ExtensionAPI): (cost: number) => void {
	const path = process.env.ME_PI_STATUS_LOG;
	const budget = Number(process.env.ME_PI_SPEND_BUDGET_USD);
	if (!path && !(budget > 0)) return () => {};
	let ui: Pick<ExtensionContext["ui"], "notify"> | undefined;
	const report = (line: string, level: "warning" | "error") => {
		const text = line.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 500);
		if (path)
			try {
				appendFileSync(path, `${new Date().toISOString()} ${text}\n`, { mode: 0o600 });
			} catch (err) {
				ui?.notify(`delegate: status log not written: ${(err as Error).message}`, "error");
			}
		ui?.notify(text, level);
	};
	let spent = 0;
	let announced = 0;
	const addSpend = (cost: number) => {
		spent += cost;
		if (!(budget > 0)) return;
		const level = spent >= budget ? 2 : spent >= SPEND_WARN_SHARE * budget ? 1 : 0;
		if (level <= announced) return;
		announced = level;
		const amounts = `estimated spend $${spent.toFixed(2)} of the $${budget.toFixed(2)} budget`;
		report(level === 2 ? `BUDGET: ${amounts} reached; stop starting work` : `WARNING: ${amounts}`, "warning");
	};
	let providerError: string | undefined;
	pi.on("message_end", (event, ctx) => {
		ui = ctx?.ui;
		const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: any };
		if (msg?.role !== "assistant") return;
		addSpend(costOf(msg.usage ?? {}));
		providerError = msg.stopReason === "error" ? msg.errorMessage || "provider error" : undefined;
	});
	pi.on("agent_settled", (event) => {
		const error = providerError;
		providerError = undefined;
		if (!error || event.aborted || !path) return;
		const kind = classifyProviderError(error);
		report(`STOPPED: ${kind}: ${error}${kind === "account" ? " (BLOCKER: needs the user)" : ""}`, "error");
	});
	return addSpend;
}

export default function (pi: ExtensionAPI) {
	// Workers never get the tool, so delegation cannot nest; they only get the wrap-up budget, the secret-path
	// block, and the output-directory write block.
	if (isWorkerProcess()) {
		registerWorker(pi);
		return;
	}
	const addSpend = coordinatorStatus(pi);
	let shutdown = new AbortController();
	const running = new Set<Promise<unknown>>();
	// For /delegate status: calls running now, and the last HISTORY_SIZE finished calls.
	const active = new Map<string, ActiveCall>();
	let activeCallCount = 0;
	const ACTIVITY_WIDGET_KEY = "delegate-activity";
	let activityUi: Pick<ExtensionContext["ui"], "setWidget"> | undefined;
	let activityTui: { requestRender: () => void } | undefined;
	let activityTimer: NodeJS.Timeout | undefined;
	const activityRows = (): ActivityWidgetRow[] =>
		[...active.values()].flatMap((call) =>
			(call.workers ?? [])
				.filter((worker) => worker.active)
				.map((worker) => ({
					job: call.job,
					worker: worker.index,
					workerCount: call.workers?.length ?? 0,
					model: worker.model,
					thinking: worker.thinking,
					startedAt: worker.startedAt,
					lastTool: worker.lastTool,
					stage: call.stage ?? "Workers",
					persona: worker.persona,
				})),
		);
	const clearActivityWidget = () => {
		clearInterval(activityTimer);
		activityTimer = undefined;
		const tui = activityTui;
		activityUi?.setWidget(ACTIVITY_WIDGET_KEY, undefined);
		tui?.requestRender();
		activityUi = undefined;
		activityTui = undefined;
	};
	const updateActivityWidget = (ctx: ExtensionContext, signal?: AbortSignal) => {
		if (!activityRows().length) {
			clearActivityWidget();
			return;
		}
		if (signal?.aborted) return;
		if (ctx.mode !== "tui") return;
		if (!activityUi) {
			activityUi = ctx.ui;
			activityUi.setWidget(ACTIVITY_WIDGET_KEY, (tui, theme) => {
				activityTui = tui;
				return activityWidget(activityRows, theme);
			});
		}
		if (!activityTimer) {
			activityTimer = setInterval(() => activityTui?.requestRender(), 1000);
			activityTimer.unref();
		}
		activityTui?.requestRender();
	};
	// Background jobs by id, for /delegate cancel and session shutdown.
	const jobs = new Map<string, AbortController>();
	const cancel = (id: string) => {
		const job = jobs.get(id);
		if (!job) return `No running background job ${id}.`;
		job.abort();
		return `Cancelling background job ${id}.`;
	};
	// Shared by reloaded instances, like the worker groups, so /reload keeps it.
	const shared = globalThis as any;
	shared[HISTORY_KEY] ??= [];
	const history: CallRecord[] = shared[HISTORY_KEY];
	registerDelegateCommand(pi, { configPath, loadModelSet: () => loadModelSet(), history, active, cancel });
	// Pi offers no hook before /reload or exit, so those still end background jobs unasked.
	const confirmEndingJobs = async (ctx: any) => {
		if (!jobs.size || !ctx?.hasUI) return;
		const ids = [...jobs.keys()].join(", ");
		const one = jobs.size === 1;
		// No comes first so a reflexive Enter keeps the jobs; Escape keeps them too.
		const end = `Yes, end ${one ? "it" : "them"}`;
		const choice = await ctx.ui.select(
			`${ids} still running in the background; leaving this session ends ${one ? "it" : "them"}.`,
			["No, stay in this session", end],
		);
		return choice === end ? undefined : { cancel: true };
	};
	pi.on("session_before_switch", (_event, ctx) => confirmEndingJobs(ctx));
	pi.on("session_before_fork", (_event, ctx) => confirmEndingJobs(ctx));
	pi.on("session_shutdown", async () => {
		clearActivityWidget();
		shutdown.abort(SESSION_ENDED);
		shutdown = new AbortController();
		await Promise.allSettled([...running]);
	});
	pi.registerMessageRenderer("delegate", (message, options, theme) => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		return renderHandback(text, message.details, handbackBlocked(text), options, theme);
	});
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Run read-only Pi workers: none of them edits the checkout. Each run uses one model; no cross-model fallback.",
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		renderCall: (args, theme, context) => renderCall(args, theme, context),
		renderResult: (result, options, theme, context) => renderResult(result as any, options, theme, context),
		parameters: buildSchema() as any,
		// Pi validates arguments against the schema before execute, which knows neither the role nor `check`.
		prepareArguments: (args: any) => {
			if (args?.role === "implement" || args?.check !== undefined) throw new Error(IMPLEMENT_REMOVED);
			return args;
		},

		async execute(_id, params: any, toolSignal, onUpdate, ctx) {
			const fail = (text: string, details: Record<string, unknown> = {}) => ({
				content: [{ type: "text" as const, text }],
				details,
				isError: true,
			});
			const { role = "general", task, web, answer, output, rebuttal, background } = params ?? {};
			const unknown = Object.keys(params ?? {}).filter(
				(k) => !["role", "task", "web", "answer", "output", "runs", "rebuttal", "background"].includes(k),
			);
			if (unknown.length)
				return fail(
					`unknown parameter(s) ${unknown.join(", ")}; set model and thinking inside runs: [{ model, thinking }]`,
				);
			if (typeof role !== "string" || !Object.hasOwn(ROLES, role))
				return fail(`role must be one of ${ROLE_NAMES.join(", ")}`);
			if (typeof task !== "string" || !task.trim()) return fail("task must be a non-empty string");
			if (web !== undefined && typeof web !== "boolean") return fail("web must be true or false");
			if (answer !== undefined && (typeof answer !== "string" || !answer.trim() || answer.length > MAX_FORMAT))
				return fail(`answer must be a non-empty string of at most ${MAX_FORMAT} characters`);
			if (output !== undefined && typeof output !== "boolean") return fail("output must be true or false");
			if (background !== undefined && typeof background !== "boolean")
				return fail("background must be true or false");
			// A print or JSON run exits when its reply ends, which ends the job before its answer can arrive.
			if (background && (ctx?.mode === "print" || ctx?.mode === "json"))
				return fail(
					`background: true is refused in ${ctx.mode} mode: the run exits when its reply ends, so the job's answer would be lost. Run it in the foreground: call delegate again without background and wait for the answer.`,
				);
			const job: Job = {
				role,
				jobId: randomUUID(),
				web: web === true,
				answer: answer?.trim() ?? ROLES[role].answer,
				output: output === true,
			};
			const specs: RunSpec[] = params.runs ?? [{}];
			if (!Array.isArray(specs) || specs.length < 1 || specs.length > MAX_RUNS)
				return fail(`runs must have 1-${MAX_RUNS} entries`);
			const badRun = specs.findIndex(
				(r: any) =>
					!r ||
					typeof r !== "object" ||
					(r.model !== undefined && (typeof r.model !== "string" || !r.model.trim())) ||
					(r.thinking !== undefined && !THINKING_LEVELS.includes(r.thinking)),
			);
			if (badRun >= 0)
				return fail(`runs[${badRun}] must be { model?: string, thinking?: ${THINKING_LEVELS.join("|")} }`);
			if (rebuttal && specs.length < 2) return fail("rebuttal needs at least 2 runs");
			let set: ModelSet;
			let session: string | undefined;
			let resolved: ResolvedRun[];
			try {
				set = loadModelSet();
				session = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const configured = new Set(configuredModels(set));
				for (const spec of specs)
					if (spec.model && !configured.has(spec.model)) validateOneOffModel(spec.model, ctx?.modelRegistry);
				resolved = resolveRuns(role, specs, set, {
					sessionModel: session,
					sessionThinking: ctx?.thinkingLevel,
					registry: ctx?.modelRegistry,
				});
				job.skills = set.readOnlySkills;
			} catch (err: any) {
				return fail(err.message);
			}
			const models = resolved.map((r) => r.model ?? "session model");
			// Picked once per worker: progress, the widget, and the rebuttal round all reuse it.
			const personas = resolved.map(() => pickPersona(role));
			const busy = [...active.values()].reduce((sum, a) => sum + a.models.length, 0);
			if (busy + resolved.length > MAX_RUNS)
				return fail(
					`${busy} worker(s) already running; at most ${MAX_RUNS} run at once. Wait for a background answer or stop one with /delegate cancel <id>.`,
				);
			const callKey = `delegate-call-${++activeCallCount}`;
			// The session this call belongs to: its shutdown stops the call and drops a background answer.
			const ended = shutdown.signal;
			const prompt = `Task:\n${task}`;
			const call = async (
				key: string,
				signal: AbortSignal,
				onUpdate: ((u: any) => void) | undefined,
				jobId?: string,
			) => {
				const start = Date.now();
				active.set(key, {
					role,
					models,
					start,
					job: jobId,
					workers: initialActivity(resolved, personas, session, start),
					stage: "Workers",
				});
				try {
					updateActivityWidget(ctx, ended);
					const cwd = ctx?.cwd ?? process.cwd();
					const round = async (
						stage: Exclude<DelegateView["stage"], "Done">,
						prompts: string[],
						runs: typeof resolved,
						runPersonas: Persona[],
					) => {
						const states: (RunResult | undefined)[] = runs.map(() => undefined);
						const finished = runs.map(() => false);
						const progress = (emit = true) => {
							const view: DelegateView = {
								stage,
								web: job.web,
								runs: runs.map((r, i) =>
									runView(
										states[i] ?? { requested: { model: r.model, thinking: r.thinking }, web: job.web },
										finished[i],
										undefined,
										runPersonas[i],
									),
								),
							};
							const callState = active.get(key);
							if (callState) {
								callState.stage = stage;
								callState.workers = view.runs.map((run, i) => ({
									index: i + 1,
									model: run.model,
									thinking: run.thinking,
									startedAt: callState.workers?.[i]?.startedAt ?? callState.start,
									active: !finished[i],
									lastTool: run.lastTool,
									persona: runPersonas[i],
								}));
								updateActivityWidget(ctx, ended);
							}
							if (!emit) return;
							const lines = progressLines(view);
							onUpdate?.({
								content: [{ type: "text", text: lines.join("\n") }],
								details: { view },
							});
						};
						progress(false);
						return Promise.all(
							runs.map(async (r, i) => {
								const p = runWorker(job, prompts[i], r, cwd, signal, (s) => {
									states[i] = s;
									progress();
								});
								running.add(p);
								try {
									states[i] = await p;
								} finally {
									running.delete(p);
								}
								finished[i] = true;
								progress();
								return states[i] as RunResult;
							}),
						);
					};

					const round1 = await round(
						"Workers",
						resolved.map(() => prompt),
						resolved,
						personas,
					);
					// The runs to report, in request order; a failed round-2 run keeps its round-1 answer.
					let shown: { run: RunResult; failedRound2?: RunResult }[] = round1.map((run) => ({ run }));
					let round2: RunResult[] = [];
					let note = "";
					let failed = round1.some((r) => r.failure);
					if (rebuttal) {
						const ok = round1.filter((r) => !r.failure);
						if (ok.length < 2) {
							note = `Rebuttal skipped: only ${ok.length} run(s) succeeded in round 1.`;
							failed = true;
						} else {
							const prompts = ok.map((r) =>
								rebuttalPrompt(
									task,
									r,
									ok.filter((o) => o !== r),
								),
							);
							// Each rebuttal remains on the same selected model and thinking level.
							round2 = await round(
								"Rebuttal",
								prompts,
								ok.map((r) => resolved[round1.indexOf(r)]),
								ok.map((r) => personas[round1.indexOf(r)]),
							);
							shown = round1.map((run) => {
								const r2 = round2[ok.indexOf(run)];
								if (!r2) return { run };
								return r2.failure ? { run, failedRound2: r2 } : { run: r2 };
							});
							failed ||= round2.some((r) => r.failure);
							const full = round1.map(
								(r) =>
									`## ${modelName(r)} (round 1)\n\n${r.failure ? `✗ ${r.failure}\n` : ""}${r.output.trim()}${filesLine(r)}`,
							);
							note = `Round-1 answers: ${saveFull(full.join("\n\n"))}`;
						}
					}
					const all = [...round1, ...round2];
					const cost = all.reduce((sum, r) => sum + costOf(r.usage), 0);
					addSpend(cost);
					history.push({
						at: Date.now(),
						role,
						models: round1.map(modelName),
						cost,
						ms: Date.now() - start,
						failed,
					});
					if (history.length > HISTORY_SIZE) history.shift();
					const usage: Record<string, any> = {};
					for (const r of all) addUsage(usage, r.usage);
					const footer =
						all.length > 1 ? `Total: ${all.length} runs, $${costOf(usage).toFixed(4)}. ${note}` : note;
					const sections = shown.map(({ run, failedRound2: r2 }) =>
						r2
							? `✗ round 2 failed: ${r2.failure}${filesLine(r2)}\nRound-1 answer:\n${formatRun(run)}`
							: formatRun(run),
					);
					const view: DelegateView = {
						stage: "Done",
						web: job.web,
						runs: shown.map(({ run, failedRound2: r2 }) =>
							runView(run, true, r2 && `${r2.failure}${filesLine(r2).replace("\n", "; ")}`),
						),
						footer: footer.trim() || undefined,
					};
					return {
						content: [
							{ type: "text" as const, text: [...sections, footer.trim()].filter(Boolean).join("\n\n---\n\n") },
						],
						// The answers are in the view and the content; the rounds keep the rest for debugging.
						details: {
							round1: round1.map(withoutOutput),
							round2: round2.map(withoutOutput),
							view,
						},
						// A worker that died before its first reply reported no usage; Pi reads cost.total from any usage it is given.
						...(usage.cost && { usage: usage as any }),
						isError: failed,
					};
				} finally {
					active.delete(key);
					updateActivityWidget(ctx, ended);
				}
			};
			if (!background) {
				const signal = toolSignal ? AbortSignal.any([toolSignal, ended]) : ended;
				return call(callKey, signal, onUpdate);
			}

			// The turn's abort does not stop a background job; /delegate cancel and session shutdown do.
			shared[JOB_COUNT_KEY] = (shared[JOB_COUNT_KEY] ?? 0) + 1;
			const id = `bg${shared[JOB_COUNT_KEY]}`;
			const controller = new AbortController();
			jobs.set(id, controller);
			const deliver = (text: string, details: unknown, isError: boolean) => {
				// After shutdown the session that asked is gone; its answer has nowhere to go.
				if (ended.aborted) return;
				pi.sendMessage(
					{
						customType: "delegate",
						content: `Background delegate job ${id}${isError ? " failed" : ""}:\n\n${text}`,
						display: true,
						// The renderer's job line reads these; evals/score.ts reads the view.
						details: { ...(details as object), job: id, failed: isError },
					},
					// A cancelled job reports without starting a turn: the user stopped it.
					{ triggerTurn: !controller.signal.aborted, deliverAs: "followUp" },
				);
			};
			call(callKey, AbortSignal.any([controller.signal, ended]), undefined, id)
				.then((result: any) => {
					deliver(result.content.map((c: any) => c.text).join("\n"), result.details, Boolean(result.isError));
				})
				.catch((err: any) => deliver(`✗ ${err?.message ?? err}`, {}, true))
				.finally(() => {
					jobs.delete(id);
				});
			return {
				content: [
					{
						type: "text" as const,
						text: `Started background job ${id} (${models.join(", ")}). Its answer arrives as a later message; /delegate cancel ${id} stops it.`,
					},
				],
				details: { background: id },
			};
		},
	});
}
