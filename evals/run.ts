/**
 * Manual routing evals: each attempt is a natural request in a fresh, isolated Pi, scored from its session log.
 * Real model calls and real spend; never part of `npm run check`. See evals/README.md.
 */
import { execFile as execFileCb, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { cloneAt, createSandbox, fixtureRepo, type Policy, type Sandbox } from "./sandbox.ts";
import { type Assertion, check, parseSession, type Verdict } from "./score.ts";

const execFile = promisify(execFileCb);
const HERE = dirname(new URL(import.meta.url).pathname);
const PI_LIVE = join(HERE, "..", ".agents", "skills", "pi-live-test", "pi-live.sh");

interface Scenario {
	id: string;
	optIn?: string;
	cwd: "repo" | string;
	turns: { prompt: string; afterSeconds?: number }[];
	expect: Assertion[];
}

const { values: opt } = parseArgs({
	options: {
		scenarios: { type: "string", default: join(HERE, "scenarios", "routing.json") },
		only: { type: "string" },
		ref: { type: "string", multiple: true },
		n: { type: "string", default: "1" },
		jobs: { type: "string", default: "4" },
		auth: { type: "string" },
		skill: { type: "string", multiple: true, default: [] },
		extension: { type: "string", multiple: true, default: [] },
		package: { type: "string", multiple: true },
		budget: { type: "string", default: "3" },
		out: { type: "string" },
		root: { type: "string" },
		pi: { type: "string" },
		keep: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
	},
});

const realHome = homedir();
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: HERE, encoding: "utf8" }).trim();
const spec = JSON.parse(readFileSync(resolve(opt.scenarios!), "utf8"));
const wanted = opt.only?.split(",");
const scenarios: Scenario[] = spec.scenarios.filter((s: Scenario) => (wanted ? wanted.includes(s.id) : !s.optIn));
if (wanted && scenarios.length !== wanted.length) throw new Error(`unknown scenario in --only ${opt.only}`);
const pi = opt.pi ?? execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
const piVersion = execFileSync(pi, ["--version"], { encoding: "utf8" }).trim().split(/\s+/).pop()!;
const pool = JSON.parse(readFileSync(join(HERE, "pools", `${spec.pool}.json`), "utf8"));
const refs = opt.ref?.length ? opt.ref : ["HEAD"];
const sweep = new Date().toISOString().replace(/[:.]/g, "-");
const out =
	opt.out ?? join(process.env.XDG_STATE_HOME ?? join(realHome, ".local", "state"), "me-pi-evals", `${sweep}.jsonl`);
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** What the run must leave untouched in the live rig; Pi sessions and checkouts are left out on purpose (the user may be working). */
function liveSnapshot(): Record<string, string> {
	const agent = join(realHome, ".pi", "agent");
	const read = (f: string) => (existsSync(join(agent, f)) ? sha(readFileSync(join(agent, f))) : "absent");
	const link = (f: string) =>
		existsSync(join(agent, f)) && lstatSync(join(agent, f)).isSymbolicLink()
			? readlinkSync(join(agent, f))
			: "absent";
	return {
		"settings.json": read("settings.json"),
		"delegate.json": read("delegate.json"),
		"AGENTS.md": link("AGENTS.md"),
		skills: existsSync(join(agent, "skills")) ? readdirSync(join(agent, "skills")).sort().join(",") : "absent",
		"auth.json mtime": existsSync(join(agent, "auth.json"))
			? String(statSync(join(agent, "auth.json")).mtimeMs)
			: "absent",
	};
}

// A Unix socket path is capped near 104 bytes, which a sandbox under a deep temp dir can exceed.
const socketOf = (sandbox: Sandbox) => `/tmp/me-pi-eval-${sha(sandbox.root).slice(0, 12)}.sock`;

const piLive = (sandbox: Sandbox, ...args: string[]) =>
	execFile("bash", [PI_LIVE, ...args], {
		env: { ...process.env, PI_LIVE_TMUX_SOCKET: socketOf(sandbox) },
		maxBuffer: 16 * 1024 * 1024,
	});

function piCommand(sandbox: Sandbox, extra: Record<string, string>, sessionDir: string): string[] {
	const env = Object.entries({ ...sandbox.env, ...extra }).map(([k, v]) => `${k}=${v}`);
	return ["env", "-i", ...env, pi, "--session-dir", sessionDir];
}

function sandboxFor(ref: string): Sandbox {
	return createSandbox({
		repo,
		ref,
		policy: spec.policy as Policy,
		coordinator: spec.coordinator,
		pool,
		auth: opt.auth,
		skills: opt.skill,
		extensions: opt.extension,
		packages: opt.package ?? ["npm:pi-web-access@0.46.0"],
		path: [dirname(process.execPath), dirname(pi)],
		piVersion,
		realHome,
		root: opt.root,
	});
}

async function dryRun(sandbox: Sandbox): Promise<boolean> {
	const sessions = join(sandbox.root, "sessions", "dry-run");
	mkdirSync(sessions, { recursive: true });
	const { stdout: target } = await piLive(sandbox, "start", sandbox.src, "--", ...piCommand(sandbox, {}, sessions));
	const { stdout: screen } = await piLive(sandbox, "read", target.trim());
	await piLive(sandbox, "stop", target.trim());
	const wants = [
		"delegate.ts",
		"guard.ts",
		"skill.ts",
		...(spec.policy === "full-rig" ? ["implement-me-pi", "AGENTS.md"] : []),
	];
	const missing = wants.filter((w) => !screen.includes(w));
	console.log(screen);
	console.log(
		missing.length ? `✗ dry run: not loaded: ${missing.join(", ")}` : "✓ dry run: Pi started and loaded the policy",
	);
	return missing.length === 0;
}

interface Attempt {
	ref: string;
	sandbox: Sandbox;
	scenario: Scenario;
	n: number;
}

async function runAttempt(a: Attempt): Promise<Record<string, any>> {
	const id = `${a.scenario.id}-${a.ref.replace(/[^\w.-]/g, "_")}-${a.n}`;
	const work = join(a.sandbox.root, "work", id);
	const sessions = join(a.sandbox.root, "sessions", id);
	const status = join(a.sandbox.root, "status", `${id}.log`);
	mkdirSync(sessions, { recursive: true });
	mkdirSync(dirname(status), { recursive: true });
	const fixture =
		a.scenario.cwd === "repo"
			? cloneAt(a.sandbox.src, a.sandbox.commit, work)
			: fixtureRepo(join(HERE, "fixtures", a.scenario.cwd), work, a.sandbox.env);
	const started = Date.now();
	let state: "completed" | "void" | "incomplete" = "completed";
	let note = "";
	const extra = { ME_PI_STATUS_LOG: status, ME_PI_SPEND_BUDGET_USD: opt.budget! };
	let target = "";
	try {
		target = (await piLive(a.sandbox, "start", work, "--", ...piCommand(a.sandbox, extra, sessions))).stdout.trim();
		for (const turn of a.scenario.turns) {
			if (turn.afterSeconds) await new Promise((r) => setTimeout(r, turn.afterSeconds! * 1000));
			await piLive(a.sandbox, "ask", target, turn.prompt);
		}
	} catch (err) {
		state = "incomplete";
		note = (err as Error).message.split("\n")[0];
	} finally {
		if (target) await piLive(a.sandbox, "stop", target).catch(() => {});
	}
	const log = existsSync(status) ? readFileSync(status, "utf8") : "";
	if (/STOPPED: account/.test(log)) [state, note] = ["incomplete", "account"];
	else if (/STOPPED: infra/.test(log)) [state, note] = ["void", "infra"];
	const file = readdirSync(sessions).find((f) => f.endsWith(".jsonl"));
	let verdicts: Verdict[] = [];
	let cost = { coordinator: 0, worker: 0, source: "unavailable" };
	let calls = 0;
	if (file) {
		const t = parseSession(readFileSync(join(sessions, file), "utf8"));
		verdicts = a.scenario.expect.map((e) => check(t, e));
		cost = { coordinator: t.coordinatorCost, worker: t.workerCost, source: "pi-estimate" };
		calls = t.calls.length;
	} else if (state === "completed") [state, note] = ["incomplete", "no session log"];
	const outcome =
		state !== "completed"
			? state
			: verdicts.every((v) => v.result === "pass")
				? "pass"
				: verdicts.some((v) => v.result === "fail")
					? "fail"
					: "unknown";
	const git = (path: string) =>
		execFileSync("git", ["-C", a.sandbox.src, "rev-parse", `${a.sandbox.commit}:${path}`], {
			encoding: "utf8",
		}).trim();
	// Refs before the pi-workers package move keep their extensions at the root; drop this once no compared ref predates it.
	const extensionsTree = () => {
		const moved = spawnSync("git", [
			"-C",
			a.sandbox.src,
			"cat-file",
			"-e",
			`${a.sandbox.commit}:packages/pi-workers/extensions`,
		]);
		return git(moved.status === 0 ? "packages/pi-workers/extensions" : "extensions");
	};
	return {
		sweep,
		attempt: id,
		scenario: a.scenario.id,
		ref: a.ref,
		commit: a.sandbox.commit,
		pi: piVersion,
		node: process.version,
		os: `${platform()} ${release()}`,
		coordinator: spec.coordinator,
		policy: spec.policy,
		hashes: {
			prompts: sha(JSON.stringify(a.scenario.turns)),
			expect: sha(JSON.stringify(a.scenario.expect)),
			fixture,
			pool: sha(JSON.stringify(pool)),
			extensions: extensionsTree(),
			globalAgents: git("GLOBAL_AGENTS.md"),
			skills: git("skills"),
			extraSkills: opt.skill,
			extraExtensions: opt.extension!.map((f) => `${f.split("/").pop()}:${sha(readFileSync(f))}`),
		},
		budgetUsd: Number(opt.budget),
		durationMs: Date.now() - started,
		calls,
		cost,
		state,
		note,
		outcome,
		verdicts,
	};
}

async function main() {
	const before = liveSnapshot();
	const sandboxes = new Map(refs.map((r) => [r, sandboxFor(r)]));
	try {
		if (opt["dry-run"]) {
			const ok = await Promise.all([...sandboxes.values()].map(dryRun));
			process.exitCode = ok.every(Boolean) ? 0 : 1;
			return;
		}
		if (!opt.auth) throw new Error("--auth <eval auth.json> is required for a real run; use --dry-run without one");
		// One serial check refreshes the shared eval login before parallel attempts could race to rotate it.
		for (const s of sandboxes.values())
			execFileSync(pi, ["auth", "check", "--provider", spec.coordinator.provider], { env: s.env, stdio: "inherit" });
		// Interleave refs so provider drift during the sweep hits each ref alike.
		const queue: Attempt[] = [];
		for (let n = 1; n <= Number(opt.n); n++)
			for (const scenario of scenarios)
				for (const ref of refs) queue.push({ ref, sandbox: sandboxes.get(ref)!, scenario, n });
		mkdirSync(dirname(out), { recursive: true });
		const records: Record<string, any>[] = [];
		let stopped = false;
		const worker = async () => {
			for (let a = queue.shift(); a && !stopped; a = queue.shift()) {
				const record = await runAttempt(a);
				records.push(record);
				appendFileSync(out, `${JSON.stringify(record)}\n`, { mode: 0o600 });
				console.log(
					`${record.attempt}: ${record.outcome} $${(record.cost.coordinator + record.cost.worker).toFixed(2)}`,
				);
				if (record.note === "account") stopped = true;
			}
		};
		await Promise.all(Array.from({ length: Number(opt.jobs) }, worker));
		console.log(`\nrecords: ${out}${stopped ? "\n✗ stopped: account error (needs the user)" : ""}\n`);
		console.log("| scenario | ref | pass | attempted | void | incomplete | cost |\n|---|---|---|---|---|---|---|");
		for (const s of scenarios)
			for (const ref of refs) {
				const r = records.filter((x) => x.scenario === s.id && x.ref === ref);
				const count = (o: string) => r.filter((x) => x.outcome === o).length;
				const spent = r.reduce((sum, x) => sum + x.cost.coordinator + x.cost.worker, 0);
				console.log(
					`| ${s.id} | ${ref} | ${count("pass")}/${r.length - count("void")} | ${r.length} | ${count("void")} | ${count("incomplete")} | $${spent.toFixed(2)} |`,
				);
			}
	} finally {
		const after = liveSnapshot();
		const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
		if (changed.length)
			console.error(`⚠ live ~/.pi/agent changed during the run (yours or the run's?): ${changed.join(", ")}`);
		for (const s of sandboxes.values()) rmSync(socketOf(s), { force: true });
		if (!opt.keep) for (const s of sandboxes.values()) rmSync(s.root, { recursive: true, force: true });
		else for (const s of sandboxes.values()) console.log(`kept ${s.root}`);
	}
}

await main();
