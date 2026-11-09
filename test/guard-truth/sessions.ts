/**
 * guard on your real Pi sessions (local only; macOS for the bash-truth part): reads every `bash` tool call in
 * `~/.pi/agent/sessions/**\/*.jsonl` (nothing else: never auth or credential files), judges each main-session command
 * with guard 0.1.3's regex `classify` and with the policy on the live disk, and runs every command 0.1.3 asked about
 * that the policy allows through bash-truth to confirm it safe. `npm run guard-sessions`.
 *
 * Privacy: prints totals only. Per-command results go to a fresh 0700 dir under /tmp with 0600 files, never to the
 * repo; commit or paste none of it. The disk is read *now*: repos moved or deleted since a session ran read as
 * "not a repo", which asks.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, relative } from "node:path";
import {
	branchOf,
	isCheckoutRef,
	pushUrlsOf,
	remoteUrlOf,
	repoRootOf,
	urlRewritesOf,
} from "../../packages/pi-workers/extensions/guard-disk.ts";
import {
	argvPolicy,
	type PolicyEnv,
	type PolicyVerdict,
	policy,
} from "../../packages/pi-workers/extensions/guard-policy.ts";
import { classify } from "../../packages/pi-workers/extensions/guard-regex.ts";
import { initShell } from "../../packages/pi-workers/extensions/guard-shell.ts";
import { prepare, STUB_HOME, truth } from "./bash-truth.ts";

const BRANCHES = ["feature/x", "main"] as const;
const root = join(homedir(), ".pi/agent/sessions");
const out = mkdtempSync("/tmp/guard-sessions-");
mkdirSync(out, { recursive: true, mode: 0o700 });

function* jsonlFiles(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) yield* jsonlFiles(p);
		else if (name.endsWith(".jsonl")) yield p;
	}
}
/** Every `{type: "toolCall", name: "bash", arguments: {command}}` in a record, with its call id. */
function* bashCalls(v: unknown): Generator<[string, string | undefined]> {
	if (Array.isArray(v)) for (const x of v) yield* bashCalls(x);
	else if (v && typeof v === "object") {
		const o = v as Record<string, unknown>;
		const args = o.arguments as Record<string, unknown> | undefined;
		if (o.type === "toolCall" && o.name === "bash" && typeof args?.command === "string")
			yield [args.command, typeof o.id === "string" ? o.id : undefined];
		else for (const x of Object.values(o)) yield* bashCalls(x);
	}
}

// Main-session commands (not delegate workers or subagents), deduped by text; the cwd of their first run.
const commands = new Map<string, { cwd: string; count: number }>();
let total = 0;
const seen = new Set<string>();
for (const file of jsonlFiles(root)) {
	if (/(?:^|\/)run-\d+\/session\.jsonl$|subagent-artifacts\//.test(relative(root, file))) continue;
	let cwd = "";
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let rec: Record<string, unknown>;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof rec.cwd === "string") cwd = rec.cwd;
		for (const [command, id] of bashCalls(rec)) {
			if (id !== undefined) {
				if (seen.has(`${id}\0${command}`)) continue;
				seen.add(`${id}\0${command}`);
			}
			total++;
			const e = commands.get(command) ?? { cwd, count: 0 };
			e.count++;
			commands.set(command, e);
		}
	}
}

await initShell();
const live = (cwd: string, branch: string): PolicyEnv => ({
	cwd,
	home: homedir(),
	branch: () => branch,
	branchOf,
	repoRootOf,
	remoteUrlOf,
	pushUrlsOf,
	urlRewritesOf,
	isCheckoutRef,
});
interface Result {
	command: string;
	cwd: string;
	old: Record<string, string | null>;
	neu: Record<string, PolicyVerdict>;
	confirm?: string;
}
const results: Result[] = [];
for (const [command, { cwd }] of commands) {
	if (!cwd) continue;
	results.push({
		command,
		cwd,
		old: Object.fromEntries(BRANCHES.map((b) => [b, classify(command, () => b) ?? null])),
		neu: Object.fromEntries(BRANCHES.map((b) => [b, policy(command, live(cwd, b))])),
	});
}

// Every 0.1.3 prompt the policy allows on both branches, and every command allowed through the parse-failure
// fallback, runs in bash-truth; the same rules over what rm/git received (sandbox paths mapped back to disk) must allow.
const toConfirm = results.filter(
	(r) =>
		BRANCHES.every((b) => r.neu[b].verdict === "allow") &&
		(BRANCHES.some((b) => r.old[b] !== null) || BRANCHES.some((b) => r.neu[b].fallbacks.length > 0)),
);
const strip = (p: string) => p.replace(/^\/private(?=\/(?:var|tmp)\/)/, "");
if (process.platform === "darwin") {
	const run = prepare(toConfirm.map((r) => r.command));
	try {
		let next = 0;
		await Promise.all(
			Array.from({ length: 8 }, async () => {
				while (next < toConfirm.length) {
					const r = toConfirm[next++];
					const t = await truth(run, r.command);
					const start = strip(t.startDir);
					const toDisk = (p: string) => {
						const n = strip(posix.normalize(p));
						if (n === start || n.startsWith(`${start}/`)) return r.cwd + n.slice(start.length);
						if (n === STUB_HOME || n.startsWith(`${STUB_HOME}/`)) return homedir() + n.slice(STUB_HOME.length);
						return n;
					};
					const worst = BRANCHES.map((b) => argvPolicy(t.calls, live(r.cwd, b), toDisk).verdict)
						.sort()
						.at(-1);
					r.confirm = worst;
				}
			}),
		);
	} finally {
		rmSync(run.dir, { recursive: true, force: true });
	}
}

const count = (f: (r: Result) => boolean) => results.filter(f).length;
const summary = {
	sessionsRoot: root,
	mainCommands: { unique: results.length, total },
	byBranch: Object.fromEntries(
		BRANCHES.map((b) => [
			b,
			{
				old: count((r) => r.old[b] !== null),
				ask: count((r) => r.neu[b].verdict === "ask"),
				askIfDirty: count((r) => r.neu[b].verdict === "ask-if-dirty"),
				newOnly: count((r) => r.old[b] === null && r.neu[b].verdict !== "allow"),
				fallbacks: count((r) => r.neu[b].fallbacks.length > 0),
			},
		]),
	),
	confirm:
		process.platform === "darwin"
			? {
					ran: toConfirm.length,
					failures: toConfirm.filter((r) => r.confirm !== "allow").length,
					fallbackAllowed: toConfirm.filter((r) => BRANCHES.some((b) => r.neu[b].fallbacks.length > 0)).length,
				}
			: "skipped (bash-truth needs macOS)",
	details: join(out, "results.json"),
};
writeFileSync(join(out, "results.json"), JSON.stringify(results), { mode: 0o600 });
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
console.log(JSON.stringify(summary, null, 2));
process.exitCode = typeof summary.confirm === "object" && summary.confirm.failures ? 1 : 0;
