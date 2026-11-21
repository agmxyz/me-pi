/**
 * Manual A/B eval: real implementation tasks, each run by a coordinator with the `implement` worker (arm A) and by one
 * that edits directly (arm B), each in a fresh isolated Pi. Outcomes are measured from the worktree, not the agent's
 * report. Real model calls and real spend; never part of `npm run check`. See evals/ab/README.md.
 */
import { execFileSync, spawn } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	type ActiveClock,
	ARMS,
	type Arm,
	type AttemptState,
	attemptQueue,
	coordinatorEnv,
	coordinatorLabel,
	finalState,
	isAccepted,
	isPass,
	isWipSubject,
	loadTask,
	type Pool,
	promptOf,
	renderContract,
	reportStatus,
	type SummaryRecord,
	seatsOf,
	sessionFacts,
	skillOf,
	summaryTable,
	type Task,
	tick,
} from "./ab-task.ts";
import { liveSnapshot, panePid, piCommand, piLive, sha, socketOf, sweepProcesses } from "./live.ts";
import {
	type Coordinator,
	cloneAt,
	createSandbox,
	fixtureRepo,
	removeSandbox,
	type Sandbox,
	sandboxDirs,
} from "./sandbox.ts";
import { sessionSpend } from "./score.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const WATCH_MS = 20_000;
/** A coordinator that has written no session log this long after its prompt would leave the cap blind. */
const NO_LOG_MS = 3 * 60_000;

const { values: opt } = parseArgs({
	options: {
		task: { type: "string", multiple: true },
		tasks: { type: "string", multiple: true },
		arm: { type: "string", multiple: true },
		n: { type: "string", default: "1" },
		jobs: { type: "string", default: "1" },
		auth: { type: "string" },
		skill: { type: "string", multiple: true, default: [] },
		extension: { type: "string", multiple: true, default: [] },
		package: { type: "string", multiple: true },
		cap: { type: "string", default: "25" },
		"timeout-min": { type: "string", default: "120" },
		out: { type: "string" },
		resume: { type: "string" },
		root: { type: "string" },
		pi: { type: "string" },
		keep: { type: "boolean", default: false },
		"dry-run": { type: "boolean", default: false },
	},
});

if (!opt.task?.length && !opt.tasks?.length) throw new Error("--task <file.json> or --tasks <list.json> is required");
if (opt.resume && opt.out && resolve(opt.out) !== resolve(opt.resume))
	throw new Error("--resume appends to its own file; drop --out or give the same path");
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

/** Synthetic targets (fixture plus the task's base overlay), built once per sweep and removed at the end. */
const targets = mkdtempSync(join(tmpdir(), "me-pi-ab-targets-"));
// A fixed identity and no user config, so the target's first commit, the attempts' base, is the same every sweep.
const targetEnv = {
	HOME: targets,
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "me-pi eval",
	GIT_AUTHOR_EMAIL: "eval@invalid",
	GIT_COMMITTER_NAME: "me-pi eval",
	GIT_COMMITTER_EMAIL: "eval@invalid",
};
const loadEntry = (file: string) => (raw: any) =>
	loadTask(raw, dirname(file), (fixture, overlay) => {
		const repo = join(targets, String(raw.id));
		return { repo, base: fixtureRepo(fixture, repo, targetEnv, overlay) };
	});
const loadAll = () => [
	...(opt.task ?? []).map((f) => loadEntry(resolve(f))(JSON.parse(readFileSync(resolve(f), "utf8")))),
	...(opt.tasks ?? []).flatMap((f) => {
		const list = JSON.parse(readFileSync(resolve(f), "utf8"));
		if (!Array.isArray(list)) throw new Error(`--tasks: ${f} must hold a JSON array of tasks`);
		return list.map(loadEntry(resolve(f)));
	}),
];
let tasks: Task[];
try {
	tasks = loadAll();
} catch (err) {
	rmSync(targets, { recursive: true, force: true });
	throw err;
}
const taskIds = tasks.map((t) => t.id);
const dup = taskIds.find((id, i) => taskIds.indexOf(id) !== i);
if (dup) throw new Error(`--task: task id ${dup} given twice`);
const taskById = new Map(tasks.map((t) => [t.id, t]));
// A matrix task's pool keeps these skills; scout and worker become the attempt's coordinator.
const basePool = JSON.parse(readFileSync(join(HERE, "pools", "codex.json"), "utf8")) as Pool;
const seats = new Map(tasks.map((t) => [t.id, seatsOf(t, basePool)]));
const seatOf = (task: Task, c: Coordinator) =>
	seats.get(task.id)!.find((s) => coordinatorLabel(s.coordinator) === coordinatorLabel(c))!;
const coordinators = [
	...new Map([...seats.values()].flat().map((s) => [coordinatorLabel(s.coordinator), s.coordinator])).values(),
];
const template = readFileSync(join(HERE, "ab", "contract.md"), "utf8");
const directSkill = join(HERE, "ab", "skills", "implement-direct");
const realHome = homedir();
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: HERE, encoding: "utf8" }).trim();
const pi = opt.pi ?? execFileSync("sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim();
const piVersion = execFileSync(pi, ["--version"], { encoding: "utf8" }).trim().split(/\s+/).pop()!;
const sweep = new Date().toISOString().replace(/[:.]/g, "-");
const out = resolve(
	opt.resume ??
		opt.out ??
		join(
			process.env.XDG_STATE_HOME ?? join(realHome, ".local", "state"),
			"me-pi-evals",
			tasks.length > 1 ? `ab-multi-${sweep}.jsonl` : `ab-${tasks[0].id}-${sweep}.jsonl`,
		),
);
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

/** Process groups of running setup and check commands, killed on SIGINT/SIGTERM. */
const shells = new Set<number>();

/** Runs one shell command asynchronously (parallel attempts keep their watchdogs ticking), killed at `limitMs`. */
function shell(command: string, cwd: string, env: Record<string, string>, limitMs: number): Promise<ShellResult> {
	const started = Date.now();
	return new Promise((done, fail) => {
		const child = spawn("sh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		shells.add(child.pid!);
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
			shells.delete(child.pid!);
			clearTimeout(timer);
			done({ exit, ms: Date.now() - started, timedOut, tail: output.slice(-1500) });
		});
	});
}

/** Every sandbox made, for socket and root cleanup. */
const roots: Sandbox[] = [];

/** Started Pi targets not yet halted, by sandbox root: each entry stops its target and sweeps its processes. */
const live = new Map<string, () => Promise<number>>();
/** Roots where a process survived SIGKILL: never deleted under it. */
const survived = new Set<string>();

/**
 * Starts the coordinator and registers its halt, so a stop from any path (cap, timeout, end, error, signal) ends the
 * same way: kill the tmux session, then sweep every process of the attempt, including detached delegate workers.
 */
async function startTarget(sandbox: Sandbox, cwd: string, cmd: string[]) {
	const target = (await piLive(sandbox, "start", cwd, "--", ...cmd)).stdout.trim();
	const pid = await panePid(sandbox, target).catch(async (err) => {
		await piLive(sandbox, "stop", target).catch(() => {});
		await sweepProcesses(sandboxDirs(sandbox)).catch((sweepErr) => {
			survived.add(sandbox.root);
			throw sweepErr;
		});
		throw err;
	});
	let halted: Promise<number> | undefined;
	const halt = () => {
		halted ??= (async () => {
			await piLive(sandbox, "stop", target).catch(() => {});
			try {
				return await sweepProcesses(sandboxDirs(sandbox), [pid]);
			} catch (err) {
				survived.add(sandbox.root);
				throw err;
			} finally {
				live.delete(sandbox.root);
			}
		})();
		return halted;
	};
	live.set(sandbox.root, halt);
	return { target, halt };
}

/** Halts every started target, kills running setup and check commands, then removes sockets and (unless --keep) roots. */
async function cleanup() {
	const halts = await Promise.allSettled([...live.values()].map((halt) => halt()));
	for (const h of halts) if (h.status === "rejected") console.error(`⚠ halt failed: ${(h.reason as Error).message}`);
	for (const pid of shells)
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Already exited.
		}
	for (const s of roots) rmSync(socketOf(s), { force: true });
	rmSync(targets, { recursive: true, force: true });
	for (const s of roots)
		if (survived.has(s.root)) console.error(`⚠ kept ${s.root}: a process of it survived SIGKILL`);
		else if (!opt.keep) removeSandbox(s);
		else console.log(`kept ${s.root} (TMPDIR ${s.tmp})`);
}

function sandboxFor(seat: { coordinator: Coordinator; pool: Pool }, arm: Arm): Sandbox {
	return createSandbox({
		repo,
		ref: "HEAD",
		policy: "full-rig",
		coordinator: seat.coordinator,
		pool: seat.pool,
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
	task: Task;
	coordinator: Coordinator;
	pool: Pool;
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
async function prepare(task: Task, coordinator: Coordinator, arm: Arm, n: number): Promise<Attempt> {
	const seat = seatOf(task, coordinator);
	const sandbox = sandboxFor(seat, arm);
	roots.push(sandbox);
	// A matrix task's attempts name their coordinator, so their artifact directories do not collide.
	const id = task.coordinators
		? `${task.id}-${coordinator.model}@${coordinator.thinking}-${arm}${n}`
		: `${task.id}-${arm}${n}`;
	const dir = join(sandbox.root, "attempt");
	const a: Attempt = {
		id,
		task,
		coordinator,
		pool: seat.pool,
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

// The target is a remote-less clone the coordinator works in, so its project resources (e.g. `.agents/skills`) load as in
// the live rig, where the user trusts the repo; without this, Pi stops at the project-trust prompt nobody answers.
const coordinatorCommand = (a: Attempt) => [
	...piCommand(pi, a.sandbox, coordinatorEnv(a.status, cap), a.sessions),
	"--approve",
];

async function dryRun(task: Task, coordinator: Coordinator, arm: Arm): Promise<boolean> {
	const a = await prepare(task, coordinator, arm, 0);
	const cmd = coordinatorCommand(a);
	const { target, halt } = await startTarget(a.sandbox, a.worktree, cmd);
	let screen = "";
	try {
		screen = (await piLive(a.sandbox, "read", target)).stdout;
	} finally {
		await halt();
	}
	const missing = [skillOf(arm), "delegate.ts"].filter((w) => !screen.includes(w));
	console.log(screen);
	console.log(
		missing.length
			? `✗ dry run ${a.id}: not loaded: ${missing.join(", ")}`
			: `✓ dry run ${a.id}: Pi started with ${skillOf(arm)} and delegate.ts`,
	);
	console.log(`contract ${a.id}: ${a.contract}`);
	return missing.length === 0;
}

const sessionLog = (a: Attempt) => {
	const file = existsSync(a.sessions) && readdirSync(a.sessions).find((f) => f.endsWith(".jsonl"));
	return file ? readFileSync(join(a.sessions, file), "utf8") : undefined;
};

function numstat(cwd: string, env: Record<string, string>, from: string, to: string) {
	const rows = git(cwd, env, "diff", "--numstat", from, to)
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split("\t"));
	const sum = (i: number) => rows.reduce((s, r) => s + (Number(r[i]) || 0), 0);
	return { files: rows.length, insertions: sum(0), deletions: sum(1) };
}

/** Runs `setup` then the check in `cwd`; a failed setup command is reported instead of the check. */
async function setupAndCheck(a: Attempt, cwd: string) {
	for (const command of a.task.setup) {
		const r = await shell(command, cwd, a.sandbox.env, timeoutMs);
		if (r.exit !== 0) return { setupFailed: command, ...r };
	}
	return shell(a.task.check, cwd, a.sandbox.env, timeoutMs);
}

/**
 * Re-runs the check on the final HEAD twice: in the worktree as the agent left it, and in a fresh remote-less clone of
 * HEAD after `setup`, so ignored build output the agent left behind cannot make it pass.
 */
async function recheck(a: Attempt, head: string) {
	const inWorktree = await shell(a.task.check, a.worktree, a.sandbox.env, timeoutMs);
	const fresh = join(a.dir, "fresh");
	cloneAt(a.worktree, head, fresh);
	return { inWorktree, fresh: await setupAndCheck(a, fresh), hidden: await hiddenTests(a, fresh) };
}

/**
 * A synthetic task's hidden tests, copied into the fresh clone's `test/` only now that every process of the attempt
 * has exited, and run alone with `node --test`.
 */
async function hiddenTests(a: Attempt, fresh: string) {
	if (!a.task.synth) return undefined;
	const hidden = join(a.task.synth.dir, "hidden");
	const files = readdirSync(hidden).filter((f) => f.endsWith(".test.ts"));
	if (!files.length) throw new Error(`${a.task.id}: no hidden tests in ${hidden}`);
	mkdirSync(join(fresh, "test"), { recursive: true });
	for (const f of files) copyFileSync(join(hidden, f), join(fresh, "test", f));
	const { exit, ms, timedOut, tail } = await shell(
		`node --test ${files.map((f) => `'test/${f}'`).join(" ")}`,
		fresh,
		a.sandbox.env,
		timeoutMs,
	);
	return { files, exit, ms, timedOut, tail };
}
function diffVsReference(a: Attempt, head: string) {
	const { task } = a;
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
	const { task } = a;
	const started = Date.now();
	let clock: ActiveClock = { last: started, deadline: started + timeoutMs, suspendedMs: 0 };
	let state: AttemptState = "completed";
	let note = "";
	let halt: (() => Promise<number>) | undefined;
	let askedAt: number | undefined;
	const stop = (why: AttemptState, detail: string) => {
		if (state !== "completed") return;
		[state, note] = [why, detail];
		void halt?.().catch(() => {});
	};
	// The timeout counts active time: a tick that finds the machine slept moves the deadline by the gap.
	const watchdog = setInterval(() => {
		clock = tick(clock, Date.now());
		if (Date.now() >= clock.deadline) stop("timeout", `${timeoutMs / 60_000} min`);
		const log = sessionLog(a);
		if (!log) {
			if (askedAt !== undefined && Date.now() - askedAt >= NO_LOG_MS) stop("incomplete", "no session log");
			return;
		}
		const { total } = sessionSpend(log);
		if (total >= cap) stop("capped", `$${total.toFixed(2)} ≥ cap $${cap}`);
	}, WATCH_MS);
	let orphansKilled = 0;
	try {
		const t = await startTarget(a.sandbox, a.worktree, coordinatorCommand(a));
		halt = t.halt;
		// The deadline may have passed while Pi started; nothing halted it then.
		if (state !== "completed") throw new Error(note);
		askedAt = Date.now();
		await piLive(a.sandbox, "ask", t.target, promptOf(a.arm, a.contract));
		await quiet(a, t.target, () => state !== "completed");
	} catch (err) {
		if (state === "completed") {
			const message = (err as Error).message;
			[state, note] = /timed out/.test(message)
				? ["timeout", "pi-live settle"]
				: ["incomplete", message.split("\n")[0]];
		}
	} finally {
		clearInterval(watchdog);
		// Nothing of the attempt may run past here: an implement worker's shutdown WIP commit would race the measurement.
		if (halt) orphansKilled = await halt();
	}
	const wallMs = Date.now() - started;
	const log = sessionLog(a);
	const spend = log ? sessionSpend(log) : undefined;
	({ state, note } = finalState({
		arm: a.arm,
		state,
		note,
		statusLog: existsSync(a.status) ? readFileSync(a.status, "utf8") : "",
		hasLog: !!log,
		implementCalls: spend?.byRole.implement?.calls ?? 0,
	}));

	const env = a.sandbox.env;
	const head = git(a.worktree, env, "rev-parse", "HEAD");
	const headIsWip = isWipSubject(git(a.worktree, env, "log", "-1", "--format=%s", head));
	const clean = git(a.worktree, env, "status", "--porcelain") === "";
	const patch = git(a.worktree, env, "diff", "--binary", task.base, head);
	const dir = join(artifacts, a.id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "diff.patch"), patch ? `${patch}\n` : "", { mode: 0o600 });
	const reportExists = existsSync(a.report);
	if (reportExists) copyFileSync(a.report, join(dir, "report.md"));
	// Kept so a run can be audited afterwards, e.g. for a read of the live checkout's evals/synth by absolute path.
	if (log) writeFileSync(join(dir, "session.jsonl"), log, { mode: 0o600 });
	const ignoredLeftovers = git(a.worktree, env, "clean", "-ndX").split("\n").filter(Boolean).length;
	const check = await recheck(a, head);

	const facts = log ? sessionFacts(log) : undefined;
	const byRole = spend?.byRole ?? {};
	const report = {
		exists: reportExists,
		status: reportExists ? reportStatus(readFileSync(a.report, "utf8")) : null,
	};
	const checkFresh = { command: task.check, ...check.fresh };
	const accepted = isAccepted({ state, report, checkFresh, headIsWip });
	const pass =
		task.synth &&
		isPass(task.synth, {
			accepted,
			hidden: check.hidden!,
			reportText: reportExists ? readFileSync(a.report, "utf8") : "",
			srcChanged: git(a.worktree, env, "diff", "--name-only", task.base, head, "--", "src")
				.split("\n")
				.filter(Boolean),
		});
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
		coordinator: a.coordinator,
		skill: skillOf(a.arm),
		hashes: {
			pool: sha(JSON.stringify(a.pool)),
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
		accepted,
		pass,
		expect: task.synth?.expect,
		wallMs,
		suspendedMs: clock.suspendedMs,
		head,
		headIsWip,
		commits: Number(git(a.worktree, env, "rev-list", "--count", `${task.base}..${head}`)),
		clean,
		ignoredLeftovers,
		checkInWorktree: { command: task.check, ...check.inWorktree },
		checkFresh,
		hidden: check.hidden,
		diffstat: numstat(a.worktree, env, task.base, head),
		diffVsReference: diffVsReference(a, head),
		report,
		cost: spend
			? {
					coordinator: spend.coordinator,
					worker: spend.worker,
					total: spend.total,
					source: spend.partial ? "partial" : "pi-estimate",
					pending: spend.pending,
				}
			: { coordinator: 0, worker: 0, total: 0, source: "unavailable", pending: [] },
		workerCostByRole: Object.fromEntries(Object.entries(byRole).map(([r, v]) => [r, v.cost])),
		delegateCalls: Object.fromEntries(Object.entries(byRole).map(([r, v]) => [r, v.calls])),
		implementWorkerSeconds: Math.round((byRole.implement?.ms ?? 0) / 1000),
		orphansKilled,
		compactions: facts?.compactions ?? null,
		blocked: facts?.blocked ?? null,
		patch: join(dir, "diff.patch"),
	};
}

const before = liveSnapshot(realHome);
/** Stops the `caffeinate` started by `main`, if any. */
let wake: (() => boolean) | undefined;
let cleaned: Promise<void> | undefined;
/** Runs once, from the normal end or a signal: nothing is removed until every started target is halted. */
function finish() {
	cleaned ??= (async () => {
		await cleanup();
		wake?.();
		const after = liveSnapshot(realHome);
		const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
		if (changed.length)
			console.error(`⚠ live ~/.pi/agent changed during the run (yours or the run's?): ${changed.join(", ")}`);
	})();
	return cleaned;
}

// `finally` does not run when a signal ends the process, so a signal halts every started target first.
for (const [sig, code] of [
	["SIGINT", 130],
	["SIGTERM", 143],
] as const)
	process.once(sig, () => {
		console.error(`\n${sig}: stopping every started attempt…`);
		finish().then(
			() => process.exit(code),
			(err) => {
				console.error(err);
				process.exit(code);
			},
		);
	});

/**
 * The records already in the `--resume` file; a line that is not a record with task, coordinator, arm, n, and state is
 * an error.
 */
function resumed(file: string): SummaryRecord[] {
	if (!existsSync(file)) throw new Error(`--resume: no such file ${file}`);
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l, i) => {
			const r = JSON.parse(l);
			if (
				typeof r?.task !== "string" ||
				typeof r.coordinator?.model !== "string" ||
				typeof r.arm !== "string" ||
				typeof r.n !== "number" ||
				!r.state
			)
				throw new Error(`--resume: line ${i + 1} of ${file} is not an attempt record`);
			return r;
		});
}

/**
 * Keeps the Mac awake (`caffeinate -i`) while the runner lives: `-w` ends it with this process, and `finish` kills it.
 * Without caffeinate the run goes on, and the timeout still counts only active time.
 */
function stayAwake(): (() => boolean) | undefined {
	try {
		execFileSync("sh", ["-c", "command -v caffeinate"], { stdio: "ignore" });
	} catch {
		console.error("⚠ caffeinate not found: the machine may sleep during the sweep");
		return undefined;
	}
	const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
	child.on("error", (err) => console.error(`⚠ caffeinate failed: ${err.message}`));
	return () => child.kill();
}

async function main() {
	wake = stayAwake();
	try {
		if (opt["dry-run"]) {
			const ok: boolean[] = [];
			for (const task of tasks)
				for (const { coordinator } of seats.get(task.id)!)
					for (const arm of arms) ok.push(await dryRun(task, coordinator, arm));
			process.exitCode = ok.every(Boolean) ? 0 : 1;
			return;
		}
		const prior = opt.resume ? resumed(out) : [];
		// Interleave coordinators, tasks, and arms (c1 t1 A1, c1 t1 B1, c1 t2 A1, …, c2 t1 A1, …, c1 t1 A2…) so provider
		// drift hits each alike.
		const queue = attemptQueue(
			tasks.map((t) => ({ id: t.id, coordinators: seats.get(t.id)!.map((s) => s.coordinator) })),
			arms,
			runs,
			prior,
		);
		if (opt.resume) console.log(`resume: ${queue.length} attempt(s) left to run in ${out}`);
		mkdirSync(dirname(out), { recursive: true });
		const records: Record<string, any>[] = [];
		const authChecked = new Map<string, Promise<void>>();
		let stopped = "";
		const worker = async () => {
			for (let q = queue.shift(); q && !stopped; q = queue.shift()) {
				const task = taskById.get(q.task)!;
				try {
					const a = await prepare(task, q.coordinator, q.arm, q.n);
					// One serial check per provider refreshes the shared eval login before parallel attempts could race to rotate it.
					const provider = q.coordinator.provider;
					if (!authChecked.has(provider))
						authChecked.set(
							provider,
							Promise.resolve().then(() => {
								execFileSync(pi, ["auth", "check", "--provider", provider], {
									env: a.sandbox.env,
									stdio: "inherit",
								});
							}),
						);
					await authChecked.get(provider);
					const record = await runAttempt(a);
					records.push(record);
					appendFileSync(out, `${JSON.stringify(record)}\n`, { mode: 0o600 });
					console.log(
						`${record.attempt}: ${record.state} check ${record.checkFresh.exit === 0 ? "✓" : "✗"}${record.accepted ? " accepted" : ""}${record.hidden ? ` hidden ${record.hidden.exit === 0 ? "✓" : "✗"}` : ""}${record.pass ? " pass" : ""}${record.headIsWip ? " (HEAD is WIP)" : ""} $${record.cost.total.toFixed(2)}${record.cost.source === "partial" ? "+ (partial)" : ""}`,
					);
					if (record.note === "account") stopped = "account error";
				} catch (err) {
					// No new attempt starts; the ones running finish and are recorded.
					stopped ||= `error in ${task.id} ${coordinatorLabel(q.coordinator)} ${q.arm}${q.n}`;
					throw err;
				}
			}
		};
		const ended = await Promise.allSettled(Array.from({ length: jobs }, worker));
		console.log(`\nrecords: ${out}\npatches: ${artifacts}${stopped ? `\n✗ stopped: ${stopped}` : ""}\n`);
		for (const line of summaryTable([...prior, ...(records as SummaryRecord[])], taskIds, coordinators, arms))
			console.log(line);
		const failed = ended.filter((e): e is PromiseRejectedResult => e.status === "rejected");
		if (failed.length)
			throw new AggregateError(
				failed.map((f) => f.reason),
				`${failed.length} attempt(s) failed`,
			);
	} finally {
		await finish();
	}
}

await main();
