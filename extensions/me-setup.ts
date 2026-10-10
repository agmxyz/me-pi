/**
 * me-setup — rig status and worker commit guard.
 *
 * /me-setup, /me-setup status → pre-flight report (read-only)
 * bash `git commit`           → blocked for delegate workers; main sessions have no review gate
 *
 * Read-only: writes nothing. Credential values are never displayed, returned, or modified.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url))); // follows symlink → repo
const REPO = resolve(HERE, "..");
const HOME = homedir();
const PI_AGENT = join(HOME, ".pi", "agent");
const AGENTS_HOME = join(HOME, ".agents");

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

function listRoles(): string[] {
	try {
		return readdirSync(join(REPO, "agents")).filter((n) => n.endsWith(".md")).map((n) => n.replace(/\.md$/, ""));
	} catch {
		return [];
	}
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

function isSymlinkTo(linkPath: string, sourcePath: string): boolean {
	try {
		return lstatSync(linkPath).isSymbolicLink() && realpathSync(linkPath) === realpathSync(sourcePath);
	} catch {
		return false;
	}
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
	out.push(`${existsSync(join(liveExtensions, "rtk.ts")) ? "✓" : "⚠"} RTK extension — ${existsSync(join(liveExtensions, "rtk.ts")) ? "installed" : "missing — run rtk init --global --agent pi"}`);
	out.push(`${existsSync(join(liveExtensions, "interactive-shell.ts")) ? "✓" : "⚠"} interactive shell — ${existsSync(join(liveExtensions, "interactive-shell.ts")) ? "installed" : "missing"}`);

	const skillLinks = linkedEntryReport(join(REPO, "skills"), join(AGENTS_HOME, "skills"), (_name, isDirectory) => isDirectory);
	out.push(`${skillLinks.unlinked.length === 0 ? "✓" : "⚠"} repo skill links — ${skillLinks.linked}/${skillLinks.expected}${skillLinks.unlinked.length ? ` (unlinked: ${skillLinks.unlinked.join(", ")})` : ""} (shared with Codex)`);
	const policyLinks: [string, string, string][] = [
		["~/.pi/agent/AGENTS.md", join(PI_AGENT, "AGENTS.md"), join(REPO, "GLOBAL_AGENTS.md")],
		["~/.agents/CODING_STANDARDS.md", join(AGENTS_HOME, "CODING_STANDARDS.md"), join(REPO, "CODING_STANDARDS.md")],
	];
	for (const [label, linkPath, sourcePath] of policyLinks) {
		const linked = isSymlinkTo(linkPath, sourcePath);
		out.push(`${linked ? "✓" : "⚠"} ${label} link${linked ? "" : " — missing or incorrect — run install.sh"}`);
	}
	out.push(`✓ roles — ${listRoles().join(", ")}`);
	try {
		out.push(`✓ rtk — ${execFileSync("rtk", ["--version"], { timeout: 2000, encoding: "utf8" }).trim()}`);
	} catch {
		out.push("⚠ rtk — not in PATH (brew install rtk)");
	}
	const providers = authedProviders();
	out.push(`${providers.length ? "✓" : "⚠"} auth — ${providers.join(", ") || "no provider keys in ~/.pi/agent/auth.json"}`);
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

// ── worker commit guard ──

// Textual match on the bash tool's command: `git [-C <path> | -c <k=v> | -flag]... commit`
// anywhere in it, so `rtk git commit`, `a && git commit`, and `sh -c "git commit"` are caught.
// Worker-only limitations: git aliases (`git ci`), option values given as separate words other
// than -C/-c (`git --git-dir x commit`), and commands assembled at runtime (eval, scripts,
// variables) are not detected. Mere mentions (`grep 'git commit'`, a heredoc task text)
// do match and block.
const GIT_COMMIT_RE = /(?<![\w.-])git(?:\s+(?:-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S*)?))*\s+commit(?![\w-])/;

export default function (pi: ExtensionAPI) {
	// Delegate workers leave commits for the coordinator; main sessions have no review gate.
	// A blocked tool_call stops execution (Pi's fail-safe).
	pi.on?.("tool_call", (event) => {
		if (!process.env.ME_PI_RUN || event.toolName !== "bash") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || !GIT_COMMIT_RE.test(command)) return;
		return {
			block: true,
			reason: `me-setup worker commit guard: delegate workers never commit (run ${process.env.ME_PI_RUN}). Leave changes uncommitted and report them in your output.`,
		};
	});

	pi.registerCommand("me-setup", {
		description: "Rig status report (also: /me-setup status)",
		handler: async (args: string, ctx: any) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			if (argv.length === 0 || (argv.length === 1 && argv[0] === "status")) return await statusReport(ctx);
			return say(ctx, "usage: /me-setup\n       /me-setup status");
		},
	});
}
