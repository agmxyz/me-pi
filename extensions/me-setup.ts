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

export default function (pi: ExtensionAPI) {
	pi.registerCommand("me-setup", {
		description: "Show what the me-pi rig has wired (read-only pre-flight)",
		handler: async (_args: string, ctx: any) => {
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

