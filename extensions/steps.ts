// Steps: a minimal live checklist below the editor.
// The model sets upcoming steps with the `plan` tool; Pi's tool events add the current action for free.
// Off in delegate workers and non-TUI modes: no tool, no prompt text, no tokens.
// `/steps off` turns it off the same way for every session; the choice lives in <agent dir>/steps.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isWorkerProcess } from "../packages/pi-workers/extensions/delegate-env.ts";

type Plan = { steps: string[]; done: number };
const WIDGET = "steps";

const settingsPath = () => join(getAgentDir(), "steps.json");

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

function describe(tool: string, args: any): string {
	const file = (p: unknown) => (typeof p === "string" ? basename(p) : "");
	switch (tool) {
		case "read":
			return `Reading ${file(args?.path)}`;
		case "edit":
		case "write":
			return `Editing ${file(args?.path)}`;
		case "bash":
			return `Running ${String(args?.command ?? "")
				.trim()
				.split(/\s+/)
				.slice(0, 3)
				.join(" ")}`;
		case "delegate":
			return args?.background ? "Starting background job" : "Delegating";
		case "plan":
			return "";
		default:
			return tool;
	}
}

export default function (pi: ExtensionAPI) {
	if (isWorkerProcess()) return;

	let plan: Plan = { steps: [], done: 0 };
	let activity = "";
	let running = false;
	// The plan shows in full only once the model calls `plan` in the current prompt; a plan from an earlier
	// prompt may be stale or unrelated, so until then only the activity line shows.
	let fresh = false;
	// `/steps off` hides the widget and drops the `plan` tool from the model in every session.
	let enabled = true;
	let ui: ExtensionContext["ui"] | undefined;

	const render = () => {
		if (!ui) return;
		const { steps, done } = plan;
		if (!enabled || (!steps.length && !activity)) return ui.setWidget(WIDGET, undefined);
		ui.setWidget(
			WIDGET,
			(_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					const line = (s: string) => truncateToWidth(s, width, theme.fg("dim", "…"));
					if (!running && steps.length) {
						if (done >= steps.length) return [line(theme.fg("dim", `✓ ${done}/${steps.length} steps`))];
						return [line(theme.fg("dim", `◐ ${done}/${steps.length} · next: ${steps[done]}`))];
					}
					if (!steps.length || !fresh) return [line(theme.fg("dim", activity))];
					return steps.map((step, i) => {
						if (i < done) return line(theme.fg("dim", `✓ ${step}`));
						if (i === done && running) {
							const detail = activity ? theme.fg("dim", ` · ${activity}`) : "";
							return line(`${theme.fg("accent", "●")} ${step}${detail}`);
						}
						return line(theme.fg("dim", `○ ${step}`));
					});
				},
			}),
			{ placement: "belowEditor" },
		);
	};

	// Rebuild from the active branch so resume, /fork and /tree show the right plan.
	const restore = (ctx: ExtensionContext) => {
		plan = { steps: [], done: 0 };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "plan") {
				const details = entry.message.details as Plan | undefined;
				if (details?.steps) plan = details;
			}
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
			name: "plan",
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
				done: Type.Optional(Type.Number()),
			}),
			async execute(_id, params) {
				fresh = true;
				if (params.steps) plan = { steps: params.steps, done: 0 };
				if (params.done !== undefined)
					plan = { ...plan, done: Math.max(0, Math.min(params.done, plan.steps.length)) };
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
				try {
					writeEnabled(enabled);
				} catch (err) {
					ctx.ui.notify(`steps: not saved, so only this session is ${arg} (${(err as Error).message})`, "error");
				}
				// The plan tool exists only in TUI sessions (registered on session_start).
				if (ui) {
					const others = pi.getActiveTools().filter((name) => name !== "plan");
					pi.setActiveTools(enabled ? [...others, "plan"] : others);
				}
				render();
			} else if (arg) return ctx.ui.notify("usage: /steps [on|off]", "warning");
			ctx.ui.notify(`steps ${enabled ? "on" : "off"} (open sessions pick it up on /reload)`, "info");
		},
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
		inFlight.clear();
		activity = "Thinking…";
		render();
	});
	// Tools run in parallel (plan beside bash), so the activity is the latest tool still running, not the last event.
	const inFlight = new Map<string, string>();
	const showInFlight = () => {
		activity = [...inFlight.values()].at(-1) ?? "Thinking…";
		render();
	};
	pi.on("tool_execution_start", (event) => {
		const text = describe(event.toolName, event.args);
		if (!text) return;
		inFlight.set(event.toolCallId, text);
		showInFlight();
	});
	pi.on("tool_execution_end", (event) => {
		inFlight.delete(event.toolCallId);
		showInFlight();
	});
	pi.on("agent_end", (event) => {
		// The model never ticks the last step (the reply completes it), so a run that ends normally with only
		// that step left completes the plan. More steps left means the plan is paused, e.g. on a background job.
		const last = event.messages.findLast((m) => m.role === "assistant");
		const { steps, done } = plan;
		if (fresh && steps.length && done >= steps.length - 1 && last?.role === "assistant" && last.stopReason === "stop")
			plan = { ...plan, done: steps.length };
		running = false;
		activity = "";
		render();
	});
}
