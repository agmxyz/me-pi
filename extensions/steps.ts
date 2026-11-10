// Steps: a minimal live checklist below the editor.
// The model sets upcoming steps with the `plan` tool; the current step shows how long it has run.
// Pi's tool blocks already show what is running, so without a plan this prompt shows nothing.
// Off outside the TUI, including delegate workers (JSON mode): no tool, no prompt text, no tokens.
// `/steps off` turns it off the same way for every session; the choice lives in <agent dir>/steps.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Plan = { steps: string[]; done: number };
const WIDGET = "steps";
const TOOL = "plan";

const settingsPath = () => join(getAgentDir(), "steps.json");

/** A plan read back from session history, or undefined when the entry is not one; done is clamped to the steps. */
function parsePlan(value: unknown): Plan | undefined {
	const { steps, done } = (value ?? {}) as Partial<Plan>;
	if (!Array.isArray(steps) || !steps.every((step) => typeof step === "string")) return undefined;
	const count = Number.isInteger(done) ? (done as number) : 0;
	return { steps, done: Math.max(0, Math.min(count, steps.length)) };
}

/** The saved on/off choice: on when no choice was saved; an unreadable file is reported and treated as on. */
function readEnabled(): { enabled: boolean; error?: string } {
	let text: string;
	try {
		text = readFileSync(settingsPath(), "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { enabled: true };
		return { enabled: true, error: (err as Error).message };
	}
	try {
		const { enabled } = JSON.parse(text);
		if (typeof enabled === "boolean") return { enabled };
		return { enabled: true, error: `${settingsPath()}: "enabled" is not true or false` };
	} catch (err) {
		return { enabled: true, error: `${settingsPath()}: ${(err as Error).message}` };
	}
}

function writeEnabled(enabled: boolean) {
	mkdirSync(getAgentDir(), { recursive: true });
	writeFileSync(settingsPath(), `${JSON.stringify({ enabled })}\n`);
}

const elapsed = (ms: number) => {
	const seconds = Math.floor(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

export default function (pi: ExtensionAPI) {
	let plan: Plan = { steps: [], done: 0 };
	let running = false;
	// The widget shows only a plan the model touched in the current or last prompt. A plan from an earlier
	// prompt may be finished, stale, or unrelated, and the widget can't tell which, so it stays hidden.
	let fresh = false;
	// When the current step started, for its timer; reset when the step changes or a prompt picks the plan up.
	let stepStartedAt = Date.now();
	let tick: NodeJS.Timeout | undefined;
	const stopTick = () => {
		clearInterval(tick);
		tick = undefined;
	};
	// `/steps off` hides the widget and drops the `plan` tool from the model in every session.
	let enabled = true;
	let ui: ExtensionContext["ui"] | undefined;

	const render = () => {
		if (!ui) return;
		const { steps, done } = plan;
		stopTick();
		if (!enabled || !steps.length || !fresh) return ui.setWidget(WIDGET, undefined);
		ui.setWidget(
			WIDGET,
			(tui, theme) => {
				if (running) {
					tick = setInterval(() => tui.requestRender(), 1000);
					tick.unref();
				}
				return {
					dispose: stopTick,
					invalidate() {},
					render(width: number): string[] {
						const line = (s: string) => truncateToWidth(s, width, theme.fg("dim", "…"));
						if (!running) {
							if (done >= steps.length) return [line(theme.fg("dim", `✓ ${done}/${steps.length} steps`))];
							return [line(theme.fg("dim", `◐ ${done}/${steps.length} · next: ${steps[done]}`))];
						}
						return steps.map((step, i) => {
							if (i < done) return line(theme.fg("dim", `✓ ${step}`));
							if (i === done) {
								const timer = theme.fg("dim", ` · ${elapsed(Date.now() - stepStartedAt)}`);
								return line(`${theme.fg("accent", "●")} ${step}${timer}`);
							}
							return line(theme.fg("dim", `○ ${step}`));
						});
					},
				};
			},
			{ placement: "belowEditor" },
		);
	};

	// Rebuild from the active branch's latest `plan` result, so after resume, /fork or /tree the model can pick
	// the plan up with `done` alone. It stays hidden until the model does.
	const restore = (ctx: ExtensionContext) => {
		plan = { steps: [], done: 0 };
		fresh = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== TOOL)
				continue;
			plan = parsePlan(entry.message.details) ?? plan;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ui = ctx.ui;
		const saved = readEnabled();
		enabled = saved.enabled;
		if (saved.error)
			ctx.ui.notify(`steps: could not read the on/off setting, so steps stay on (${saved.error})`, "warning");
		restore(ctx);
		pi.registerTool({
			name: TOOL,
			defaultActive: enabled,
			label: "Plan",
			description: "Live checklist for the user. `steps` sets the list; `done` is the count of finished steps.",
			promptGuidelines: [
				"For tasks with 3+ steps, call plan only in parallel with another tool call, never alone: set steps (each under 40 characters) with the first action, then update done whenever you start a new step. Never tick the last step; the reply completes it.",
				"An earlier prompt's plan stays hidden until you call plan again: set new steps for new work, or update done to resume it. Skip plan for prompts unrelated to it.",
				"When the work stops matching the plan (a step dropped, changed, or added), call plan with the corrected steps and done; never leave a step the user would read as false.",
			],
			parameters: Type.Object({
				steps: Type.Optional(Type.Array(Type.String())),
				done: Type.Optional(Type.Integer({ minimum: 0 })),
			}),
			async execute(_id, params) {
				const before = plan.done;
				const pickedUp = !fresh;
				fresh = true;
				if (params.steps) plan = { steps: params.steps, done: 0 };
				if (params.done !== undefined)
					plan = { ...plan, done: Math.max(0, Math.min(params.done, plan.steps.length)) };
				if (pickedUp || params.steps || plan.done !== before) stepStartedAt = Date.now();
				render();
				return { content: [{ type: "text", text: "ok" }], details: plan };
			},
			renderCall(args, theme) {
				const parts = [
					...(args.steps ? [`${args.steps.length} steps`] : []),
					...(args.done !== undefined ? [`${args.done} done`] : []),
				];
				const text = `plan · ${parts.join(" · ") || "…"}`;
				return new Text(theme.fg("dim", text), 0, 0);
			},
			renderResult() {
				return new Text("", 0, 0);
			},
		});
	});

	pi.registerCommand("steps", {
		description: "Steps checklist: /steps on | off (all sessions; default on)",
		getArgumentCompletions: (prefix) =>
			["on", "off"].filter((s) => s.startsWith(prefix.trim())).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				let saveError: string | undefined;
				try {
					writeEnabled(enabled);
				} catch (err) {
					saveError = (err as Error).message;
				}
				// The plan tool exists only in TUI sessions (registered on session_start).
				if (ui) {
					const others = pi.getActiveTools().filter((name) => name !== TOOL);
					pi.setActiveTools(enabled ? [...others, TOOL] : others);
				}
				render();
				if (saveError)
					return ctx.ui.notify(`steps ${arg} for this session only: not saved (${saveError})`, "error");
			} else if (arg) return ctx.ui.notify("usage: /steps [on|off]", "warning");
			ctx.ui.notify(`steps ${enabled ? "on" : "off"} (open sessions pick it up on /reload)`, "info");
		},
	});

	pi.on("session_shutdown", () => {
		stopTick();
		ui = undefined;
	});

	pi.on("session_tree", (_event, ctx) => {
		restore(ctx);
		render();
	});

	// A new prompt (user input or a background job's report) hides the plan until the model touches it;
	// agent_start also fires for retries and queued messages within the same prompt.
	pi.on("before_agent_start", () => {
		fresh = false;
	});
	pi.on("agent_start", () => {
		// A finished plan from the previous prompt clears; an unfinished one carries on.
		if (plan.steps.length && plan.done >= plan.steps.length) plan = { steps: [], done: 0 };
		running = true;
		render();
	});
	pi.on("agent_end", (event) => {
		// The model never ticks the last step (the reply completes it), so a run that ends normally with only
		// that step left completes the plan. More steps left means the plan is paused, e.g. on a background job.
		const last = event.messages.findLast((m) => m.role === "assistant");
		const { steps, done } = plan;
		if (fresh && steps.length && done >= steps.length - 1 && last?.role === "assistant" && last.stopReason === "stop")
			plan = { ...plan, done: steps.length };
		running = false;
		render();
	});
}
