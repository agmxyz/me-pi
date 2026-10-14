/**
 * delegate — native tool for isolated one-shot or parallel read-only subagent runs.
 * Roles live in ../agents/<role>.md and are re-read on every call.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const REPO = resolve(HERE, "..");

const DEFAULT_TOOLS = "read,grep,find,ls";
const DEFAULT_THINKING = "high";
const DEFAULT_TIMEOUT_SECS = 300;
const DEFAULT_COST_CAP_USD = 2;
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

export interface RoleConfig {
	name: string;
	description: string;
	tools: string;
	model?: string;
	thinking?: string;
	attachDiff: boolean;
	body: string;
}

export interface FrontmatterResult {
	fields: Record<string, string>;
	body: string;
	error?: string;
}

/**
 * Parse simple YAML frontmatter (`key: value` lines between `---` markers).
 * Rejects unquoted `: ` inside a value (compact nested mapping syntax error in YAML)
 * so broken role frontmatter is caught by tests.
 */
export function parseFrontmatterText(content: string): FrontmatterResult {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);
	if (!match) return { fields: {}, body: content, error: "missing frontmatter delimiter" };

	const fields: Record<string, string> = {};
	const lines = match[1].split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) return { fields, body: match[2] ?? "", error: `invalid frontmatter line ${i + 1}: ${line}` };
		const key = line.slice(0, colon).trim();
		let raw = line.slice(colon + 1).trim();
		if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
			raw = raw.slice(1, -1);
		} else {
			raw = raw.replace(/\s+#.*$/, "").trim();
			if (raw.includes(": ")) {
				return {
					fields,
					body: match[2] ?? "",
					error: `unquoted colon in "${key}" (quote the value in YAML)`,
				};
			}
		}
		fields[key] = raw;
	}
	return { fields, body: (match[2] ?? "").trim() };
}

export function loadRoles(agentsDir = join(REPO, "agents")): { roles: Map<string, RoleConfig>; errors: string[] } {
	const roles = new Map<string, RoleConfig>();
	const errors: string[] = [];
	if (!existsSync(agentsDir)) return { roles, errors };

	for (const entry of readdirSync(agentsDir).filter((n) => n.endsWith(".md")).sort()) {
		const filePath = join(agentsDir, entry);
		const fallbackName = entry.replace(/\.md$/, "");
		let content: string;
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			errors.push(`${entry}: unreadable`);
			continue;
		}
		const { fields, body, error } = parseFrontmatterText(content);
		if (error) {
			errors.push(`${entry}: ${error}`);
			continue;
		}
		const name = fields.name || fallbackName;
		if (!fields.description) {
			errors.push(`${entry}: missing description`);
			continue;
		}
		const tools = (fields.tools ?? DEFAULT_TOOLS)
			.replace(/^\[|\]$/g, "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean)
			.join(",");
		roles.set(name, {
			name,
			description: fields.description,
			tools: tools || DEFAULT_TOOLS,
			model: fields.model || undefined,
			thinking: fields.thinking || undefined,
			attachDiff: fields.attach_diff === "true",
			body,
		});
	}
	return { roles, errors };
}

/**
 * Read-only working-tree diff vs HEAD (including untracked non-ignored files).
 * Never writes loose objects into `.git/objects` and never touches `.git/index`.
 */
export function computeWorkingTreeDiff(dir: string): string {
	const topRes = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
	if (topRes.status !== 0) throw new Error(`not a git work tree: ${dir}`);
	const top = topRes.stdout.trim();

	const hasHead = spawnSync("git", ["-C", top, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8" }).status === 0;
	const chunks: string[] = [];

	if (hasHead) {
		const tracked = spawnSync(
			"git",
			["-C", top, "diff", "HEAD", "--binary", "--no-color", "--no-ext-diff", "--no-textconv"],
			{ encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
		);
		if (tracked.status !== 0) throw new Error(`could not compute git diff of ${top}`);
		if (tracked.stdout) chunks.push(tracked.stdout);
	}

	const lsArgs = hasHead
		? ["-C", top, "ls-files", "--others", "--exclude-standard", "-z"]
		: ["-C", top, "ls-files", "--cached", "--others", "--exclude-standard", "-z"];
	const untracked = spawnSync("git", lsArgs, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
	if (untracked.status !== 0) throw new Error(`could not list untracked files of ${top}`);
	if (untracked.stdout) {
		for (const rel of untracked.stdout.split("\0").filter(Boolean)) {
			const full = join(top, rel);
			try {
				if (!statSync(full).isFile()) continue;
			} catch {
				continue;
			}
			const patch = spawnSync(
				"git",
				["-C", top, "diff", "--no-index", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--", "/dev/null", rel],
				{ encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
			);
			if (patch.stdout) chunks.push(patch.stdout);
		}
	}

	return chunks.join("");
}

export function appendFencedDiff(task: string, diff: string): string {
	let maxBackticks = 2;
	for (const match of diff.matchAll(/`+/g)) {
		if (match[0].length > maxBackticks) maxBackticks = match[0].length;
	}
	const fence = "`".repeat(maxBackticks + 1);
	return `${task}\n\n## Diff (working tree vs HEAD, auto-attached)\n\n${fence}diff\n${diff}${diff.endsWith("\n") ? "" : "\n"}${fence}\n`;
}

interface TaskSpec {
	role: string;
	task: string;
	cwd?: string;
	model?: string;
	thinking?: string;
}

interface RunResult {
	role: string;
	exitCode: number;
	output: string;
	stderr: string;
	turns: number;
	cost: number;
	durationSecs: number;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	recentTools: string[];
}

function getPiCommand(args: string[]): { command: string; args: string[] } {
	if (process.env.PI_BIN) return { command: process.env.PI_BIN, args };
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

function summarizeToolCall(name: string, args: Record<string, any>): string {
	switch (name) {
		case "read":
			return `read ${args.path ?? args.file_path ?? "..."}`;
		case "grep":
			return `grep /${args.pattern ?? ""}/ in ${args.path ?? "."}`;
		case "find":
			return `find ${args.pattern ?? "*"} in ${args.path ?? "."}`;
		case "ls":
			return `ls ${args.path ?? "."}`;
		case "bash": {
			const cmd = String(args.command ?? "...");
			return `$ ${cmd.length > 50 ? `${cmd.slice(0, 50)}...` : cmd}`;
		}
		default:
			return name;
	}
}

function truncateOutput(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= PER_TASK_OUTPUT_CAP) return text;
	let sliced = text.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(sliced, "utf8") > PER_TASK_OUTPUT_CAP) sliced = sliced.slice(0, -1);
	return `${sliced}\n\n[Output truncated at ${PER_TASK_OUTPUT_CAP} bytes]`;
}

async function mapWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	const results = new Array<TOut>(items.length);
	let nextIndex = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
		while (nextIndex < items.length) {
			const current = nextIndex++;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function brokenRolesNote(errors: string[]): string {
	return errors.length ? `\nBroken role files (fix frontmatter): ${errors.join("; ")}` : "";
}

function envNumber(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
	return value;
}

async function runSingleRole(
	spec: TaskSpec,
	{ roles, errors: roleErrors }: { roles: Map<string, RoleConfig>; errors: string[] },
	defaults: { cwd: string; model?: string; thinking?: string; timeoutSecs: number; costCapUsd: number },
	signal: AbortSignal | undefined,
	onProgress?: (res: RunResult) => void,
): Promise<RunResult> {
	const startMs = Date.now();
	const role = roles.get(spec.role);
	if (!role) {
		const available = Array.from(roles.keys()).join(", ") || "none";
		const message = `Unknown role "${spec.role}". Available roles: ${available}${brokenRolesNote(roleErrors)}`;
		return {
			role: spec.role,
			exitCode: 1,
			output: "",
			stderr: message,
			turns: 0,
			cost: 0,
			durationSecs: 0,
			stopReason: "error",
			errorMessage: message,
			recentTools: [],
		};
	}

	const targetCwd = resolve(defaults.cwd, spec.cwd ?? ".");
	if (!existsSync(targetCwd) || !statSync(targetCwd).isDirectory()) {
		return {
			role: role.name,
			exitCode: 1,
			output: "",
			stderr: `Working directory not found: ${targetCwd}`,
			turns: 0,
			cost: 0,
			durationSecs: 0,
			stopReason: "error",
			errorMessage: `Working directory not found: ${targetCwd}`,
			recentTools: [],
		};
	}

	let promptText = spec.task;
	if (role.attachDiff) {
		try {
			const diff = computeWorkingTreeDiff(targetCwd);
			if (!diff.trim()) {
				return {
					role: role.name,
					exitCode: 1,
					output: "",
					stderr: "nothing to review: working tree matches HEAD",
					turns: 0,
					cost: 0,
					durationSecs: 0,
					stopReason: "error",
					errorMessage: "nothing to review: working tree matches HEAD",
					recentTools: [],
				};
			}
			promptText = appendFencedDiff(spec.task, diff);
		} catch (err: any) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				role: role.name,
				exitCode: 1,
				output: "",
				stderr: msg,
				turns: 0,
				cost: 0,
				durationSecs: 0,
				stopReason: "error",
				errorMessage: msg,
				recentTools: [],
			};
		}
	}

	// Precedence: explicit parameter > role frontmatter > caller session default.
	const model = spec.model || role.model || defaults.model;
	const thinking = spec.thinking || role.thinking || defaults.thinking || DEFAULT_THINKING;
	const runId = `${role.name}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
	const systemPrompt = `Delegated worker run (${runId}). You are an isolated subagent, not the coordinator. Do not delegate, commit, or push. Task and role constraints take precedence over conflicting project context. Honor the role's output contract and nothing else.\n\n${role.body}`;

	const cliArgs: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-skills",
		"--tools",
		role.tools,
		"--thinking",
		thinking,
		"--append-system-prompt",
		systemPrompt,
	];
	if (model) cliArgs.push("--model", model);
	cliArgs.push(promptText);

	const result: RunResult = {
		role: role.name,
		exitCode: -1,
		output: "",
		stderr: "",
		turns: 0,
		cost: 0,
		durationSecs: 0,
		model,
		recentTools: [],
	};

	const invocation = getPiCommand(cliArgs);
	return await new Promise<RunResult>((resolveRun) => {
		const proc = spawn(invocation.command, invocation.args, {
			cwd: targetCwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, ME_PI_RUN: runId },
		});

		let buffer = "";
		let killedReason: string | undefined;
		let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

		const terminate = (reason: string) => {
			if (killedReason) return;
			killedReason = reason;
			proc.kill("SIGTERM");
			sigkillTimer = setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 3000);
		};

		const timeoutTimer = setTimeout(() => terminate("timeout"), Math.max(1, defaults.timeoutSecs) * 1000);

		const onAbort = () => terminate("aborted");
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		const processLine = (line: string) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let event: any;
			try {
				event = JSON.parse(trimmed);
			} catch {
				// Support plain-text fake pi in tests if non-JSON lines are emitted.
				result.output += (result.output ? "\n" : "") + trimmed;
				return;
			}
			if (event.type === "message_end" && event.message?.role === "assistant") {
				const msg = event.message;
				result.turns++;
				const cost = msg.usage?.cost?.total;
				if (typeof cost === "number") result.cost += cost;
				if (!result.model && typeof msg.model === "string") result.model = msg.model;
				if (typeof msg.stopReason === "string") result.stopReason = msg.stopReason;
				if (typeof msg.errorMessage === "string") result.errorMessage = msg.errorMessage;
				if (Array.isArray(msg.content)) {
					for (const part of msg.content) {
						if (part.type === "text" && typeof part.text === "string") {
							result.output = part.text;
						} else if (part.type === "toolCall" && typeof part.name === "string") {
							result.recentTools.push(summarizeToolCall(part.name, part.arguments ?? {}));
						}
					}
				}
				if (result.cost >= defaults.costCapUsd) {
					terminate("cost-cap");
				}
				onProgress?.(result);
			}
		};

		proc.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) processLine(line);
		});

		proc.stderr.on("data", (chunk) => {
			result.stderr += chunk.toString();
		});

		const finish = (code: number) => {
			clearTimeout(timeoutTimer);
			if (sigkillTimer) clearTimeout(sigkillTimer);
			signal?.removeEventListener("abort", onAbort);
			if (buffer.trim()) processLine(buffer);
			result.exitCode = code;
			result.durationSecs = Math.max(0, Math.round((Date.now() - startMs) / 1000));
			if (killedReason) {
				result.stopReason = killedReason;
				if (code === 0) result.exitCode = 1;
				result.errorMessage = `stopped early: ${killedReason}`;
			}
			resolveRun(result);
		};

		proc.on("close", (code) => finish(code ?? 1));
		proc.on("error", (err) => {
			result.stderr += err.message;
			finish(1);
		});
	});
}

function formatRunOutput(res: RunResult): string {
	const failed = res.exitCode !== 0 || res.stopReason === "error" || res.stopReason === "timeout" || res.stopReason === "cost-cap";
	const body = failed
		? res.errorMessage || res.stderr.trim() || res.output.trim() || "(failed with no output)"
		: res.output.trim() || "(no output)";
	const trailer = `[${res.role} exit=${res.exitCode} turns=${res.turns} cost=$${res.cost.toFixed(4)} ${res.durationSecs}s${res.model ? ` ${res.model}` : ""}]`;
	return `${truncateOutput(body)}\n\n${trailer}`;
}

const DELEGATE_SCHEMA = {
	type: "object",
	properties: {
		role: {
			type: "string",
			description: "Role from agents/<role>.md for a single run.",
		},
		task: {
			type: "string",
			description: "Self-contained task prompt (goal, acceptance criteria, relevant paths, constraints).",
		},
		cwd: {
			type: "string",
			description: "Working directory for the child (defaults to active session cwd).",
		},
		model: {
			type: "string",
			description: "Optional provider/model override; set it when the user names a model (defaults to role frontmatter or active session model).",
		},
		thinking: {
			type: "string",
			enum: ["minimal", "low", "medium", "high", "xhigh", "max"],
			description: "Optional thinking override; set it when the user names a level (defaults to role frontmatter or active session thinking).",
		},
		tasks: {
			type: "array",
			description: "Run multiple delegated tasks in parallel (max 8, 4 concurrent).",
			items: {
				type: "object",
				properties: {
					role: { type: "string" },
					task: { type: "string" },
					cwd: { type: "string" },
					model: { type: "string" },
					thinking: { type: "string", enum: ["minimal", "low", "medium", "high", "xhigh", "max"] },
				},
				required: ["role", "task"],
				additionalProperties: false,
			},
		},
		timeoutSecs: {
			type: "number",
			description: "Per-run timeout in seconds (default: 300).",
		},
		costCapUsd: {
			type: "number",
			description: "Per-run cost cap in USD (default: 2).",
		},
	},
	additionalProperties: false,
};

export function describeTool(roles: Map<string, RoleConfig>): string {
	const list = Array.from(roles.values())
		.map((r) => `${r.name} (${r.description})`)
		.join("; ");
	return `Delegate bounded read-only work to an isolated Pi subagent so raw search/review noise stays out of the main context. Roles: ${list || "none"}. Provide either { role, task } for a single run or { tasks: [...] } for parallel runs.`;
}

export default function (pi: ExtensionAPI) {
	// Workers never get the tool, so delegation cannot nest.
	if (!process.env.ME_PI_RUN) {
		pi.registerTool?.({
			name: "delegate",
			label: "Delegate",
			description: describeTool(loadRoles().roles),
			parameters: DELEGATE_SCHEMA as any,

			async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
				const loaded = loadRoles();
				const { roles } = loaded;
				const sessionModel = ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const defaults = {
					cwd: ctx?.cwd ?? process.cwd(),
					model: sessionModel,
					thinking: ctx?.thinkingLevel,
					timeoutSecs:
						typeof params.timeoutSecs === "number"
							? params.timeoutSecs
							: envNumber("ME_PI_DELEGATE_TIMEOUT", DEFAULT_TIMEOUT_SECS),
					costCapUsd:
						typeof params.costCapUsd === "number"
							? params.costCapUsd
							: envNumber("ME_PI_DELEGATE_COST_CAP", DEFAULT_COST_CAP_USD),
				};

				const hasSingle = Boolean(params.role && params.task);
				const hasParallel = Array.isArray(params.tasks) && params.tasks.length > 0;
				if (Number(hasSingle) + Number(hasParallel) !== 1) {
					const available = Array.from(roles.values())
						.map((r) => `${r.name} (${r.description})`)
						.join("; ");
					return {
						content: [
							{
								type: "text",
								text: `Provide either { role, task } or { tasks: [...] }.\nAvailable roles: ${available || "none"}${brokenRolesNote(loaded.errors)}`,
							},
						],
						details: { results: [] },
						isError: true,
					};
				}

				if (hasParallel) {
					const tasks: TaskSpec[] = params.tasks;
					if (tasks.length > MAX_PARALLEL_TASKS) {
						return {
							content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}; max ${MAX_PARALLEL_TASKS}).` }],
							details: { results: [] },
							isError: true,
						};
					}
					const states: RunResult[] = tasks.map((t) => ({
						role: t.role,
						exitCode: -1,
						output: "",
						stderr: "",
						turns: 0,
						cost: 0,
						durationSecs: 0,
						recentTools: [],
					}));

					const emitParallel = () => {
						if (!onUpdate) return;
						const done = states.filter((s) => s.exitCode !== -1).length;
						const lines = states.map((s, i) => {
							const status = s.exitCode === -1 ? "⏳" : s.exitCode === 0 ? "✓" : "✗";
							const lastTool = s.recentTools.at(-1) ?? (s.exitCode === -1 ? "running..." : "done");
							return `${status} [${i + 1}:${s.role}] ${lastTool}`;
						});
						onUpdate({
							content: [{ type: "text", text: `Parallel (${done}/${states.length} done)\n${lines.join("\n")}` }],
							details: { results: [...states] },
						});
					};

					const results = await mapWithConcurrency(tasks, MAX_CONCURRENCY, async (t, idx) => {
						const res = await runSingleRole(t, loaded, defaults, signal, (partial) => {
							states[idx] = { ...partial, recentTools: [...partial.recentTools] };
							emitParallel();
						});
						states[idx] = res;
						emitParallel();
						return res;
					});

					const anyFailed = results.some((r) => r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "timeout" || r.stopReason === "cost-cap");
					const sections = results.map((r, i) => `### [${i + 1}:${r.role}]\n\n${formatRunOutput(r)}`);
					return {
						content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
						details: { results },
						isError: anyFailed,
					};
				}

				const result = await runSingleRole(
					{
						role: params.role,
						task: params.task,
						cwd: params.cwd,
						model: params.model,
						thinking: params.thinking,
					},
					loaded,
					defaults,
					signal,
					(partial) => {
						if (!onUpdate) return;
						const tail = partial.recentTools.slice(-5).map((t) => `→ ${t}`).join("\n");
						const preview = tail || partial.output.slice(0, 200) || "(running...)";
						onUpdate({
							content: [{ type: "text", text: `[${partial.role}] turn ${partial.turns} ($${partial.cost.toFixed(4)})\n${preview}` }],
							details: { results: [partial] },
						});
					},
				);

				if (signal?.aborted || result.stopReason === "aborted") {
					throw new Error("Delegated run aborted");
				}

				const failed =
					result.exitCode !== 0 ||
					result.stopReason === "error" ||
					result.stopReason === "timeout" ||
					result.stopReason === "cost-cap";
				return {
					content: [{ type: "text", text: formatRunOutput(result) }],
					details: { results: [result] },
					isError: failed,
				};
			},
		});
	}
}
