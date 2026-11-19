/**
 * Manual A/B eval: one real implementation task, run by a coordinator with the `implement` worker (arm A) and by one
 * that edits directly (arm B), each in a fresh isolated Pi. Outcomes are measured from the worktree, not the agent's
 * report. Real model calls and real spend; never part of `npm run check`. See evals/ab/README.md.
 */
import { execFileSync, spawn } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	ARMS,
	type Arm,
	median,
	promptOf,
	renderContract,
	reportStatus,
	sessionFacts,
	skillOf,
	validateTask,
} from "./ab-task.ts";
import { liveSnapshot, piCommand, piLive, sha, socketOf } from "./live.ts";
import { cloneAt, createSandbox, type Sandbox } from "./sandbox.ts";
import { parseSession, workerSpend } from "./score.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const WATCH_MS = 20_000;

const { values: opt } = parseArgs({
	options: {
		task: { type: "string" },
		arm: { type: "string", multiple: true },
		n: { type: "string", default: "1" },
		jobs: { type: "string", default: "2" },
		auth: { type: "string" },
		skill: { type: "string", multiple: true, default: [] },
		extension: { type: "string", multiple: true, default: [] },
		package: { type: "string", multiple: true },
		cap: { type: "string", default: "25" },
		"timeout-min": { type: "string", default: "120" },
		out: { type: "string" },
		root: { type: "string" },
		pi: { type: "string" },
		keep: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
	},
});

if (!opt.task) throw new Error("--task <file.json> is required");
const arms = (opt.arm?.length ? opt.arm : [...ARMS]) as Arm[];
for (const a of arms) if (!ARMS.includes(a)) throw new Error(`--arm must be A or B, got ${a}`);
const positive = (name: string, v: string) => {
	const x = Number(v);
	if (!(x > 0)) throw new Error(`--${name} must be a positive number, got ${v}`);
	return x;
};
const runs = positive("n", opt.n!);
const jobs = positive("jobs", opt.jobs!);
const cap = positive("cap", opt.cap!);
const timeoutMs = positive("timeout-min", opt["timeout-min"]!) * 60_000;
if (!opt["dry-run"] && !opt.auth)
	throw new Error("--auth <eval auth.json> is required for a real run; use --dry-run without one");

const task = validateTask(JSON.parse(readFileSync(resolve(opt.task), "utf8")));
const template = readFileSync(join(HERE, "ab", "contract.md"), "utf8");
const directSkill = join(HERE, "ab", "skills", "implement-direct");
const realHome = homedir();
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: HERE, encoding: "utf8" }).trim();
const pi = opt.pi ?? execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
const piVersion = execFileSync(pi, ["--version"], { encoding: "utf8" }).trim().split(/\s+/).pop()!;
const sweep = new Date().toISOString().replace(/[:.]/g, "-");
const out =
	opt.out ??
	join(process.env.XDG_STATE_HOME ?? join(realHome, ".local", "state"), "me-pi-evals", `ab-${task.id}-${sweep}.jsonl`);
const artifacts = out.replace(/\.jsonl$/, "");
// pi-live.sh reads its settle timeout from the env it inherits; the runner's own timer stops Pi at the same bound.
process.env.PI_LIVE_TIMEOUT = String(Math.ceil(timeoutMs / 1000));

const git = (cwd: string, env: Record<string, string>, ...args: string[]) =>
	execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

interface ShellResult {
	exit: number | null;
	ms: number;
	timedOut: boolean;
	tail: string;
}

/** Runs one shell command asynchronously (parallel attempts keep their watchdogs ticking), killed at `limitMs`. */
function shell(command: string, cwd: string, env: Record<string, string>, limitMs: number): Promise<ShellResult> {
	const started = Date.now();
	return new Promise((done, fail) => {
		const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let output = "";
		const keep = (b: Buffer) => {
			output = (output + b.toString()).slice(-4000);
		};
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			process.kill(-child.pid!, "SIGKILL");
		}, limitMs);
		child.on("error", fail);
		child.on("close", (exit) => {
			clearTimeout(timer);
			done({ exit, ms: Date.now() - started, timedOut, tail: output.slice(-1500) });
		});
	});
}

/** Every sandbox made, for socket and root cleanup. */
const roots: Sandbox[] = [];

function sandboxFor(arm: Arm): Sandbox {
	return createSandbox({
		repo,
		ref: "HEAD",
		policy: "full-rig",
		coordinator: task.coordinator,
		pool: task.pool,
		auth: opt.auth,
		skills: [...opt.skill!, ...(arm === "B" ? [directSkill] : [])],
		extensions: opt.extension,
		packages: opt.package ?? ["npm:pi-web-access@0.46.0"],
		path: [dirname(process.execPath), dirname(pi)],
		piVersion,
		realHome,
		root: opt.root,
	});
}

interface Attempt {
	id: string;
	arm: Arm;
	n: number;
	sandbox: Sandbox;
	dir: string;
	worktree: string;
	contract: string;
	report: string;
	sessions: string;
	status: string;
}

/** Clones the target at its base with no remote, creates the branch, runs setup, and writes the brief and contract. */
async function prepare(arm: Arm, n: number): Promise<Attempt> {
	const sandbox = sandboxFor(arm);
	roots.push(sandbox);
	const id = `${task.id}-${arm}${n}`;
	const dir = join(sandbox.root, "attempt");
	const a: Attempt = {
		id,
		arm,
		n,
		sandbox,
		dir,
		worktree: join(dir, "worktree"),
		contract: join(dir, "contract.md"),
		report: join(dir, "report.md"),
		sessions: join(dir, "sessions"),
		status: join(dir, "status.log"),
	};
	mkdirSync(a.sessions, { recursive: true });
	cloneAt(task.repo, task.base, a.worktree);
	git(a.worktree, sandbox.env, "checkout", "--quiet", "-b", task.branch);
	for (const command of task.setup) {
		const r = await shell(command, a.worktree, sandbox.env, timeoutMs);
		if (r.exit !== 0) throw new Error(`${id}: setup \`${command}\` failed (exit ${r.exit}):\n${r.tail}`);
	}
	const brief = join(dir, "brief.md");
	copyFileSync(task.brief, brief);
	const paths = { run: `${sweep} ${id}`, brief, worktree: a.worktree, report: a.report };
	writeFileSync(a.contract, renderContract(template, task, arm, paths));
	return a;
}

const coordinatorEnv = (a: Attempt) => ({
	// Both arms run unattended: nobody answers a dialog, so guard refuses instead of waiting.
	ME_PI_UNATTENDED: "1",
	ME_PI_STATUS_LOG: a.status,
	ME_PI_SPEND_BUDGET_USD: String(cap),
});

// The target is a remote-less clone the coordinator works in, so its project resources (e.g. `.agents/skills`) load as in
// the live rig, where the user trusts the repo; without this, Pi stops at the project-trust prompt nobody answers.
const coordinatorCommand = (a: Attempt) => [...piCommand(pi, a.sandbox, coordinatorEnv(a), a.sessions), "--approve"];

async function dryRun(arm: Arm): Promise<boolean> {
	const a = await prepare(arm, 0);
	const cmd = coordinatorCommand(a);
	const { stdout: target } = await piLive(a.sandbox, "start", a.worktree, "--", ...cmd);
	let screen = "";
	try {
		screen = (await piLive(a.sandbox, "read", target.trim())).stdout;
	} finally {
		await piLive(a.sandbox, "stop", target.trim());
	}
	const missing = [skillOf(arm), "delegate.ts"].filter((w) => !screen.includes(w));
	console.log(screen);
	console.log(
		missing.length
			? `✗ dry run arm ${arm}: not loaded: ${missing.join(", ")}`
			: `✓ dry run arm ${arm}: Pi started with ${skillOf(arm)} and delegate.ts`,
	);
	console.log(`contract ${arm}: ${a.contract}`);
	return missing.length === 0;
}

const sessionLog = (a: Attempt) => {
	const file = existsSync(a.sessions) && readdirSync(a.sessions).find((f) => f.endsWith(".jsonl"));
	return file ? readFileSync(join(a.sessions, file), "utf8") : undefined;
};

/** Pi-estimated spend so far; workers still running are not in the log yet, so the cap can overshoot by one job. */
function spent(jsonl: string) {
	const coordinator = parseSession(jsonl).coordinatorCost;
	const worker = workerSpend(jsonl);
	return { coordinator, worker, total: coordinator + worker.cost };
}

function numstat(cwd: string, env: Record<string, string>, from: string, to: string) {
	const rows = git(cwd, env, "diff", "--numstat", from, to)
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split("\t"));
	const sum = (i: number) => rows.reduce((s, r) => s + (Number(r[i]) || 0), 0);
	return { files: rows.length, insertions: sum(0), deletions: sum(1) };
}

/** Re-runs the check on the final HEAD: in the worktree when clean, else in a fresh clone of HEAD after setup. */
async function recheck(a: Attempt, head: string, clean: boolean) {
	let cwd = a.worktree;
	if (!clean) {
		cwd = join(a.dir, "recheck");
		cloneAt(a.worktree, head, cwd);
		for (const command of task.setup) {
			const r = await shell(command, cwd, a.sandbox.env, timeoutMs);
			if (r.exit !== 0) return { where: "clone", setupFailed: command, ...r };
		}
	}
	return { where: clean ? "worktree" : "clone", ...(await shell(task.check, cwd, a.sandbox.env, timeoutMs)) };
}

function diffVsReference(a: Attempt, head: string) {
	if (!task.reference) return undefined;
	const env = a.sandbox.env;
	try {
		git(a.worktree, env, "cat-file", "-e", `${task.reference}^{commit}`);
	} catch {
		// Fetched only after the session, so the agent never saw the known-good result.
		git(a.worktree, env, "fetch", "--quiet", "--no-tags", task.repo, task.reference);
	}
	return numstat(a.worktree, env, task.reference, head);
}

/**
 * pi-live's settle can return during a pause (a follow-up turn from a background job may still come), so the
 * attempt ends only once neither the screen nor the session log has changed for three watchdog intervals.
 */
async function quiet(a: Attempt, target: string, stopped: () => boolean) {
	let last = "";
	for (let still = 0; still < 3 && !stopped(); ) {
		await new Promise((r) => setTimeout(r, WATCH_MS));
		if (stopped()) return;
		const now = `${(await piLive(a.sandbox, "read", target)).stdout}\0${sessionLog(a)?.length ?? 0}`;
		still = now === last ? still + 1 : 0;
		last = now;
	}
}

async function runAttempt(a: Attempt): Promise<Record<string, any>> {
	const started = Date.now();
	let state: "completed" | "capped" | "timeout" | "incomplete" | "void" = "completed";
	let note = "";
	let target = "";
	const stop = async (why: "capped" | "timeout", detail: string) => {
		if (state !== "completed") return;
		[state, note] = [why, detail];
		if (target) await piLive(a.sandbox, "stop", target).catch(() => {});
	};
	const watchdog = setInterval(() => {
		const log = sessionLog(a);
		const total = log ? spent(log).total : 0;
		if (total >= cap) void stop("capped", `$${total.toFixed(2)} ≥ cap $${cap}`);
	}, WATCH_MS);
	const deadline = setTimeout(() => void stop("timeout", `${timeoutMs / 60_000} min`), timeoutMs);
	try {
		const cmd = coordinatorCommand(a);
		target = (await piLive(a.sandbox, "start", a.worktree, "--", ...cmd)).stdout.trim();
		await piLive(a.sandbox, "ask", target, promptOf(a.arm, a.contract));
		await quiet(a, target, () => state !== "completed");
	} catch (err) {
		if (state === "completed") {
			const message = (err as Error).message;
			[state, note] = /timed out/.test(message)
				? ["timeout", "pi-live settle"]
				: ["incomplete", message.split("\n")[0]];
		}
	} finally {
		clearInterval(watchdog);
		clearTimeout(deadline);
		if (target) await piLive(a.sandbox, "stop", target).catch(() => {});
	}
	const wallMs = Date.now() - started;
	const status = existsSync(a.status) ? readFileSync(a.status, "utf8") : "";
	if (/STOPPED: account/.test(status)) [state, note] = ["incomplete", "account"];
	else if (/STOPPED: infra/.test(status)) [state, note] = ["void", "infra"];

	const env = a.sandbox.env;
	const head = git(a.worktree, env, "rev-parse", "HEAD");
	const clean = git(a.worktree, env, "status", "--porcelain") === "";
	const patch = git(a.worktree, env, "diff", "--binary", task.base, head);
	const dir = join(artifacts, a.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "diff.patch"), patch ? `${patch}\n` : "", { mode: 0o600 });
	const reportExists = existsSync(a.report);
	if (reportExists) copyFileSync(a.report, join(dir, "report.md"));
	const check = await recheck(a, head, clean);

	const log = sessionLog(a);
	if (!log && state === "completed") [state, note] = ["incomplete", "no session log"];
	const cost = log ? spent(log) : undefined;
	const facts = log ? sessionFacts(log) : undefined;
	const byRole = cost?.worker.byRole ?? {};
	return {
		sweep,
		attempt: a.id,
		arm: a.arm,
		n: a.n,
		task: task.id,
		repo: task.repo,
		base: task.base,
		branch: task.branch,
		reference: task.reference,
		baseline: task.baseline,
		commit: a.sandbox.commit,
		pi: piVersion,
		node: process.version,
		os: `${platform()} ${release()}`,
		coordinator: task.coordinator,
		skill: skillOf(a.arm),
		hashes: {
			pool: sha(JSON.stringify(task.pool)),
			brief: sha(readFileSync(task.brief)),
			contract: sha(readFileSync(a.contract)),
			extraSkills: opt.skill,
			extraExtensions: opt.extension!.map((f) => `${f.split("/").pop()}:${sha(readFileSync(f))}`),
			packages: opt.package ?? ["npm:pi-web-access@0.46.0"],
		},
		capUsd: cap,
		timeoutMin: timeoutMs / 60_000,
		state,
		note,
		wallMs,
		head,
		commits: Number(git(a.worktree, env, "rev-list", "--count", `${task.base}..${head}`)),
		clean,
		check: { command: task.check, ...check },
		diffstat: numstat(a.worktree, env, task.base, head),
		diffVsReference: diffVsReference(a, head),
		report: { exists: reportExists, status: reportExists ? reportStatus(readFileSync(a.report, "utf8")) : null },
		cost: cost
			? {
					coordinator: cost.coordinator,
					worker: cost.worker.cost,
					total: cost.total,
					source: "pi-estimate",
				}
			: { coordinator: 0, worker: 0, total: 0, source: "unavailable" },
		workerCostByRole: Object.fromEntries(Object.entries(byRole).map(([r, v]) => [r, v.cost])),
		delegateCalls: Object.fromEntries(Object.entries(byRole).map(([r, v]) => [r, v.calls])),
		compactions: facts?.compactions ?? null,
		blocked: facts?.blocked ?? null,
		patch: join(dir, "diff.patch"),
	};
}

const fmt = (x: number | undefined, f: (v: number) => string) => (x === undefined ? "–" : f(x));

function summary(records: Record<string, any>[]) {
	console.log("| arm | attempts | completed | check green | median cost | median wall | median compactions |");
	console.log("|---|---|---|---|---|---|---|");
	for (const arm of arms) {
		const r = records.filter((x) => x.arm === arm);
		const green = r.filter((x) => x.check.exit === 0 && !x.check.timedOut).length;
		console.log(
			`| ${arm} | ${r.length} | ${r.filter((x) => x.state === "completed").length} | ${green} | ${fmt(
				median(r.map((x) => x.cost.total)),
				(v) => `$${v.toFixed(2)}`,
			)} | ${fmt(
				median(r.map((x) => x.wallMs)),
				(v) => `${(v / 60_000).toFixed(1)} min`,
			)} | ${fmt(median(r.filter((x) => x.compactions !== null).map((x) => x.compactions)), String)} |`,
		);
	}
}

async function main() {
	const before = liveSnapshot(realHome);
	try {
		if (opt["dry-run"]) {
			const ok: boolean[] = [];
			for (const arm of arms) ok.push(await dryRun(arm));
			process.exitCode = ok.every(Boolean) ? 0 : 1;
			return;
		}
		// Interleave arms (A1, B1, A2, B2…) so provider drift during the sweep hits each arm alike.
		const queue: { arm: Arm; n: number }[] = [];
		for (let n = 1; n <= runs; n++) for (const arm of arms) queue.push({ arm, n });
		mkdirSync(dirname(out), { recursive: true });
		const records: Record<string, any>[] = [];
		let authChecked: Promise<void> | undefined;
		let stopped = false;
		const worker = async () => {
			for (let q = queue.shift(); q && !stopped; q = queue.shift()) {
				const a = await prepare(q.arm, q.n);
				// One serial check refreshes the shared eval login before parallel attempts could race to rotate it.
				authChecked ??= Promise.resolve().then(() => {
					execFileSync(pi, ["auth", "check", "--provider", task.coordinator.provider], {
						env: a.sandbox.env,
						stdio: "inherit",
					});
				});
				await authChecked;
				const record = await runAttempt(a);
				records.push(record);
				appendFileSync(out, `${JSON.stringify(record)}\n`, { mode: 0o600 });
				console.log(
					`${record.attempt}: ${record.state} check ${record.check.exit === 0 ? "✓" : "✗"} $${record.cost.total.toFixed(2)}`,
				);
				if (record.note === "account") stopped = true;
			}
		};
		await Promise.all(Array.from({ length: jobs }, worker));
		console.log(`\nrecords: ${out}\npatches: ${artifacts}${stopped ? "\n✗ stopped: account error" : ""}\n`);
		summary(records);
	} finally {
		const after = liveSnapshot(realHome);
		const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
		if (changed.length)
			console.error(`⚠ live ~/.pi/agent changed during the run (yours or the run's?): ${changed.join(", ")}`);
		for (const s of roots) rmSync(socketOf(s), { force: true });
		if (!opt.keep) for (const s of roots) rmSync(s.root, { recursive: true, force: true });
		else for (const s of roots) console.log(`kept ${s.root}`);
	}
}

await main();
