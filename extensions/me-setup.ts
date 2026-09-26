/**
 * me-setup — rig control panel.
 *
 * /me-setup            → model chooser: set agent default model+thinking, override agents as needed
 * /me-setup status     → full pre-flight report (read-only)
 * /me-setup default <provider/model> <thinking>   → set default directly
 * /me-setup models <agent> <provider/model> [thinking] → override one agent
 * /me-setup reset <agent> → agent inherits default again
 *
 * Writes only ~/.pi/agent/settings.json subagents.* on explicit user action.
 * Model options come from models-store.json filtered by authed providers.
 * Never reads auth.json values (keys only). Never reads secret contents.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url))); // follows symlink → repo
const REPO = resolve(HERE, "..");
const HOME = homedir();
const PI_AGENT = join(HOME, ".pi", "agent");
const AGENTS_HOME = join(HOME, ".agents");
const THINKING_LEVELS = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

function say(ctx: any, msg: string): void {
	if (ctx.hasUI || ctx.mode === "tui") ctx.ui.notify(msg, "info");
	else console.log(msg); // print/json modes: notify is invisible
}

function readJson(path: string): any | null {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function authedProviders(): string[] {
	const auth = readJson(join(PI_AGENT, "auth.json"));
	return auth ? Object.keys(auth) : [];
}

function modelsFor(provider: string): string[] {
	const store = readJson(join(PI_AGENT, "models-store.json")) ?? {};
	return (store[provider]?.models ?? []).map((m: any) => m.id).filter(Boolean);
}

function listAgents(): string[] {
	try {
		const dir = join(PI_AGENT, "agents");
		return readdirSync(dir)
			.filter((n) => n.endsWith(".md"))
			.map((n) => {
				const fm = readFileSync(join(dir, n), "utf8").split("---")[1] ?? "";
				return fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() || n.replace(/\.md$/, "");
			});
	} catch {
		return [];
	}
}

function loadSettings(): any {
	const s = readJson(join(PI_AGENT, "settings.json"));
	if (!s) throw new Error("settings.json unreadable");
	s.subagents = s.subagents ?? {};
	return s;
}

function saveSettings(settings: any): void {
	writeFileSync(join(PI_AGENT, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
}

async function pickModelAndThinking(
	ctx: any,
	label: string,
	current: string | undefined,
): Promise<{ model?: string; defaultProvider?: string; thinking?: string } | null> {
	// pi-native feel: flat list, `id [provider]` labels, ✓ marks the current value
	const valueByLabel = new Map<string, string>();
	const options: string[] = [];
	for (const p of authedProviders()) {
		for (const m of modelsFor(p).slice(0, 20)) {
			const value = `${p}/${m}`;
			const isCurrent = value === current;
			const label = `${isCurrent ? "✓ " : "  "}${m} [${p}]`;
			valueByLabel.set(label, value);
			options.push(label);
		}
	}
	options.sort((a, b) => (a.startsWith("✓") ? -1 : b.startsWith("✓") ? 1 : a.localeCompare(b)));

	const chosen = await ctx.ui.select(`${label} — model`, options);
	if (!chosen) return null;
	const value = valueByLabel.get(chosen) ?? current;
	if (!value) return null;
	const [prov, ...rest] = value.split("/");

	const currentThinking = current && current.split(":")[1];
	const tOptions = THINKING_LEVELS.map((t) => `${t === currentThinking ? "✓ " : "  "}${t}`);
	const tChosen = await ctx.ui.select(`${label} — thinking level`, tOptions);
	if (tChosen === undefined) return null;
	const thinking = tChosen.replace("✓ ", "").trim();

	return { model: rest.join("/"), defaultProvider: prov, ...(thinking !== "inherit" ? { thinking } : {}) };
}

function describe(eff: any): string {
	if (!eff || (!eff.model && !eff.thinking)) return "inherit";
	const m = eff.model ? (eff.defaultProvider ? `${eff.model} via ${eff.defaultProvider}` : eff.model) : undefined;
	return [m, eff.thinking ? `thinking ${eff.thinking}` : undefined].filter(Boolean).join(", ");
}

async function chooser(pi: ExtensionAPI, ctx: any): Promise<void> {
	const settings = loadSettings();
	const sub = settings.subagents;

	// Step 1 — default (what every agent inherits)
	const keep = `(keep current: ${describe(sub.defaultModel ? { model: sub.defaultModel, defaultProvider: sub.defaultProvider, thinking: sub.defaultThinking } : null)})`;
	const first = await ctx.ui.select("Default model for ALL agents", [keep, "choose another…"]);
	if (!first) return;
	if (first === "choose another…") {
		const pick = await pickModelAndThinking(ctx, "Default", sub.defaultModel ? `${sub.defaultProvider ?? ""}/${sub.defaultModel}` : undefined);
		if (pick) {
			sub.defaultModel = pick.model;
			sub.defaultProvider = pick.defaultProvider;
			if (pick.thinking) sub.defaultThinking = pick.thinking;
			else delete sub.defaultThinking;
		}
	}

	// Step 2 — override only what needs it
	for (;;) {
		const agents = [...new Set([...listAgents(), "worker", "scout", "researcher", "reviewer", "oracle", "delegate"])];
		const options = ["✓ done — save", ...agents.map((a) => `${a}  (${describe(sub.agentOverrides?.[a])})`)];
		const choice = await ctx.ui.select("Override an agent? (others inherit the default)", options);
		if (!choice || choice.startsWith("✓ done")) break;
		const agent = choice.split("  ")[0];
		const current = sub.agentOverrides?.[agent]?.model
			? `${sub.agentOverrides[agent].defaultProvider ?? ""}/${sub.agentOverrides[agent].model}`.replace(/^\//, "")
			: undefined;
		const pick = await pickModelAndThinking(ctx, agent, current);
		if (!pick) continue;
		sub.agentOverrides = sub.agentOverrides ?? {};
		if (pick.model === current) {
			if (pick.thinking) sub.agentOverrides[agent] = { ...sub.agentOverrides[agent], thinking: pick.thinking };
		} else {
			const [prov, ...rest] = pick.model.split("/");
			if (rest.length && authedProviders().includes(prov)) {
				sub.agentOverrides[agent] = { model: rest.join("/"), defaultProvider: prov, ...(pick.thinking ? { thinking: pick.thinking } : {}) };
			} else {
				sub.agentOverrides[agent] = { model: pick.model, ...(pick.thinking ? { thinking: pick.thinking } : {}) };
			}
		}
	}

	saveSettings(settings);

	// Step 3 — result table
	const overrides = sub.agentOverrides ?? {};
	const table = [
		`default: ${describe({ model: sub.defaultModel, defaultProvider: sub.defaultProvider, thinking: sub.defaultThinking })}`,
		...Object.entries(overrides).map(([a, v]) => `${a}: ${describe(v)}`),
	];
	say(ctx, `Saved to settings.json. New sessions pick this up.\n\n${table.join("\n")}`);
}

async function statusReport(ctx: any): Promise<void> {
	const out: string[] = [`rig: ${REPO}`];
	const links: [string, string][] = [
		["extensions", join(PI_AGENT, "extensions")],
		["agents", join(PI_AGENT, "agents")],
		["prompts", join(PI_AGENT, "prompts")],
		["skills", join(AGENTS_HOME, "skills")],
		["APPEND_SYSTEM.md", join(PI_AGENT, "APPEND_SYSTEM.md")],
		["damage-control-rules.yaml", join(HOME, ".pi", "damage-control-rules.yaml")],
	];
	for (const [label, p] of links) {
		try {
			if (!existsSync(p)) out.push(`✗ ${label} — missing — run install.sh`);
			else if (!lstatSync(p).isSymbolicLink()) out.push(`⚠ ${label} — not a symlink (drift risk)`);
			else {
				const t = realpathSync(p);
				out.push(`${t === REPO || t.startsWith(REPO + "/") ? "✓" : "⚠"} ${label}`);
			}
		} catch {
			out.push(`✗ ${label} — unreadable`);
		}
	}
	try {
		out.push(`✓ extensions — ${readdirSync(join(PI_AGENT, "extensions")).filter((n) => n.endsWith(".ts")).join(", ")}`);
	} catch {
		out.push("✗ extensions — unreadable");
	}
	const settings = readJson(join(PI_AGENT, "settings.json"));
	const pkgs: string[] = settings?.packages ?? [];
	out.push(`${pkgs.length ? "✓" : "⚠"} packages — ${pkgs.join(", ") || "(none)"}`);
	try {
		out.push(`✓ rtk — ${execFileSync("rtk", ["--version"], { timeout: 2000, encoding: "utf8" }).trim()}`);
	} catch {
		out.push("⚠ rtk — not in PATH (brew install rtk)");
	}
	try {
		out.push(`✓ auth — ${authedProviders().join(", ")}`);
	} catch {
		out.push("✗ auth — unreadable");
	}
	try {
		out.push(`✓ agents — ${listAgents().join(", ")}`);
		out.push(`✓ prompts — ${readdirSync(join(PI_AGENT, "prompts")).filter((n) => n.endsWith(".md")).map((n) => `/${n.replace(/\.md$/, "")}`).join(", ")}`);
		out.push(`✓ skills — ${readdirSync(join(AGENTS_HOME, "skills")).length} (shared with codex)`);
	} catch {
		out.push("⚠ inventory — unreadable");
	}
	try {
		const rules = readFileSync(join(HOME, ".pi", "damage-control-rules.yaml"), "utf8");
		out.push(`✓ guardrails — ${(rules.match(/pattern:/g) ?? []).length} bash deny-patterns`);
	} catch {
		out.push("⚠ guardrails — rules file missing");
	}
	try {
		const head = execFileSync("git", ["-C", REPO, "log", "--oneline", "-1"], { encoding: "utf8" }).trim();
		const dirty = execFileSync("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf8" }).trim();
		out.push(`✓ rig git — ${head}${dirty ? "  (uncommitted)" : "  (clean)"}`);
	} catch {
		out.push("⚠ rig git — not a repo?");
	}
	say(ctx, out.join("\n"));
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("me-setup", {
		description: "Choose agent models & thinking levels (status: /me-setup status)",
		handler: async (args: string, ctx: any) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			if (argv[0] === "status") return await statusReport(ctx);

			const settings = loadSettings();
			const sub = settings.subagents;

			if (argv[0] === "default") {
				// default <provider/model> [thinking]
				if (!argv[1]) return say(ctx, "usage: /me-setup default <provider/model> [thinking]");
				const [prov, ...rest] = argv[1].split("/");
				if (rest.length && authedProviders().includes(prov)) {
					sub.defaultModel = rest.join("/");
					sub.defaultProvider = prov;
				} else {
					sub.defaultModel = argv[1];
				}
				if (argv[2]) sub.defaultThinking = argv[2];
				saveSettings(settings);
				return say(ctx, `✓ default → ${sub.defaultModel}${sub.defaultProvider ? ` via ${sub.defaultProvider}` : ""}${sub.defaultThinking ? `, thinking ${sub.defaultThinking}` : ""}`);
			}

			if (argv[0] === "models") {
				// models <agent> <provider/model> [thinking]
				if (argv.length < 3) return say(ctx, "usage: /me-setup models <agent> <provider/model> [thinking]");
				const agent = argv[1];
				const [prov, ...rest] = argv[2].split("/");
				let entry: any;
				if (rest.length && authedProviders().includes(prov)) {
					const model = rest.join("/");
					const known = modelsFor(prov).includes(model);
					if (!known) {
						return say(ctx, `✗ unknown model "${model}" for "${prov}" — not saved. Options: ${modelsFor(prov).slice(0, 10).join(", ")}…`);
					}
					entry = { model, defaultProvider: prov };
				} else {
					entry = { model: argv[2] };
				}
				if (argv[3]) entry.thinking = argv[3];
				sub.agentOverrides = sub.agentOverrides ?? {};
				sub.agentOverrides[agent] = entry;
				saveSettings(settings);
				return say(ctx, `✓ ${agent} → ${describe(entry)}`);
			}

			if (argv[0] === "reset") {
				if (!argv[1]) return say(ctx, "usage: /me-setup reset <agent>");
				sub.agentOverrides = sub.agentOverrides ?? {};
				delete sub.agentOverrides[argv[1]];
				saveSettings(settings);
				return say(ctx, `✓ ${argv[1]} → inherit`);
			}

			if (!ctx.hasUI && ctx.mode !== "tui") {
				return say(ctx, "Interactive chooser needs a TUI session. Direct forms:\n  /me-setup default <provider/model> [thinking]\n  /me-setup models <agent> <provider/model> [thinking]\n  /me-setup reset <agent>\n  /me-setup status");
			}
			return await chooser(pi, ctx);
		},
	});
}
