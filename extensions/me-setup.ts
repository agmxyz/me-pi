/**
 * me-setup — pre-flight check for the me-pi rig.
 *
 * Usage: /me-setup   (inside a pi session)
 *
 * Read-only. Verifies symlinks, extensions, packages, rtk, auth presence,
 * agents/prompts/skills inventory, role→model overrides, guardrail rules.
 * Never reads secret file contents (auth.json keys/names only).
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url))); // follow symlink → repo
const REPO = resolve(HERE, "..");
const HOME = homedir();
const PI_AGENT = join(HOME, ".pi", "agent");
const AGENTS_HOME = join(HOME, ".agents");

const STOCK_AGENTS = ["scout", "researcher", "worker", "reviewer", "oracle", "delegate"];

type Status = "ok" | "warn" | "fail";
const ICON: Record<Status, string> = { ok: "✓", warn: "⚠", fail: "✗" };

function line(s: Status, label: string, detail = ""): string {
	return `${ICON[s]} ${label}${detail ? ` — ${detail}` : ""}`;
}

function readJson(path: string): any | null {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

function dirField(needle: string): string {
	try {
		const names = readdirSync(needle);
		const md = names.filter((n) => n.endsWith(".md")).map((n) => n.replace(/\.md$/, ""));
		return md.length ? md.join(", ") : "(empty)";
	} catch {
		return "(unreadable)";
	}
}

function say(ctx: any, msg: string): void {
	if (ctx.hasUI || ctx.mode === "tui") ctx.ui.notify(msg, "info");
	else console.log(msg); // print/json modes: notify is invisible
}

function listAgents(): string[] {
	try {
		const dir = join(PI_AGENT, "agents");
		return readdirSync(dir).filter((n) => n.endsWith(".md")).map((n) => {
			const fm = readFileSync(join(dir, n), "utf8").split("---")[1] ?? "";
			return fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() || n.replace(/\.md$/, "");
		});
	} catch {
		return [];
	}
}

function availableModels(): { provider: string; models: string[] }[] {
	const auth = readJson(join(PI_AGENT, "auth.json"));
	const providers: string[] = auth ? Object.keys(auth) : [];
	const store = readJson(join(PI_AGENT, "models-store.json")) ?? {};
	return providers
		.map((p) => ({ provider: p, models: (store[p]?.models ?? []).map((m: any) => m.id).filter(Boolean).slice(0, 40) }))
		.filter((p) => p.models.length > 0);
}

async function assignModel(pi: ExtensionAPI, ctx: any, agent: string, value: string): Promise<void> {
	const settingsPath = join(PI_AGENT, "settings.json");
	const settings = readJson(settingsPath);
	if (!settings) throw new Error("settings.json unreadable");
	settings.subagents = settings.subagents ?? {};
	settings.subagents.agentOverrides = settings.subagents.agentOverrides ?? {};
	if (value === "inherit" || value === "reset") {
		delete settings.subagents.agentOverrides[agent];
	} else {
		// accept "provider/model" or bare model id (keeps current provider preference)
		const [prov, ...rest] = value.split("/");
		const auth = readJson(join(PI_AGENT, "auth.json")) ?? {};
		const looksQualified = rest.length > 0 && auth[prov];
		if (looksQualified) {
			const model = rest.join("/");
			const known = (readJson(join(PI_AGENT, "models-store.json")) ?? {})
				?.[prov]?.models?.some((m: any) => m.id === model);
			if (!known) {
				const avail = (readJson(join(PI_AGENT, "models-store.json")) ?? {})
					?.[prov]?.models?.map((m: any) => m.id).slice(0, 10).join(", ");
				say(ctx, `✗ unknown model "${model}" for provider "${prov}" — not saved. Some options: ${avail}…`);
				return;
			}
			settings.subagents.agentOverrides[agent] = { model, defaultProvider: prov };
		} else {
			settings.subagents.agentOverrides[agent] = { model: value };
		}
	}
	const { writeFileSync } = await import("node:fs");
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
	const eff = settings.subagents.agentOverrides[agent];
	say(ctx, `✓ ${agent} → ${eff ? `${eff.model}${eff.defaultProvider ? ` via ${eff.defaultProvider}` : ""}` : "inherit (session model)"}`, "info");
}

async function modelsSubcommand(rest: string[], pi: ExtensionAPI, ctx: any): Promise<void> {
	const agents = [...new Set([...listAgents(), ...STOCK_AGENTS])];

	// direct form: models <agent> <value>
	if (rest.length >= 2) {
		if (rest[0] === "reset") {
			return await assignModel(pi, ctx, rest[1], "reset");
		}
		return await assignModel(pi, ctx, rest[0], rest[1]);
	}

	// interactive form
	if (!ctx.hasUI && ctx.mode !== "tui") {
		say(ctx, "No UI in this mode. Use: /me-setup models <agent> <provider/model|inherit>", "warn");
		return;
	}
	for (const agent of agents) {
		const pick = await ctx.ui.select(
			`Model for "${agent}" — current override or inherit`,
			["skip (leave as is)", "inherit (session model)", ...availableModels().flatMap((p) => p.models.slice(0, 12).map((m) => `${p.provider}/${m}`))],
		);
		if (!pick || pick.startsWith("skip")) continue;
		const value = pick.startsWith("inherit") ? "inherit" : pick;
		await assignModel(pi, ctx, agent, value);
	}
	say(ctx, "Model assignments saved to settings.json (new sessions pick them up).", "info");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("me-setup", {
		description: "Show what the me-pi rig has wired (read-only pre-flight)",
		handler: async (args: string, ctx: any) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			if (argv[0] === "models") {
				return await modelsSubcommand(argv.slice(1), pi, ctx);
			}
			const out: string[] = [];
			out.push(`rig: ${REPO}`);

			// 1. symlinks
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
					if (!existsSync(p)) {
						out.push(line("fail", label, "missing — run install.sh"));
					} else if (!lstatSync(p).isSymbolicLink()) {
						out.push(line("warn", label, "exists but is NOT a symlink (drift risk)"));
					} else {
						const target = realpathSync(p);
						const ok = target === REPO || target.startsWith(REPO + "/");
						out.push(line(ok ? "ok" : "warn", label, ok ? "" : `→ ${target} (outside repo)`));
					}
				} catch {
					out.push(line("fail", label, "unreadable"));
				}
			}

			// 2. extensions
			try {
				const exts = readdirSync(join(PI_AGENT, "extensions")).filter((n) => n.endsWith(".ts") || n.endsWith(".js"));
				out.push(line("ok", "extensions", exts.join(", ") || "(none)"));
			} catch {
				out.push(line("fail", "extensions", "dir unreadable"));
			}

			// 3. packages
			const settings = readJson(join(PI_AGENT, "settings.json"));
			const pkgs: string[] = settings?.packages ?? [];
			out.push(line(pkgs.length ? "ok" : "warn", "packages", pkgs.join(", ") || "(none installed)"));

			// 4. rtk
			try {
				const v = execFileSync("rtk", ["--version"], { timeout: 2000, encoding: "utf8" }).trim();
				const minor = Number(v.match(/(\d+)\.(\d+)/)?.[2] ?? 0);
				out.push(line(minor >= 23 ? "ok" : "warn", "rtk", `${v}${minor < 23 ? " (too old, need ≥0.23)" : ""}`));
			} catch {
				out.push(line("warn", "rtk", "not in PATH — bash rewriting disabled (brew install rtk)"));
			}

			// 5. auth providers (names only)
			try {
				const auth = readJson(join(PI_AGENT, "auth.json"));
				const provs = auth ? Object.keys(auth) : [];
				out.push(line(provs.length ? "ok" : "fail", "auth", provs.length ? provs.join(", ") : "no providers — run pi auth"));
			} catch {
				out.push(line("fail", "auth", "auth.json unreadable"));
			}

			// 6. agents (+ model overrides)
			const overrides = settings?.subagents?.agentOverrides ?? {};
			try {
				const agentDir = join(PI_AGENT, "agents");
				const names = readdirSync(agentDir).filter((n) => n.endsWith(".md")).map((n) => {
					const fm = readFileSync(join(agentDir, n), "utf8").split("---")[1] ?? "";
					const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
					return name || n.replace(/\.md$/, "");
				});
				const ovr = names.filter((n) => overrides[n]?.model).map((n) => `${n}→${overrides[n].model}`);
				out.push(line(names.length ? "ok" : "warn", "agents", names.join(", ") || "(none)"));
				if (ovr.length) out.push(line("ok", "model overrides", ovr.join(", ")));
				out.push(line("ok", "other agents", "inherit session model (worker/delegate/scout/researcher/delegate)"));
			} catch {
				out.push(line("warn", "agents", "dir unreadable — pi-subagents builtins only"));
			}

			// 7. prompts
			try {
				out.push(line("ok", "prompts", dirField(join(PI_AGENT, "prompts"))));
			} catch {
				out.push(line("warn", "prompts", "dir unreadable"));
			}

			// 8. skills
			try {
				const n = readdirSync(join(AGENTS_HOME, "skills")).length;
				out.push(line(n > 0 ? "ok" : "warn", "skills", `${n} (shared with codex via ~/.agents/skills)`));
			} catch {
				out.push(line("fail", "skills", "~/.agents/skills missing — run install.sh"));
			}

			// 10. guardrails rules
			try {
				const rules = readFileSync(join(HOME, ".pi", "damage-control-rules.yaml"), "utf8");
				const patterns = (rules.match(/pattern:/g) ?? []).length;
				out.push(line(patterns > 0 ? "ok" : "warn", "guardrails", `${patterns} bash deny-patterns`));
			} catch {
				out.push(line("warn", "guardrails", "rules file missing — guardrail extension will notify"));
			}

			// footer: git state of the rig
			try {
				const head = execFileSync("git", ["-C", REPO, "log", "--oneline", "-1"], { encoding: "utf8" }).trim();
				const dirty = execFileSync("git", ["-C", REPO, "status", "--porcelain"], { encoding: "utf8" }).trim();
				out.push(line("ok", "rig git", `${head}${dirty ? "  (uncommitted changes)" : "  (clean)"}`));
			} catch {
				out.push(line("warn", "rig git", "not a git repo?"));
			}

			const report = out.join("\n");
			if (ctx.hasUI || ctx.mode === "tui") {
				ctx.ui.notify(report, "info");
			} else {
				console.log(report); // print/json modes: notify is invisible
			}
		},
	});
}

