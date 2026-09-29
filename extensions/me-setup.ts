/**
 * me-setup — rig control panel.
 *
 * /me-setup            → interactive model chooser
 * /me-setup status     → full pre-flight report (read-only)
 *
 * Writes only ~/.pi/agent/settings.json subagents.* on explicit user action.
 * Model options come from models-store.json filtered by provider keys in auth.json.
 * Credential values are never displayed, returned, or modified.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, Spacer, Text, fuzzyFilter } from "@earendil-works/pi-tui";

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
		return readdirSync(join(REPO, "agents")).filter((n) => n.endsWith(".md")).map((n) => n.replace(/\.md$/, ""));
	} catch {
		return [];
	}
}

function listLiveAgents(): string[] {
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
	const settingsPath = join(PI_AGENT, "settings.json");
	if (lstatSync(settingsPath).isSymbolicLink()) throw new Error("refusing to write through a symlinked settings.json");
	const liveAgentDir = realpathSync(PI_AGENT); // follows symlinked ancestors too
	if (liveAgentDir === REPO || liveAgentDir.startsWith(REPO + "/")) {
		throw new Error("refusing to write: ~/.pi/agent resolves into the rig repo");
	}
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

// ── native-feel picker (mirrors pi's ModelSelectorComponent) ──

type PickerItem = { value: string; search: string; row: string; badge?: string };
type ModelChoice = { model: string; defaultProvider: string; thinking?: string };

class ModelPicker extends Container {
	private searchInput = new Input();
	private listContainer = new Container();
	private items: PickerItem[] = [];
	private filtered: PickerItem[] = [];
	private selectedIndex = 0;
	private theme: any;
	private keybindings: any;
	private done: (v: string | undefined) => void;
	private title: string;

	constructor(tui: any, theme: any, keybindings: any, title: string, items: PickerItem[], current: string | undefined, done: (v: string | undefined) => void) {
		super();
		this.theme = theme;
		this.keybindings = keybindings;
		this.title = title;
		this.done = done;
		this.items = items;
		this.searchInput.focused = true;
		this.addChild(new Text(theme.fg("accent", title), 0, 0));
		this.addChild(new Text(theme.fg("muted", "  type to filter · ↑/↓ move · enter select · esc cancel"), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		const withCurrent = items.find((i) => i.value === current);
		this.filtered = items;
		this.selectedIndex = withCurrent ? items.indexOf(withCurrent) : 0;
		this.updateList();
	}

	get focused() {
		return this.searchInput.focused;
	}
	set focused(v: boolean) {
		this.searchInput.focused = v;
	}

	private filter(query: string) {
		this.filtered = query ? fuzzyFilter(this.items, query, (i) => i.search) : this.items;
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filtered.length - 1));
		this.updateList();
	}

	private updateList() {
		this.listContainer.clear();
		const maxVisible = 10;
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
		const end = Math.min(start + maxVisible, this.filtered.length);
		for (let i = start; i < end; i++) {
			const item = this.filtered[i];
			const isSelected = i === this.selectedIndex;
			const cursor = isSelected ? this.theme.fg("accent", "→ ") : "  ";
			const id = isSelected ? this.theme.fg("accent", item.row) : item.row;
			const badge = item.badge ? this.theme.fg("muted", ` · ${item.badge}`) : "";
			this.listContainer.addChild(new Text(`${cursor}${id}${badge}`, 0, 0));
		}
		if (start > 0 || end < this.filtered.length) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filtered.length})`), 0, 0));
		}
		if (this.filtered.length === 0) {
			this.listContainer.addChild(new Text(this.theme.fg("muted", "  No matching models"), 0, 0));
		}
	}

	handleInput(data: any) {
		const kb = this.keybindings;
		const up = kb.matches(data, "tui.select.up");
		const down = kb.matches(data, "tui.select.down");
		if (up) {
			if (this.filtered.length) this.selectedIndex = this.selectedIndex === 0 ? this.filtered.length - 1 : this.selectedIndex - 1;
			this.updateList();
		} else if (down) {
			if (this.filtered.length) this.selectedIndex = this.selectedIndex === this.filtered.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		} else if (kb.matches(data, "tui.select.confirm")) {
			const sel = this.filtered[this.selectedIndex];
			if (sel) this.done(sel.value);
			else this.done(undefined);
			return;
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		} else {
			this.searchInput.handleInput(data);
			this.filter(this.searchInput.getValue());
		}
		this.invalidate();
	}
}

function pick(ctx: any, title: string, items: PickerItem[], current?: string): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui: any, theme: any, keybindings: any, done: (v: string | undefined) => void) => {
		return new ModelPicker(tui, theme, keybindings, title, items, current, done);
	});
}

async function pickModelAndThinking(
	ctx: any,
	label: string,
	currentModel?: string,
	currentThinking?: string,
): Promise<ModelChoice | null> {
	// model: flat list across authed providers, pi-native labels, relevance-ordered
	const settings = readJson(join(PI_AGENT, "settings.json")) ?? {};
	const inUse = new Set<string>([
		...(settings.subagents?.defaultModel ? [`${settings.subagents.defaultProvider ?? settings.defaultProvider ?? ""}/${settings.subagents.defaultModel}`.replace(/^\//, "")] : []),
		...Object.values(settings.subagents?.agentOverrides ?? {}).flatMap((o: any) => o?.model ? [`${o.defaultProvider ?? settings.defaultProvider ?? ""}/${o.model}`.replace(/^\//, "")] : []),
	]);
	const provOrder = authedProviders();
	const rank = (p: string) => (p === settings.defaultProvider ? -1 : provOrder.indexOf(p));
	const items: PickerItem[] = [];
	for (const p of authedProviders()) {
		for (const m of modelsFor(p)) {
			const value = `${p}/${m}`;
			const isCurrent = value === currentModel;
			items.push({
				value,
				search: `${m} ${p} ${isCurrent ? "current" : ""}`,
				row: `${m} [${p}]`,
				badge: isCurrent ? "current" : inUse.has(value) ? "in use" : undefined,
			});
		}
	}
	const idx = new Map(items.map((it, i) => [it.value, i]));
	items.sort((a, b) => {
		const badgeRank = (it: PickerItem) => it.badge === "current" ? 0 : it.badge === "in use" ? 1 : 2;
		const ra = badgeRank(a), rb = badgeRank(b);
		if (ra !== rb) return ra - rb;
		const pa = a.value.split("/")[0], pb = b.value.split("/")[0];
		if (rank(pa) !== rank(pb)) return rank(pa) - rank(pb);
		return (idx.get(a.value) ?? 0) - (idx.get(b.value) ?? 0);
	});
	const modelValue = await pick(ctx, `${label} — model`, items, currentModel);
	if (!modelValue) return null;
	const [prov, ...rest] = modelValue.split("/");

	// thinking: same picker over the levels
	const markedThinking = currentThinking && THINKING_LEVELS.includes(currentThinking) ? currentThinking : "inherit";
	const tItems: PickerItem[] = THINKING_LEVELS.map((t) => ({
		value: t,
		search: t,
		row: t,
		badge: t === markedThinking ? "current" : undefined,
	}));
	const thinking = await pick(ctx, `${label} — thinking level`, tItems, markedThinking);
	if (thinking === undefined) return null;

	return { model: rest.join("/"), defaultProvider: prov, ...(thinking !== "inherit" ? { thinking } : {}) };
}

function describe(eff: any, inheritedProvider?: string, inheritLabel = "default"): string {
	if (!eff || (!eff.model && !eff.thinking)) return `inherit ${inheritLabel}`;
	const provider = eff.defaultProvider === false ? undefined : eff.defaultProvider ?? inheritedProvider;
	const providerLabel = eff.defaultProvider === false ? " (provider preference cleared)" : provider ? ` via ${provider}` : "";
	const model = eff.model ? `${eff.model}${providerLabel}` : `model inherits ${inheritLabel}`;
	const thinking = eff.thinking ? `thinking ${eff.thinking}` : `thinking inherits ${inheritLabel}`;
	return `${model}, ${thinking}`;
}

export function applyAgentPick(existing: Record<string, any> | undefined, pick: ModelChoice): Record<string, any> {
	const next = { ...(existing ?? {}), model: pick.model, defaultProvider: pick.defaultProvider };
	if (pick.thinking !== undefined) next.thinking = pick.thinking;
	else delete next.thinking;
	return next;
}

async function chooser(pi: ExtensionAPI, ctx: any): Promise<void> {
	const settings = loadSettings();
	const sub = settings.subagents;
	let changed = false;

	// Step 1 — default (what every agent inherits)
	const keep = `(keep current: ${describe({ model: sub.defaultModel, defaultProvider: sub.defaultProvider, thinking: sub.defaultThinking }, undefined, "parent session")})`;
	const first = await ctx.ui.select("Default model for ALL agents", [keep, "choose another…"]);
	if (!first) return;
	if (first === "choose another…") {
		const provider = sub.defaultProvider ?? ctx.model?.provider ?? settings.defaultProvider ?? "";
		const cur = sub.defaultModel ? `${provider}/${sub.defaultModel}` : undefined;
		const pick = await pickModelAndThinking(ctx, "Default", cur, sub.defaultThinking);
		if (pick) {
			const before = JSON.stringify({ model: sub.defaultModel, provider: sub.defaultProvider, thinking: sub.defaultThinking });
			sub.defaultModel = pick.model;
			sub.defaultProvider = pick.defaultProvider;
			if (pick.thinking) sub.defaultThinking = pick.thinking;
			else delete sub.defaultThinking;
			const after = JSON.stringify({ model: sub.defaultModel, provider: sub.defaultProvider, thinking: sub.defaultThinking });
			changed ||= before !== after;
		}
	}

	// Step 2 — override only what needs it
	const agents = listAgents();
	for (;;) {
		const options = ["✓ done — save", ...agents.map((a) => `${a}  (${describe(sub.agentOverrides?.[a], sub.defaultProvider)})`)];
		const choice = await ctx.ui.select("Override an agent? (others inherit the default)", options);
		if (!choice || choice.startsWith("✓ done")) break;
		const agent = choice.split("  ")[0];
		const override = sub.agentOverrides?.[agent];
		const provider = sub.defaultProvider ?? ctx.model?.provider ?? settings.defaultProvider ?? "";
		const currentProvider = override?.defaultProvider === false ? "" : override?.defaultProvider ?? provider;
		const current = override?.model ? `${currentProvider}/${override.model}`.replace(/^\//, "") : undefined;
		const pick = await pickModelAndThinking(ctx, agent, current, override?.thinking);
		if (!pick) continue;
		const next = applyAgentPick(override, pick);
		if (JSON.stringify(override) !== JSON.stringify(next)) {
			sub.agentOverrides = sub.agentOverrides ?? {};
			sub.agentOverrides[agent] = next;
			changed = true;
		}
	}

	// Remove overrides for roles no longer present in this repo. Role
	// frontmatter deliberately wins over subagents.defaultThinking.
	const validAgents = new Set(agents);
	if (sub.agentOverrides && typeof sub.agentOverrides === "object" && !Array.isArray(sub.agentOverrides)) {
		for (const agent of Object.keys(sub.agentOverrides)) {
			if (!validAgents.has(agent)) {
				delete sub.agentOverrides[agent];
				changed = true;
			}
		}
	} else if (sub.agentOverrides !== undefined) {
		sub.agentOverrides = {};
		changed = true;
	}
	if (changed) saveSettings(settings);

	// Step 3 — result table
	const overrides = Object.entries(sub.agentOverrides ?? {});
	const table = [
		`default (inherited by agents without overrides): ${describe({ model: sub.defaultModel, defaultProvider: sub.defaultProvider, thinking: sub.defaultThinking }, undefined, "parent session")}`,
		"overrides:",
		...(overrides.length ? overrides.map(([a, v]) => `${a}: ${describe(v, sub.defaultProvider)}`) : ["(none)"]),
	];
	say(ctx, `${changed ? "Saved to ~/.pi/agent/settings.json" : "No changes; settings unchanged"} · applies to new sessions; current session unchanged.\n\n${table.join("\n")}`);
}

function linkedEntryReport(sourceDir: string, liveDir: string, include: (name: string, isDirectory: boolean) => boolean): { linked: number; expected: number; unlinked: string[] } {
	let linked = 0;
	let expected = 0;
	const unlinked: string[] = [];
	try {
		for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
			if (!include(entry.name, entry.isDirectory())) continue;
			expected++;
			const livePath = join(liveDir, entry.name);
			try {
				if (lstatSync(livePath).isSymbolicLink() && realpathSync(livePath) === realpathSync(join(sourceDir, entry.name))) linked++;
				else unlinked.push(entry.name);
			} catch {
				unlinked.push(entry.name);
			}
		}
	} catch {
		// A missing source directory yields zero links; the status line will warn.
	}
	return { linked, expected, unlinked };
}

function isLocalExtensionPackage(entry: any): boolean {
	const source = typeof entry === "string" ? entry : entry?.source;
	if (typeof source !== "string") return false;
	try {
		const path = source.startsWith("file://")
			? fileURLToPath(source)
			: source.startsWith("~")
				? join(HOME, source.slice(1))
				: source.startsWith("/")
					? source
					: resolve(PI_AGENT, source);
		return realpathSync(path) === realpathSync(join(REPO, "extensions"));
	} catch {
		return false;
	}
}

async function statusReport(ctx: any): Promise<void> {
	const out: string[] = [`rig: ${REPO}`];
	const liveExtensions = join(PI_AGENT, "extensions");
	try {
		if (!existsSync(liveExtensions)) out.push("✗ live extensions — missing — run install.sh");
		else {
			const target = realpathSync(liveExtensions);
			const pointsIntoRepo = target === REPO || target.startsWith(REPO + "/");
			out.push(`${pointsIntoRepo ? "⚠" : "✓"} live extensions dir — ${pointsIntoRepo ? "points into rig; external installers can write to repo" : target}`);
			out.push(`✓ live extensions — ${readdirSync(liveExtensions).filter((n) => n.endsWith(".ts")).join(", ") || "(none)"}`);
		}
	} catch {
		out.push("✗ live extensions — unreadable");
	}

	const settings = readJson(join(PI_AGENT, "settings.json"));
	const packages = Array.isArray(settings?.packages) ? settings.packages : [];
	out.push(`${packages.some(isLocalExtensionPackage) ? "✓" : "⚠"} me-pi extension package — ${packages.some(isLocalExtensionPackage) ? "registered" : "missing — run install.sh"}`);
	const packageNames = packages.map((entry: any) => typeof entry === "string" ? entry : entry?.source ?? "(unknown)");
	out.push(`${packages.length ? "✓" : "⚠"} Pi packages — ${packageNames.join(", ") || "(none)"}`);
	const subagents = settings?.subagents ?? {};
	const overrides = Object.entries(subagents.agentOverrides ?? {});
	const agentModels = [
		`default: ${describe({ model: subagents.defaultModel, defaultProvider: subagents.defaultProvider, thinking: subagents.defaultThinking }, settings?.defaultProvider, "parent session")}`,
		...overrides.map(([agent, value]) => `${agent}: ${describe(value, subagents.defaultProvider)}`),
	];
	out.push(`✓ agent models — ${agentModels.join("; ")}`);
	out.push(`${existsSync(join(liveExtensions, "rtk.ts")) ? "✓" : "⚠"} RTK extension — ${existsSync(join(liveExtensions, "rtk.ts")) ? "installed" : "missing — run rtk init --global --agent pi"}`);
	out.push(`${existsSync(join(liveExtensions, "interactive-shell.ts")) ? "✓" : "⚠"} interactive shell — ${existsSync(join(liveExtensions, "interactive-shell.ts")) ? "installed" : "missing"}`);

	const agentLinks = linkedEntryReport(join(REPO, "agents"), join(PI_AGENT, "agents"), (name, isDirectory) => !isDirectory && name.endsWith(".md"));
	out.push(`${agentLinks.unlinked.length === 0 ? "✓" : "⚠"} repo agent links — ${agentLinks.linked}/${agentLinks.expected}${agentLinks.unlinked.length ? ` (unlinked: ${agentLinks.unlinked.join(", ")})` : ""}`);
	const skillLinks = linkedEntryReport(join(REPO, "skills"), join(AGENTS_HOME, "skills"), (_name, isDirectory) => isDirectory);
	out.push(`${skillLinks.unlinked.length === 0 ? "✓" : "⚠"} repo skill links — ${skillLinks.linked}/${skillLinks.expected}${skillLinks.unlinked.length ? ` (unlinked: ${skillLinks.unlinked.join(", ")})` : ""} (shared with Codex)`);
	const appendSystem = join(PI_AGENT, "APPEND_SYSTEM.md");
	try {
		out.push(`${existsSync(appendSystem) && lstatSync(appendSystem).isSymbolicLink() && realpathSync(appendSystem) === realpathSync(join(REPO, "APPEND_SYSTEM.md")) ? "✓" : "⚠"} APPEND_SYSTEM.md link`);
	} catch {
		out.push("✗ APPEND_SYSTEM.md — missing or unreadable");
	}
	try {
		out.push(`✓ agents — ${listLiveAgents().join(", ")}`);
	} catch {
		out.push("⚠ agents — unreadable");
	}
	try {
		out.push(`✓ rtk — ${execFileSync("rtk", ["--version"], { timeout: 2000, encoding: "utf8" }).trim()}`);
	} catch {
		out.push("⚠ rtk — not in PATH (brew install rtk)");
	}
	try {
		const providers = authedProviders();
		out.push(`${providers.length ? "✓" : "⚠"} auth — ${providers.join(", ") || "no provider keys in ~/.pi/agent/auth.json"}`);
	} catch {
		out.push("✗ auth — unreadable");
	}
	try {
		out.push(`✓ skills — ${readdirSync(join(AGENTS_HOME, "skills")).length} (shared with Codex)`);
	} catch {
		out.push("⚠ skills — unreadable");
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
			const usage = "usage: /me-setup\n       /me-setup status";
			if (argv.length > 0) {
				if (argv.length === 1 && argv[0] === "status") return await statusReport(ctx);
				return say(ctx, usage);
			}
			if (!ctx.hasUI && ctx.mode !== "tui") return say(ctx, `Interactive chooser needs a TUI session.\n${usage}`);
			return await chooser(pi, ctx);
		},
	});
}
