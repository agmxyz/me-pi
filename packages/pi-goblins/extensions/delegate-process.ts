/**
 * Worker OS process lifecycle: spawn in its own process group, prompt on stdin, JSON-line framing of stdout,
 * stderr capture, group kill, and exit handling. Interpreting records belongs to the caller.
 */
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

// Live worker process groups, shared by reloaded module instances, killed when the main process exits.
const GROUPS_KEY = Symbol.for("me-pi.delegate.groups");

function liveGroups(): Set<number> {
	const shared = globalThis as any;
	if (!shared[GROUPS_KEY]) {
		const groups = new Set<number>();
		shared[GROUPS_KEY] = groups;
		// Runs inside process.on("exit"): synchronous only, so warnings go straight to fd 2.
		process.on("exit", () => {
			for (const pid of groups) {
				const failure = killGroup(pid);
				if (failure) writeSync(2, `delegate: ${failure}\n`);
			}
		});
	}
	return shared[GROUPS_KEY];
}

/** SIGKILLs a worker's process group; returns an error message, or undefined when killed or gone. */
export function killGroup(pid: number): string | undefined {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (err: any) {
		if (err?.code !== "ESRCH") return `SIGKILL to worker group ${pid} failed: ${err?.message ?? err}`;
	}
	return undefined;
}

export type StopMode = "kill" | "term-then-kill";

export interface WorkerProcessOptions {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
	/** Written to stdin, which is then closed. */
	stdin: string;
	/** Timing, passed by the caller so its limits stay the single source. */
	exitGraceMs: number;
	termGraceMs: number;
	/** Each stdout JSON-object line, synchronously in the data handler; it may call stop(). */
	onRecord: (record: Record<string, any>) => void;
	/** A non-empty stdout line that is not a JSON object. */
	onMalformed: (line: string) => void;
	onStderr: (chunk: string) => void;
	/** A failed group kill; the process may still be running. */
	onKillFailure: (message: string) => void;
	/**
	 * Called once, after the trailing partial line is flushed. `problem` is set when the process could not
	 * start or exited while something outside its group still held its output pipes.
	 */
	onExit: (code: number | null, problem?: string) => void;
}

export interface WorkerProcess {
	pid: number | undefined;
	/** Signals the group once; returns false when already stopped, finished, or never started. */
	stop(mode: StopMode): boolean;
}

export function startWorkerProcess(opts: WorkerProcessOptions): WorkerProcess {
	// Detached: the worker leads its own process group, so one SIGKILL stops its children too.
	const proc = spawn(opts.command, opts.args, {
		cwd: opts.cwd,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: opts.env,
	});
	const pid = proc.pid;
	const groups = liveGroups();
	if (pid !== undefined) groups.add(pid);
	let finished = false;
	let stopped = false;
	let buffer = "";
	let termTimer: NodeJS.Timeout | undefined;
	let exitTimer: NodeJS.Timeout | undefined;

	const reportKill = () => {
		const failure = killGroup(pid as number);
		if (failure) opts.onKillFailure(failure);
	};
	const stop = (mode: StopMode): boolean => {
		if (finished || stopped || pid === undefined) return false;
		stopped = true;
		if (mode === "term-then-kill") {
			try {
				process.kill(-pid, "SIGTERM");
			} catch {}
			termTimer = setTimeout(reportKill, opts.termGraceMs);
			return true;
		}
		reportKill();
		return true;
	};
	const processLine = (line: string) => {
		if (finished) return;
		let record: any;
		try {
			record = JSON.parse(line);
		} catch {
			return opts.onMalformed(line);
		}
		if (!record || typeof record !== "object" || Array.isArray(record)) return opts.onMalformed(line);
		opts.onRecord(record);
	};
	const finish = (code: number | null, problem?: string) => {
		if (finished) return;
		if (buffer.trim()) processLine(buffer);
		finished = true;
		clearTimeout(exitTimer);
		clearTimeout(termTimer);
		proc.stdout.destroy();
		proc.stderr.destroy();
		if (pid !== undefined) groups.delete(pid);
		opts.onExit(code, problem);
	};

	proc.stdout.setEncoding("utf8");
	proc.stderr.setEncoding("utf8");
	proc.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) if (line.trim()) processLine(line);
	});
	proc.stderr.on("data", (chunk: string) => {
		if (!finished) opts.onStderr(chunk);
	});
	proc.stdin.on("error", () => {}); // EPIPE when the worker dies before reading; exit reports why.
	proc.stdin.end(opts.stdin);
	proc.on("exit", (code) => {
		// Leftover children in the group are killed; a process outside it may still hold the pipes.
		if (pid !== undefined) killGroup(pid);
		exitTimer = setTimeout(() => finish(code, "worker exited but its output pipes stayed open"), opts.exitGraceMs);
	});
	proc.on("close", (code) => finish(code));
	proc.on("error", (err) => finish(null, `could not start pi: ${err.message}`));
	return { pid, stop };
}
