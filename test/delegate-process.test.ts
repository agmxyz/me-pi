import assert from "node:assert/strict";
import test from "node:test";
import { startWorkerProcess, type WorkerProcessOptions } from "../packages/pi-workers/extensions/delegate-process.ts";

interface Run {
	records: Record<string, any>[];
	malformed: string[];
	stderr: string;
	exit: Promise<{ code: number | null; problem?: string }>;
	proc: ReturnType<typeof startWorkerProcess>;
}

/** Runs an inline node script as the worker. */
function run(script: string, opts: Partial<WorkerProcessOptions> = {}): Run {
	const records: Record<string, any>[] = [];
	const malformed: string[] = [];
	let stderr = "";
	let resolveExit!: (v: { code: number | null; problem?: string }) => void;
	const exit = new Promise<{ code: number | null; problem?: string }>((r) => {
		resolveExit = r;
	});
	const proc = startWorkerProcess({
		command: process.execPath,
		args: ["-e", script],
		env: process.env,
		cwd: process.cwd(),
		stdin: "",
		exitGraceMs: 1000,
		termGraceMs: 3000,
		onRecord: (r) => records.push(r),
		onMalformed: (l) => malformed.push(l),
		onStderr: (c) => {
			stderr += c;
		},
		onKillFailure: () => {},
		onExit: (code, problem) => resolveExit({ code, problem }),
		...opts,
	});
	return {
		records,
		malformed,
		get stderr() {
			return stderr;
		},
		exit,
		proc,
	};
}

test("frames JSON lines across chunk boundaries and flushes the trailing partial line", async () => {
	const r = run(`
		const w = (s) => new Promise((ok) => process.stdout.write(s, ok));
		(async () => {
			await w('{"a":');
			await new Promise((ok) => setTimeout(ok, 20));
			await w('1}\\n\\n{"b":2}\\n{"c"');
			await new Promise((ok) => setTimeout(ok, 20));
			await w(':3}');
		})();`);
	const { code, problem } = await r.exit;
	assert.equal(code, 0);
	assert.equal(problem, undefined);
	assert.deepEqual(r.records, [{ a: 1 }, { b: 2 }, { c: 3 }]);
	assert.deepEqual(r.malformed, []);
});

test("reports non-JSON and non-object lines as malformed and captures stderr", async () => {
	const r = run(`process.stdout.write('not json\\n[1]\\nnull\\n{"ok":true}\\n'); process.stderr.write("oops");`);
	await r.exit;
	assert.deepEqual(r.malformed, ["not json", "[1]", "null"]);
	assert.deepEqual(r.records, [{ ok: true }]);
	assert.equal(r.stderr, "oops");
});

test("stop from inside onRecord kills the group, is idempotent, and drops later lines", async () => {
	let proc!: ReturnType<typeof startWorkerProcess>;
	const stops: boolean[] = [];
	const r = run(`process.stdout.write('{"n":1}\\n'); setInterval(() => process.stdout.write('{"n":2}\\n'), 5);`, {
		onRecord: (rec) => {
			r.records.push(rec);
			stops.push(proc.stop("kill"), proc.stop("kill"));
		},
	});
	proc = r.proc;
	const { code } = await r.exit;
	assert.equal(code, null);
	assert.deepEqual(stops.slice(0, 2), [true, false]);
	assert.ok(stops.slice(2).every((s) => !s));
	assert.equal(r.proc.stop("kill"), false, "stop after finish is a no-op");
	const lateBefore = r.records.length;
	await new Promise((ok) => setTimeout(ok, 30));
	assert.equal(r.records.length, lateBefore, "no records after finish");
});

test("term-then-kill sends SIGTERM, then SIGKILL after termGraceMs", async () => {
	const r = run(
		`process.on("SIGTERM", () => console.log(JSON.stringify({ term: true })));
		console.log(JSON.stringify({ ready: true }));
		setInterval(() => {}, 1000);`,
		{ termGraceMs: 500 },
	);
	const onReady = setInterval(() => {
		if (r.records.length) {
			clearInterval(onReady);
			assert.equal(r.proc.stop("term-then-kill"), true);
		}
	}, 5);
	const started = Date.now();
	const { code } = await r.exit;
	assert.ok(Date.now() - started >= 500);
	assert.equal(code, null);
	assert.deepEqual(r.records, [{ ready: true }, { term: true }]);
});

test("a missing command finishes with a start problem and stop is a no-op", async () => {
	const r = run("", { command: "/nonexistent/me-pi-worker" });
	assert.equal(r.proc.stop("kill"), false);
	const { code, problem } = await r.exit;
	assert.equal(code, null);
	assert.match(problem ?? "", /could not start pi: .*ENOENT/);
});
