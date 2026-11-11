import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main, type Result, type Runner } from "../skills/batch-chief/batch.ts";

// Every effect goes through a fake runner; files live under a temp dir, never the real ~/.pi or this checkout.
const ROOT = mkdtempSync(join(tmpdir(), "batch-chief-test-"));
process.env.HOME = ROOT;
process.env.TMPDIR = ROOT;
process.env.PI_CODING_AGENT_DIR = join(ROOT, "agent");
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));

const SHA = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";
const MOVED = "3333333333333333333333333333333333333333";
const RULES = JSON.stringify([
	{
		type: "required_status_checks",
		parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "check" }] },
	},
	{ type: "pull_request", parameters: { allowed_merge_methods: ["squash"] } },
]);

let fixtures = 0;

/** A run fixture: a repo directory, a fake runner for git, gh and the clock, and the run's files. */
function fixture() {
	const dir = join(ROOT, `f${fixtures++}`);
	const repo = join(dir, "repo");
	mkdirSync(repo, { recursive: true });
	let now = new Date("2026-11-11T10:00:00.000Z");
	const calls: string[] = [];
	const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });
	const state = {
		rules: ok(RULES) as Result,
		prs: {} as Record<string, object>,
	};
	const runner: Runner = {
		now: () => now,
		exec(cmd, args) {
			const line = [cmd, ...args].join(" ");
			calls.push(line);
			if (line === "git rev-parse --path-format=absolute --git-common-dir") return ok(`${repo}/.git\n`);
			if (line === "git rev-parse --abbrev-ref HEAD") return ok("main\n");
			if (line === "git rev-parse HEAD") return ok(`${SHA}\n`);
			if (line === "git status --porcelain") return ok("");
			if (args[0] === "--version") return ok(`${cmd} 1.0\n`);
			if (line === "gh api repos/{owner}/{repo}/rules/branches/main") return state.rules;
			const view = /^gh pr view (\S+) --json /.exec(line);
			if (view) {
				const pr = state.prs[view[1]];
				return pr
					? ok(JSON.stringify(pr))
					: { code: 1, stdout: "", stderr: `no pull requests found for branch "${view[1]}"` };
			}
			return { code: 1, stdout: "", stderr: `fake runner: unexpected ${line}` };
		},
	};
	const run = (...argv: string[]) => main(argv, runner, repo);
	const batch = join(`${repo}.worktrees`, ".batch");
	const runDir = () => join(batch, readFileSync(join(batch, "current"), "utf8").trim());
	const events = () =>
		readFileSync(join(runDir(), "events.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	const at = (time: string) => {
		now = new Date(`2026-11-11T${time}:00.000Z`);
	};
	const brief = join(dir, "brief.md");
	writeFileSync(brief, "# Brief\n\n- The test may use a fake clock.\n");
	const report = (n: number, status: string, time: string) => {
		const path = join(dir, `report-${n}.md`);
		writeFileSync(path, `# Report ${n}\n\n## Status\n\n${status}\n\n## PR\n\nnone\n`);
		const date = new Date(`2026-11-11T${time}:00.000Z`);
		utimesSync(path, date, date);
		return path;
	};
	const preflight = (tickets = "5,6") =>
		run("preflight", "--repo", repo, "--tickets", tickets, "--check", "npm test", "--chief-pane", "w1:p1");
	const launch = (n: number) =>
		run(
			"event",
			String(n),
			"launch",
			"--worktree",
			join(dir, `t${n}`),
			"--branch",
			`feat/t${n}`,
			"--pane",
			`w1:p${n}`,
			"--session",
			join(dir, `s${n}.jsonl`),
			"--brief",
			brief,
			"--report",
			join(dir, `report-${n}.md`),
			"--deadline",
			"20",
		);
	/** Appends an event the way `gate` or `merge` would, so rows can start GATED without those commands. */
	const append = (event: object) => appendFileSync(join(runDir(), "events.jsonl"), `${JSON.stringify(event)}\n`);
	return { dir, repo, run, runDir, events, at, brief, report, preflight, launch, append, calls, state };
}

type Fixture = ReturnType<typeof fixture>;

function assertOk(result: { code: number; out: string }) {
	assert.equal(result.code, 0, result.out);
	return result.out;
}

function assertRefused(result: { code: number; out: string }, ...parts: string[]) {
	assert.equal(result.code, 1, `expected a refusal, got: ${result.out}`);
	for (const part of parts) assert.ok(result.out.includes(part), `${JSON.stringify(result.out)} lacks ${part}`);
}

/** The status line of row `n`, e.g. `#5 RUNNING(implement)`. */
function rowLine(f: Fixture, n: number) {
	const out = assertOk(f.run("status"));
	const line = out.split("\n").find((l) => l.startsWith(`#${n} `));
	assert.ok(line, `no row #${n} in ${out}`);
	return line;
}

/** Launches #5, reports it DONE at 10:05 and gates it at HEAD via an appended `gate` event. */
function gated(f: Fixture) {
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:04")));
	f.at("10:06");
	f.append({ at: "2026-11-11T10:06:00.000Z", type: "gate", ticket: 5, sha: HEAD });
	f.state.prs["feat/t5"] = { number: 12, state: "OPEN", headRefOid: HEAD, url: "https://example.invalid/pr/12" };
}

test("preflight records base, cleanliness, tools and rules, and starts every row QUEUED", () => {
	const f = fixture();
	assertOk(f.preflight());
	const [first] = f.events();
	assert.equal(first.type, "preflight");
	assert.equal(first.base, "main");
	assert.equal(first.sha, SHA);
	assert.equal(first.clean, true);
	assert.deepEqual(first.tools, { git: true, gh: true, herdr: true });
	assert.deepEqual(first.rules, { requiredChecks: ["check"], upToDate: true, mergeMethods: ["squash"] });
	assert.deepEqual(first.tickets, [5, 6]);
	assert.match(rowLine(f, 5), /^#5 QUEUED next: chief/);
	assert.match(rowLine(f, 6), /^#6 QUEUED next: chief/);
});

test("a failed rules read is recorded as unknown, never as no rules", () => {
	const f = fixture();
	f.state.rules = { code: 1, stdout: "", stderr: "HTTP 403: Resource not accessible" };
	assertOk(f.preflight());
	const [first] = f.events();
	assert.equal(first.rules, "unknown");
	assert.match(first.rulesError, /HTTP 403/);
	assert.match(readLedger(f), /rules: unknown/);
});

function readLedger(f: Fixture) {
	assertOk(f.run("status"));
	return readFileSync(join(f.runDir(), "ledger.md"), "utf8");
}

test("launch moves QUEUED to RUNNING(implement) with a deadline", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	assert.match(rowLine(f, 5), /^#5 RUNNING\(implement\) next: coordinator, deadline 2026-11-11T10:20:00\.000Z$/);
	f.at("10:21");
	assert.match(rowLine(f, 5), /deadline 2026-11-11T10:20:00\.000Z OVERDUE$/);
});

test("a DONE report moves RUNNING to REPORTED; a BLOCKED one to ASKED(chief)", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	assertOk(f.launch(6));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:04")));
	assertOk(f.run("event", "6", "report", "--path", f.report(6, "BLOCKED", "10:04")));
	assert.match(rowLine(f, 5), /^#5 REPORTED next: chief$/);
	assert.match(rowLine(f, 6), /^#6 ASKED\(chief\) next: chief$/);
});

test("a chief answer quoting the brief, an escalation and a user answer each return the row to RUNNING", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "BLOCKED", "10:04")));
	assertRefused(f.run("event", "5", "answer", "--basis", "a line the brief lacks"), "not in the brief");
	assertOk(f.run("event", "5", "answer", "--basis", "The test may use a fake clock."));
	assert.match(rowLine(f, 5), /^#5 RUNNING\(implement\) next: coordinator, deadline 2026-11-11T10:25:00\.000Z$/);
	f.at("10:10");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "BLOCKED", "10:09")));
	assertOk(f.run("event", "5", "escalate"));
	assert.match(rowLine(f, 5), /^#5 ASKED\(user\) next: user$/);
	assertOk(f.run("event", "5", "answer", "--user", "use option B"));
	assert.match(rowLine(f, 5), /^#5 RUNNING\(implement\) next: coordinator/);
});

test("a second chief answer on one ticket is refused: the question goes to the user", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "BLOCKED", "10:04")));
	assertOk(f.run("event", "5", "answer", "--basis", "The test may use a fake clock."));
	f.at("10:10");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "BLOCKED", "10:09")));
	assertRefused(
		f.run("event", "5", "answer", "--basis", "The test may use a fake clock."),
		"already had a chief answer",
		"event 5 escalate",
	);
	assert.match(rowLine(f, 5), /^#5 ASKED\(chief\)/);
	assert.ok(!assertOk(f.run("status")).includes("answer --basis"), "status still offers a chief answer");
});

test("a round from REPORTED or GATED moves the row to RUNNING(round)", () => {
	const f = fixture();
	gated(f);
	assertOk(f.run("event", "5", "round", "fix", "--deadline", "30"));
	assert.match(rowLine(f, 5), /^#5 RUNNING\(fix\) next: coordinator, deadline 2026-11-11T10:36:00\.000Z$/);
	f.at("10:40");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:39")));
	assertOk(f.run("event", "5", "round", "review", "--deadline", "15"));
	assert.match(rowLine(f, 5), /^#5 RUNNING\(review\)/);
});

test("a gated row whose PR head moved returns to REPORTED", () => {
	const f = fixture();
	gated(f);
	assert.match(rowLine(f, 5), new RegExp(`^#5 GATED\\(${HEAD}\\) next: user, then chief$`));
	f.state.prs["feat/t5"] = { number: 12, state: "OPEN", headRefOid: MOVED };
	assert.match(rowLine(f, 5), /^#5 REPORTED next: chief$/);
	assert.equal(f.events().at(-1).type, "head-moved");
	assert.equal(f.events().at(-1).head, MOVED);
});

test("a gated row whose PR GitHub reports merged becomes MERGED", () => {
	const f = fixture();
	gated(f);
	f.state.prs["feat/t5"] = { number: 12, state: "MERGED", headRefOid: HEAD, mergeCommit: { oid: MOVED } };
	assert.match(rowLine(f, 5), /^#5 MERGED next: nobody$/);
	assert.equal(f.events().at(-1).commit, MOVED);
});

test("leave-open and drop end a row", () => {
	const f = fixture();
	gated(f);
	assertOk(f.run("event", "5", "leave-open"));
	assert.match(rowLine(f, 5), /^#5 LEFT_OPEN next: nobody$/);
	assertRefused(f.run("event", "6", "drop"), "--user");
	assertOk(f.run("event", "6", "drop", "--user", "drop 6, not needed"));
	assert.match(rowLine(f, 6), /^#6 DROPPED next: nobody$/);
});

test("illegal transitions are refused, naming the row's state and the events it accepts", () => {
	const f = fixture();
	gated(f);
	assertRefused(
		f.run("event", "6", "report", "--path", f.report(6, "DONE", "10:06")),
		"#6 is QUEUED",
		"accepts: launch, drop",
	);
	assertOk(f.run("event", "5", "round", "update", "--deadline", "10"));
	assertRefused(f.run("event", "5", "leave-open"), "#5 is RUNNING(update)", "accepts: report, drop");
	assertOk(f.run("event", "6", "drop", "--user", "not now"));
	assertRefused(f.run("event", "6", "launch", ...launchOptions(f, 6)), "#6 is DROPPED", "accepts: nothing");
	assert.equal(f.events().filter((e) => e.ticket === 6).length, 1, "a refused event was recorded");
});

function launchOptions(f: Fixture, n: number) {
	return [
		...["--worktree", join(f.dir, `t${n}`), "--branch", `feat/t${n}`, "--pane", `w1:p${n}`],
		...["--session", join(f.dir, `s${n}.jsonl`), "--brief", f.brief, "--report", join(f.dir, `r${n}.md`)],
		...["--deadline", "20"],
	];
}

test("events recorded by their own commands are refused through event", () => {
	const f = fixture();
	gated(f);
	assertRefused(f.run("event", "5", "merged"), "not recorded through event");
});

test("status records a report file newer than the row's last event, and ignores an older one", () => {
	const f = fixture();
	assertOk(f.preflight());
	f.report(5, "DONE", "09:59");
	assertOk(f.launch(5));
	f.at("10:03");
	assert.match(rowLine(f, 5), /^#5 RUNNING/);
	f.report(5, "BLOCKED", "10:02");
	f.at("10:04");
	assert.match(rowLine(f, 5), /^#5 ASKED\(chief\)/);
	assert.equal(f.events().at(-1).type, "report");
	assert.equal(f.events().at(-1).status, "BLOCKED");
});

test("a crash between merge intent and observation is reconciled by status without a second merge", () => {
	const f = fixture();
	gated(f);
	f.append({ at: "2026-11-11T10:07:00.000Z", type: "merge-intent", ticket: 5, sha: HEAD });
	f.state.prs["feat/t5"] = { number: 12, state: "MERGED", headRefOid: HEAD, mergeCommit: { oid: MOVED } };
	f.at("10:08");
	assert.match(rowLine(f, 5), /^#5 MERGED next: nobody$/);
	assertOk(f.run("status"));
	assert.equal(f.events().filter((e) => e.type === "merged").length, 1);
	assert.deepEqual(
		f.calls.filter((c) => c.startsWith("gh pr merge")),
		[],
	);
});

test("a pending merge intent on an unmerged PR is listed, not repeated", () => {
	const f = fixture();
	gated(f);
	f.append({ at: "2026-11-11T10:07:00.000Z", type: "merge-intent", ticket: 5, sha: HEAD });
	const out = assertOk(f.run("status"));
	assert.match(out, new RegExp(`merge intent at ${HEAD} pending`));
	assert.match(rowLine(f, 5), /^#5 GATED/);
});

test("approve and note are recorded; unknown kinds and tickets are refused", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.run("approve", "--quote", "merge 5 and 6", "--action", "merge", "--tickets", "5,6"));
	assertOk(f.run("approve", "--quote", "ship it", "--action", "merge", "--tickets", "5", "--inferred"));
	assertRefused(f.run("approve", "--quote", "merge 7", "--action", "merge", "--tickets", "7"), "#7 is not a row");
	assertOk(f.run("note", "--kind", "gate-miss", "--ticket", "5", "CI ran on the old head"));
	assertRefused(f.run("note", "--kind", "gripe", "--ticket", "5", "x"), "manual-fix");
	const approvals = f.events().filter((e) => e.type === "approve");
	assert.deepEqual(
		approvals.map((e) => [e.quote, e.action, e.tickets, e.inferred]),
		[
			["merge 5 and 6", "merge", [5, 6], false],
			["ship it", "merge", [5], true],
		],
	);
	const ledger = readLedger(f);
	assert.match(ledger, /"merge 5 and 6"/);
	assert.match(ledger, /gate-miss #5: CI ran on the old head/);
});

test("ledger.md is regenerated by status, not appended", () => {
	const f = fixture();
	assertOk(f.preflight());
	const first = readLedger(f);
	assert.match(first.split("\n")[0], /generated/i);
	appendFileSync(join(f.runDir(), "ledger.md"), "hand edit\n");
	const second = readLedger(f);
	assert.equal(second, first);
	assertOk(f.launch(5));
	const third = readLedger(f);
	assert.equal(third.split("\n").filter((l) => /generated/i.test(l)).length, 1);
	assert.match(third, /\| #5 \| RUNNING\(implement\) \|/);
	assert.ok(!third.includes("| #5 | QUEUED |"), third);
});
