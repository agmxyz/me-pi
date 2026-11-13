import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepare } from "../packages/pi-workers/extensions/delegate-implement.ts";
import registerGuard from "../packages/pi-workers/extensions/guard.ts";
import { dialogVisible, implementLock, main, type Result, type Runner } from "../skills/batch-chief/batch.ts";

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
		/** Per-command-line answers that win over the defaults below. */
		exec: {} as Record<string, Result | (() => Result)>,
	};
	const runner: Runner = {
		now: () => now,
		exec(cmd, args) {
			const line = [cmd, ...args].join(" ");
			calls.push(line);
			const answer = state.exec[line];
			if (answer) return typeof answer === "function" ? answer() : answer;
			if (cmd === "sleep") return ok();
			if (line === "git rev-parse --path-format=absolute --git-common-dir") return ok(`${repo}/.git\n`);
			if (line === "git rev-parse --abbrev-ref HEAD") return ok("main\n");
			if (line === "git rev-parse HEAD") return ok(`${SHA}\n`);
			if (line === "git status --porcelain") return ok("");
			if (args[0] === "--version") return ok(`${cmd} 1.0\n`);
			if (line === "gh api repos/{owner}/{repo}/rules/branches/main") return state.rules;
			// origin's base is where the main checkout is, and no other remote branch is left.
			if (line === "git ls-remote origin refs/heads/main") return ok(`${SHA}\trefs/heads/main\n`);
			if (/^git ls-remote origin refs\/heads\/\S+$/.test(line)) return ok("");
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
	const report = (n: number | string, status: string, time: string) => {
		const path = join(dir, `report-${n}.md`);
		writeFileSync(path, `# Report ${n}\n\n## Status\n\n${status}\n\n## PR\n\nnone\n`);
		const date = new Date(`2026-11-11T${time}:00.000Z`);
		utimesSync(path, date, date);
		return path;
	};
	const preflight = (tickets = "5,6") =>
		run("preflight", "--repo", repo, "--tickets", tickets, "--check", "npm test", "--chief-pane", "w1:p1");
	const launch = (n: number | string) =>
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
function rowLine(f: Fixture, n: number | string) {
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

test("status prints pane, worktree, branch and session file of each launched row, and none for a queued row", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	const out = assertOk(f.run("status"));
	const lines = out.split("\n");
	const at = lines.findIndex((l) => l.startsWith("#5 "));
	assert.ok(
		lines.includes(
			`  launched: pane w1:p5, worktree ${join(f.dir, "t5")}, branch feat/t5, session ${join(f.dir, "s5.jsonl")}`,
		),
		out,
	);
	assert.ok(lines.findIndex((l) => l.startsWith("  launched:")) > at, out);
	assert.equal(lines.filter((l) => l.startsWith("  launched:")).length, 1, out);
});

test("status records nothing for an ATTEMPT FAILED line in the panes, unlike a report", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("10:05");
	const before = assertOk(f.run("status"));
	const events = f.events().length;
	const line = "[coordinator 5] ATTEMPT FAILED: provider error on the implement job";
	for (const pane of ["w1:p1", "w1:p5"]) f.state.exec[`herdr agent read ${pane} --source visible`] = ok(`${line}\n> `);
	const calls = f.calls.length;
	const after = assertOk(f.run("status"));
	assert.equal(after, before);
	assert.equal(f.events().length, events, "status recorded an event");
	assert.match(rowLine(f, 5), /^#5 RUNNING\(implement\)/);
	assert.ok(!f.calls.slice(calls).some((c) => c.startsWith("herdr ")), "status read a pane");
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
	assertRefused(
		f.run("event", "5", "merged"),
		"not recorded through event",
		`#5 is GATED(${HEAD})`,
		"it accepts: round, head-moved, merge-intent, merged, leave-open, drop",
	);
	assertRefused(
		f.run("event", "5", "frobnicate"),
		"unknown event frobnicate",
		`#5 is GATED(${HEAD})`,
		"it accepts: round, head-moved, merge-intent, merged, leave-open, drop",
	);
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

test("approve --question is stored in the event and shown in the ledger", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(
		f.run("approve", "--quote", "yes, push", "--question", "push 5 and 6?", "--action", "push", "--tickets", "5,6"),
	);
	const [e] = f.events().filter((x) => x.type === "approve");
	assert.equal(e.question, "push 5 and 6?");
	assert.match(readLedger(f), /push #5, #6: "yes, push" answering "push 5 and 6\?"/);
});

test("approve --prs resolves each PR through a row's branch and refuses a PR no row owns", () => {
	const f = fixture();
	assertOk(f.preflight("5,6,7"));
	assertOk(f.launch(5));
	assertOk(f.launch(6));
	f.state.prs["feat/t5"] = { number: 12 };
	f.state.prs["feat/t6"] = { number: 13 };
	assertOk(f.run("approve", "--quote", "merge 13 and 12", "--action", "merge", "--prs", "13,12"));
	const [e] = f.events().filter((x) => x.type === "approve");
	assert.deepEqual(e.tickets, [6, 5]);
	assertRefused(
		f.run("approve", "--quote", "merge 14", "--action", "merge", "--prs", "12,14"),
		"PR #14 is not the PR of any row",
		"#12 (#5)",
	);
	assertRefused(
		f.run("approve", "--quote", "x", "--action", "merge", "--prs", "12", "--tickets", "5"),
		"--tickets or --prs",
	);
	assert.equal(f.events().filter((x) => x.type === "approve").length, 1);
});

test("launch is refused while only an inferred push approval covers the row", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.run("approve", "--quote", "ship them all", "--action", "push", "--tickets", "5,6", "--inferred"));
	assertRefused(
		f.launch(5),
		"only an inferred push approval covers #5; confirm it with the user and record their words with approve (without --inferred)",
	);
	assert.match(rowLine(f, 5), /^#5 QUEUED/);
	assertOk(f.run("approve", "--quote", "yes, push 5", "--action", "push", "--tickets", "5"));
	assertOk(f.launch(5));
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

test("note regenerates ledger.md without status, not appended", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.run("note", "--kind", "manual-fix", "--ticket", "5", "fixed the lockfile"));
	const ledger = join(f.runDir(), "ledger.md");
	const calls = f.calls.length;
	assert.ok(existsSync(ledger), "note wrote no ledger.md");
	const first = readFileSync(ledger, "utf8");
	assert.match(first, /manual-fix #5: fixed the lockfile/);
	appendFileSync(ledger, "hand edit\n");
	assertOk(f.run("note", "--kind", "gate-miss", "--ticket", "6", "CI ran on the old head"));
	const second = readFileSync(ledger, "utf8");
	assert.ok(!second.includes("hand edit"), second);
	assert.equal(second.split("\n").filter((l) => /generated/i.test(l)).length, 1);
	assert.match(second, /manual-fix #5: fixed the lockfile\n- gate-miss #6: CI ran on the old head/);
	assert.ok(!f.calls.slice(calls).some((c) => c.startsWith("gh ")), "note reached GitHub");
	assert.ok(!f.calls.slice(calls).some((c) => c.startsWith("herdr ")), "note reached herdr");
});

test("a ledger written by note shows a pending merge intent from the event log", () => {
	const f = fixture();
	gated(f);
	f.append({ at: "2026-11-11T10:07:00.000Z", type: "merge-intent", ticket: 5, sha: HEAD });
	assertOk(f.run("note", "--kind", "manual-fix", "--ticket", "6", "fixed the lockfile"));
	const ledger = readFileSync(join(f.runDir(), "ledger.md"), "utf8");
	assert.match(ledger, new RegExp(`\\| #5 \\|.*merge intent at ${HEAD} pending since 2026-11-11T10:07:00.000Z`));
});

test("a ledger written by note says the outside was not checked and names note", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.run("note", "--kind", "manual-fix", "--ticket", "5", "fixed the lockfile"));
	const byNote = readFileSync(join(f.runDir(), "ledger.md"), "utf8");
	assert.match(byNote.split("\n")[0], /Generated by batch\.ts note from events\.jsonl /);
	assert.match(byNote, /\| #5 \|.*outside not checked \(written by note\); run status \|/);
});

test("a ledger written by status names status and does not say the outside was not checked", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.run("note", "--kind", "manual-fix", "--ticket", "5", "fixed the lockfile"));
	const byStatus = readLedger(f);
	assert.match(byStatus.split("\n")[0], /Generated by batch\.ts status from events\.jsonl /);
	assert.ok(!byStatus.includes("not checked"), byStatus);
});

test("a row is a ticket number or a label, and every row command takes a label", () => {
	const f = fixture();
	assertOk(f.preflight("5,release,skill-pr-2"));
	assert.deepEqual(f.events()[0].tickets, [5, "release", "skill-pr-2"]);
	assert.match(rowLine(f, "release"), /^#release QUEUED next: chief/);
	assertOk(f.launch("release"));
	assertOk(f.run("approve", "--quote", "merge 5 and the release", "--action", "merge", "--tickets", "5,release"));
	assertOk(f.run("note", "--kind", "user-friction", "--ticket", "release", "typed in the pane"));
	assertRefused(f.run("event", "nope", "drop", "--user", "x"), "nope is not a row");
	assertOk(f.run("event", "skill-pr-2", "drop", "--user", "not now"));
	assert.match(rowLine(f, "release"), /^#release RUNNING\(implement\)/);
	const ledger = readLedger(f);
	assert.match(ledger, /\| #release \| RUNNING\(implement\) \|/);
	assert.match(ledger, /merge #5, #release/);
	assert.match(ledger, /user-friction #release: typed in the pane/);
});

test("an invalid or repeated row id is refused", () => {
	for (const tickets of ["Release", "-x", "rel_ease", "a b", "1abc", "05", "a-", "x".repeat(33), "release,release"]) {
		const f = fixture();
		assertRefused(f.preflight(tickets), "--tickets");
		assert.ok(!existsSync(join(`${f.repo}.worktrees`, ".batch", "current")), `${tickets} created a run`);
	}
});

// ---------------------------------------------------------------------------------------------------------------
// Effect commands: gate, merge, prompt, cleanup.

const PASSED = [{ __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "SUCCESS" }];
const ok = (stdout = ""): Result => ({ code: 0, stdout, stderr: "" });

/** A PR for #5 that passes every fetched fact of the gate at HEAD. */
function goodPr(over: object = {}) {
	return {
		number: 12,
		state: "OPEN",
		headRefOid: HEAD,
		baseRefName: "main",
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		statusCheckRollup: PASSED,
		body: "Adds the thing.\n\nCloses #5\n",
		files: [{ path: "src/a.ts", additions: 3, deletions: 1 }],
		url: "https://example.invalid/pr/12",
		...over,
	};
}

/** Launches #5 and reports it DONE; its worktree is clean and its tip is HEAD. */
function reported(f: Fixture) {
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:04")));
	const wt = join(f.dir, "t5");
	mkdirSync(wt, { recursive: true });
	f.state.exec[`git -C ${wt} status --porcelain`] = ok();
	f.state.exec[`git -C ${wt} rev-parse HEAD`] = ok(`${HEAD}\n`);
	f.state.prs["feat/t5"] = goodPr();
	return wt;
}

test("gate passes: GATED at the PR head, with fetched, read and taken-on-report parts", () => {
	const f = fixture();
	reported(f);
	const out = assertOk(f.run("gate", "5", "--judged", "diff matches the brief"));
	assert.match(out, /Fetched by this command/);
	assert.match(out, /Read by the chief:\n\s*diff matches the brief/);
	assert.match(out, /Taken on report \(not verified\)/);
	assert.match(out, /src\/a\.ts \+3 -1/);
	assert.ok(!/FAIL/.test(out), out);
	assert.deepEqual([f.events().at(-1).type, f.events().at(-1).sha], ["gate", HEAD]);
	assert.match(rowLine(f, 5), new RegExp(`^#5 GATED\\(${HEAD}\\)`));
});

test("gate with a dirty worktree prints what failed and leaves the row REPORTED", () => {
	const f = fixture();
	const wt = reported(f);
	f.state.exec[`git -C ${wt} status --porcelain`] = ok(" M src/a.ts\n");
	const result = f.run("gate", "5", "--judged", "looks fine");
	assertRefused(result);
	assert.match(result.out, /FAIL: worktree [^\n]* is not clean[\s\S]*src\/a\.ts/);
	assert.notEqual(f.events().at(-1).type, "gate");
	assert.match(rowLine(f, 5), /^#5 REPORTED/);
});

test("gate fails when required checks have not passed on the head or the body does not close the ticket", () => {
	const f = fixture();
	reported(f);
	f.state.prs["feat/t5"] = goodPr({
		statusCheckRollup: [{ __typename: "CheckRun", name: "check", status: "IN_PROGRESS", conclusion: "" }],
		body: "no trailer",
	});
	const result = f.run("gate", "5", "--judged", "ok");
	assertRefused(result);
	assert.match(result.out, /FAIL: required check check has not passed/);
	assert.match(result.out, /FAIL: body does not close #5/);
	assert.match(rowLine(f, 5), /^#5 REPORTED/);
});

test("gate fails a ticket row whose PR body does not close it", () => {
	const f = fixture();
	reported(f);
	f.state.prs["feat/t5"] = goodPr({ body: "no trailer" });
	const result = f.run("gate", "5", "--judged", "ok");
	assertRefused(result, "FAIL: body does not close #5");
	assert.ok(!/SKIP/.test(result.out), result.out);
	assert.match(rowLine(f, 5), /^#5 REPORTED/);
});

test("gate on a label row skips the closing-keyword check and says so", () => {
	const f = fixture();
	assertOk(f.preflight("5,release"));
	assertOk(f.launch("release"));
	f.at("10:05");
	assertOk(f.run("event", "release", "report", "--path", f.report("release", "DONE", "10:04")));
	const wt = join(f.dir, "trelease");
	f.state.exec[`git -C ${wt} status --porcelain`] = ok();
	f.state.exec[`git -C ${wt} rev-parse HEAD`] = ok(`${HEAD}\n`);
	f.state.prs["feat/trelease"] = goodPr({ body: "Release 1.2.0." });
	const out = assertOk(f.run("gate", "release", "--judged", "changelog matches"));
	const fetched = out.slice(out.indexOf("Fetched by this command"), out.indexOf("Read by the chief"));
	assert.match(fetched, /SKIP: body closing keyword not checked: release is a label row, not a ticket/);
	assert.ok(!/(FAIL|PASS)[^\n]*close/.test(out), out);
	assert.match(rowLine(f, "release"), new RegExp(`^#release GATED\\(${HEAD}\\)`));
});

/** A gated #5 with a merge approval in the user's words. */
function approvedGated(f: Fixture) {
	gated(f);
	f.state.prs["feat/t5"] = goodPr();
	assertOk(f.run("approve", "--quote", "merge 5", "--action", "merge", "--tickets", "5"));
}

const MERGE_CALL = `gh pr merge 12 --squash --match-head-commit ${HEAD}`;

function mergeCalls(f: Fixture) {
	return f.calls.filter((c) => c.startsWith("gh pr merge"));
}

test("merge is refused without an approval", () => {
	const f = fixture();
	gated(f);
	f.state.prs["feat/t5"] = goodPr();
	assertRefused(f.run("merge", "5"), "no merge approval");
	assert.deepEqual(mergeCalls(f), []);
});

test("merge is refused with only an inferred approval", () => {
	const f = fixture();
	gated(f);
	f.state.prs["feat/t5"] = goodPr();
	assertOk(f.run("approve", "--quote", "ship them", "--action", "merge", "--tickets", "5", "--inferred"));
	assertRefused(f.run("merge", "5"), "only an inferred merge approval");
	assert.deepEqual(mergeCalls(f), []);
});

test("merge is refused on a head that moved since the gate", () => {
	const f = fixture();
	approvedGated(f);
	f.state.prs["feat/t5"] = goodPr({ headRefOid: MOVED });
	assertRefused(f.run("merge", "5"), `gated at ${HEAD}`, `head is ${MOVED}`);
	assert.deepEqual(mergeCalls(f), []);
});

test("merge is refused when checks have not passed on the head", () => {
	const f = fixture();
	approvedGated(f);
	f.state.prs["feat/t5"] = goodPr({
		statusCheckRollup: [{ __typename: "CheckRun", name: "check", status: "COMPLETED", conclusion: "FAILURE" }],
	});
	assertRefused(f.run("merge", "5"), "required check check has not passed");
	assert.deepEqual(mergeCalls(f), []);
});

test("merge on a behind PR updates the branch and returns the row to REPORTED", () => {
	const f = fixture();
	approvedGated(f);
	f.state.prs["feat/t5"] = goodPr({ mergeStateStatus: "BEHIND" });
	f.state.exec["gh pr update-branch 12"] = ok();
	const out = assertOk(f.run("merge", "5"));
	assert.match(out, /gate again when CI finishes on the new head/);
	assert.ok(f.calls.includes("gh pr update-branch 12"));
	assert.deepEqual(mergeCalls(f), []);
	assert.equal(f.events().at(-1).type, "head-moved");
	f.state.prs["feat/t5"] = goodPr({ headRefOid: MOVED });
	assert.match(rowLine(f, 5), /^#5 REPORTED/);
});

test("merge records an intent, merges pinned to the head, and records MERGED with the merge commit", () => {
	const f = fixture();
	approvedGated(f);
	f.state.exec[MERGE_CALL] = () => {
		f.state.prs["feat/t5"] = goodPr({ state: "MERGED", mergeCommit: { oid: MOVED } });
		return ok();
	};
	assertOk(f.run("merge", "5"));
	assert.deepEqual(mergeCalls(f), [MERGE_CALL]);
	assert.deepEqual(
		f
			.events()
			.slice(-2)
			.map((e) => [e.type, e.sha ?? e.commit]),
		[
			["merge-intent", HEAD],
			["merged", MOVED],
		],
	);
	assert.match(rowLine(f, 5), /^#5 MERGED/);
});

test("merge records no MERGED when GitHub does not say merged, and refuses to repeat a pending intent", () => {
	const f = fixture();
	approvedGated(f);
	f.state.exec[MERGE_CALL] = ok();
	assertRefused(f.run("merge", "5"), "not merged");
	assert.equal(f.events().at(-1).type, "merge-intent");
	assert.equal(f.events().filter((e) => e.type === "merged").length, 0);
	assertRefused(f.run("merge", "5"), "pending", "status");
	assert.deepEqual(mergeCalls(f), [MERGE_CALL]);
});

/** Pane `w1:p<n>` runs Pi (or only a shell when not live) and shows `screen`. */
function pane(f: Fixture, n: number, live: boolean, screen = "> ") {
	const id = `w1:p${n}`;
	const procs = live ? [{ argv0: "pi", name: "node", pid: 4242 }] : [{ argv0: "-zsh", name: "zsh", pid: 41 }];
	f.state.exec[`herdr pane process-info --pane ${id}`] = ok(
		JSON.stringify({ result: { process_info: { pane_id: id, foreground_processes: procs } } }),
	);
	f.state.exec[`herdr agent read ${id} --source visible`] = ok(screen);
	return id;
}

const DIALOG =
	"Allow git reset --hard?\n\n  git reset --hard HEAD~1\n\n→ Yes\n  No\n\n↑↓ navigate • enter select • esc cancel\n";

test("prompt sends to a live Pi with no dialog", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	const id = pane(f, 5, true);
	f.state.exec[`herdr agent prompt ${id} please rebase`] = ok();
	f.calls.length = 0;
	assertOk(f.run("prompt", "5", "please rebase"));
	assert.deepEqual(
		f.calls.filter((c) => c.startsWith("herdr")),
		[
			`herdr pane process-info --pane ${id}`,
			`herdr agent read ${id} --source visible`,
			`herdr agent prompt ${id} please rebase`,
		],
	);
});

test("prompt is refused when a dialog is visible in the pane", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	pane(f, 5, true, DIALOG);
	assertRefused(f.run("prompt", "5", "please rebase"), "dialog is visible", "esc");
	assert.ok(!f.calls.some((c) => c.startsWith("herdr agent prompt")));
});

test("prompt is refused on a dead pane", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	pane(f, 5, false);
	assertRefused(f.run("prompt", "5", "please rebase"), "no live Pi");
	assert.ok(!f.calls.some((c) => c.startsWith("herdr agent prompt")));
});

/**
 * A MERGED #5 and a launched, then DROPPED #6, each with a worktree and git dir on disk and a pane that runs Pi
 * until `/quit` is sent. Clears the recorded calls.
 */
function cleanable(f: Fixture) {
	approvedGated(f);
	assertOk(f.launch(6));
	assertOk(f.run("event", "6", "drop", "--user", "not now"));
	f.state.prs["feat/t5"] = goodPr({ state: "MERGED", mergeCommit: { oid: MOVED } });
	assert.match(rowLine(f, 5), /^#5 MERGED/);
	const rows = [5, 6].map((n) => {
		const wt = join(f.dir, `t${n}`);
		const gitDir = join(f.repo, ".git", "worktrees", `t${n}`);
		mkdirSync(wt, { recursive: true });
		mkdirSync(gitDir, { recursive: true });
		const id = pane(f, n, true);
		f.state.exec[`herdr agent prompt ${id} /quit`] = () => {
			pane(f, n, false);
			return ok();
		};
		f.state.exec[`git -C ${wt} rev-parse --path-format=absolute --git-dir`] = ok(`${gitDir}\n`);
		f.state.exec[`git -C ${wt} status --porcelain`] = ok();
		f.state.exec[`git worktree remove ${wt}`] = () => {
			rmSync(wt, { recursive: true });
			return ok();
		};
		f.state.exec[`git rev-parse --verify --quiet refs/heads/feat/t${n}`] = ok(`${HEAD}\n`);
		f.state.exec[`git branch -D feat/t${n}`] = ok();
		f.state.exec[`herdr pane close ${id}`] = ok();
		return { wt, gitDir, id };
	});
	f.calls.length = 0;
	return rows;
}

const EFFECT = /^(herdr agent prompt|herdr pane close|git worktree|git branch)/;

test("cleanup quits each coordinator, then removes the worktree, deletes a merged branch, and closes the pane", () => {
	const f = fixture();
	const [r5, r6] = cleanable(f);
	assertOk(f.run("note", "--kind", "manual-fix", "--ticket", "5", "fixed a typo by hand"));
	const out = assertOk(f.run("cleanup"));
	assert.deepEqual(
		f.calls.filter((c) => EFFECT.test(c)),
		[
			`herdr agent prompt ${r5.id} /quit`,
			`git worktree remove ${r5.wt}`,
			"git branch -D feat/t5",
			`herdr pane close ${r5.id}`,
			`herdr agent prompt ${r6.id} /quit`,
			`git worktree remove ${r6.wt}`,
			`herdr pane close ${r6.id}`,
		],
	);
	assert.ok(!f.calls.some((c) => c.includes("kill")));
	assert.match(out, /manual-fix #5: fixed a typo by hand/);
	assert.match(out, /Resources left:\n- #6 branch feat\/t6: kept, the PR is not merged$/);
});

test("cleanup --dry-run changes nothing and prints what it would do", () => {
	const f = fixture();
	const [r5] = cleanable(f);
	const out = assertOk(f.run("cleanup", "--dry-run"));
	assert.deepEqual(
		f.calls.filter((c) => EFFECT.test(c)),
		[],
	);
	assert.ok(existsSync(r5.wt));
	assert.ok(out.includes(`would run: git worktree remove ${r5.wt}`), out);
	assert.ok(out.includes(`would run: herdr agent prompt ${r5.id} /quit`), out);
});

test("cleanup leaves a dirty worktree and a row with a present lock, and lists them", () => {
	const f = fixture();
	const [r5, r6] = cleanable(f);
	f.state.exec[`git -C ${r5.wt} status --porcelain`] = ok("?? scratch.txt\n");
	writeFileSync(join(r6.gitDir, "me-pi-implement.lock"), "");
	const out = assertOk(f.run("cleanup"));
	assert.deepEqual(
		f.calls.filter((c) => /^(git worktree remove|git branch -D|herdr pane close)/.test(c)),
		[],
	);
	assert.ok(existsSync(r5.wt) && existsSync(r6.wt));
	assert.match(out, /Resources left:[\s\S]*#5 [^\n]*not clean[^\n]*scratch\.txt/);
	assert.match(out, /Resources left:[\s\S]*#6 [^\n]*me-pi-implement\.lock/);
});

// ---------------------------------------------------------------------------------------------------------------
// Review fixes.

test("status lists gate on a REPORTED row and merge on a GATED row, and neither elsewhere", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	const gateLine = 'allowed: gate 5 --judged "<your note on the diff>"';
	const mergeLine = "allowed: merge 5";
	let out = assertOk(f.run("status"));
	assert.ok(!out.includes("gate 5") && !out.includes(mergeLine), out);
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "DONE", "10:04")));
	out = assertOk(f.run("status"));
	assert.ok(out.includes(gateLine), out);
	assert.ok(!out.includes(mergeLine), out);
	f.append({ at: "2026-11-11T10:06:00.000Z", type: "gate", ticket: 5, sha: HEAD });
	f.state.prs["feat/t5"] = goodPr();
	out = assertOk(f.run("status"));
	assert.ok(out.includes(mergeLine), out);
	assert.ok(!out.includes("gate 5"), out);
	assert.ok(!/allowed: (gate|merge) 6/.test(out), out);
});

test("a chief answer's basis must be one whole line of the brief, not a fragment", () => {
	const f = fixture();
	writeFileSync(f.brief, "# Brief\n\n- The test may use a fake clock.\n1. Keep   the old name.\n");
	assertOk(f.preflight());
	assertOk(f.launch(5));
	assertOk(f.launch(6));
	f.at("10:05");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "BLOCKED", "10:04")));
	assertOk(f.run("event", "6", "report", "--path", f.report(6, "BLOCKED", "10:04")));
	assertRefused(f.run("event", "5", "answer", "--basis", "the"), "as a whole line");
	assertRefused(f.run("event", "5", "answer", "--basis", "may use a fake clock."), "as a whole line");
	assertOk(f.run("event", "5", "answer", "--basis", "The test may use a fake clock."));
	assertOk(f.run("event", "6", "answer", "--basis", "Keep the old name."));
});

test("cleanup leaves and lists a row whose Pi still runs after /quit, removing nothing", () => {
	const f = fixture();
	const [r5, r6] = cleanable(f);
	f.state.exec[`herdr agent prompt ${r5.id} /quit`] = ok();
	const out = assertOk(f.run("cleanup"));
	assert.deepEqual(
		f.calls.filter((c) => EFFECT.test(c)),
		[
			`herdr agent prompt ${r5.id} /quit`,
			`herdr agent prompt ${r6.id} /quit`,
			`git worktree remove ${r6.wt}`,
			`herdr pane close ${r6.id}`,
		],
	);
	assert.ok(existsSync(r5.wt));
	assert.ok(!f.calls.some((c) => c.includes("kill")));
	assert.match(out, new RegExp(`Resources left:\\n- #5 [^\\n]*Pi still runs in pane ${r5.id} after /quit`));
});

test("cleanup of a row whose pane is already gone removes the worktree and closes no pane", () => {
	const f = fixture();
	const [r5] = cleanable(f);
	f.state.exec[`herdr pane process-info --pane ${r5.id}`] = {
		code: 1,
		stdout: '{"error":{"code":"pane_not_found"}}',
		stderr: "",
	};
	const out = assertOk(f.run("cleanup"));
	const effects = f.calls.filter((c) => EFFECT.test(c));
	assert.deepEqual(
		effects.filter((c) => c.includes(r5.id) || c.includes("t5")),
		[`git worktree remove ${r5.wt}`, "git branch -D feat/t5"],
	);
	assert.match(out, /Resources left:\n- #6 branch feat\/t6: kept, the PR is not merged$/);
});

test("merge on a behind PR whose update-branch fails records nothing and names the failure", () => {
	const f = fixture();
	approvedGated(f);
	f.state.prs["feat/t5"] = goodPr({ mergeStateStatus: "BEHIND" });
	f.state.exec["gh pr update-branch 12"] = { code: 1, stdout: "", stderr: "HTTP 422: merge conflict" };
	const before = f.events().length;
	assertRefused(f.run("merge", "5"), "gh pr update-branch failed", "HTTP 422: merge conflict");
	assert.equal(f.events().length, before);
	assert.deepEqual(mergeCalls(f), []);
	assert.match(rowLine(f, 5), new RegExp(`^#5 GATED\\(${HEAD}\\)`));
});

test("merge is refused when the base rules' merge methods exclude squash", () => {
	const f = fixture();
	f.state.rules = ok(
		JSON.stringify([{ type: "pull_request", parameters: { allowed_merge_methods: ["merge", "rebase"] } }]),
	);
	approvedGated(f);
	assertRefused(f.run("merge", "5"), "allow merge, rebase, not squash");
	assert.deepEqual(mergeCalls(f), []);
	assert.notEqual(f.events().at(-1).type, "merge-intent");
});

test("contract: the guard's confirm title is a dialog to prompt", async () => {
	let handler: any;
	registerGuard({
		on: (_event: string, h: any) => {
			handler = h;
		},
		registerCommand: () => {},
		events: { emit: () => {} },
	} as any);
	const titles: string[] = [];
	const command = "git push origin main";
	const cwd = mkdtempSync(join(ROOT, "guard-"));
	await handler(
		{ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command } },
		{
			cwd,
			hasUI: true,
			ui: {
				confirm: async (title: string) => {
					titles.push(title);
					return false;
				},
			},
		},
	);
	assert.equal(titles.length, 1, "guard did not open a confirm");
	const screen = `${titles[0]}\n\n  ${command}\n\n→ Yes\n  No\n`;
	assert.ok(!screen.includes("enter select"));
	assert.equal(dialogVisible(screen), true, `batch does not see the guard confirm ${JSON.stringify(titles[0])}`);
	assert.equal(dialogVisible("> please rebase\n"), false);
});

test("contract: batch's lock path is where the implement job takes its lock", async () => {
	const repo = mkdtempSync(join(ROOT, "lock-repo-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
	git("init", "-q", "--template=", "-b", "main");
	git("config", "core.hooksPath", "/dev/null");
	git("config", "commit.gpgsign", "false");
	git("config", "user.email", "batch-test@example.invalid");
	git("config", "user.name", "Batch Test");
	writeFileSync(join(repo, "a.txt"), "a\n");
	git("add", "-A");
	git("commit", "-q", "-m", "initial");
	git("switch", "-q", "-c", "goal/x");
	const job = await prepare(repo, "im70", "npm test");
	try {
		const lock = implementLock(git("rev-parse", "--path-format=absolute", "--git-dir"));
		assert.ok(existsSync(lock), `no implement lock at ${lock}`);
		assert.equal(lock, job.lockPath);
	} finally {
		rmSync(job.lockPath, { force: true });
		rmSync(job.ghConfigDir, { recursive: true, force: true });
	}
});

test("a run written by another version of the helper is refused", () => {
	const f = fixture();
	assertOk(f.preflight());
	assert.equal(typeof f.events()[0].version, "number");
	const path = join(f.runDir(), "events.jsonl");
	const [first, ...rest] = readFileSync(path, "utf8").split("\n");
	const old = { ...JSON.parse(first) };
	delete old.version;
	writeFileSync(path, [JSON.stringify(old), ...rest].join("\n"));
	for (const argv of [["status"], ["event", "5", "drop", "--user", "x"], ["cleanup"]])
		assertRefused(
			f.run(...argv),
			"written by another version of the helper",
			"version none",
			"this helper writes version",
		);
});

test("a report whose Status line is still the template placeholder is not a report", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("10:05");
	for (const status of ["DONE | BLOCKED", "<DONE or BLOCKED>", "DONE, mostly"])
		assertRefused(f.run("event", "5", "report", "--path", f.report(5, status, "10:04")), "exactly DONE or BLOCKED");
	assertOk(f.run("event", "5", "report", "--path", f.report(5, "**BLOCKED**", "10:04")));
	assert.match(rowLine(f, 5), /^#5 ASKED\(chief\)/);
	const template = readFileSync(join(import.meta.dirname, "../skills/batch-chief/CONTRACT.md"), "utf8");
	assert.match(template, /\n## Report template\n[\s\S]*\n## Status\n<DONE or BLOCKED>\n/);
});

test("SKILL.md marks a coordinator's pane unattended before it starts Pi there, and CONTRACT.md quotes guard's refusal", () => {
	const skill = readFileSync(join(import.meta.dirname, "../skills/batch-chief/SKILL.md"), "utf8");
	const exported = skill.indexOf('herdr pane run <pane> "export ME_PI_UNATTENDED=1"');
	assert.ok(exported >= 0, "step 3 does not export ME_PI_UNATTENDED=1 into the pane");
	assert.ok(exported < skill.indexOf("herdr agent start coordinator-<n>"), "the export comes after herdr agent start");
	const contract = readFileSync(join(import.meta.dirname, "../skills/batch-chief/CONTRACT.md"), "utf8");
	assert.match(
		contract,
		/unattended session, no one can approve`: such a refusal is reported .*never retried or rerouted/,
	);
});

// ---------------------------------------------------------------------------------------------------------------
// The current run pointer and format versions.

const currentPointer = (f: Fixture) => join(`${f.repo}.worktrees`, ".batch", "current");

test("a cleanup that leaves nothing removes current, keeps the run directory, and the next preflight starts", () => {
	const f = fixture();
	cleanable(f);
	f.state.exec["git rev-parse --verify --quiet refs/heads/feat/t6"] = { code: 1, stdout: "", stderr: "" };
	const dir = f.runDir();
	const out = assertOk(f.run("cleanup"));
	assert.match(out, /Resources left:\n- none/);
	assert.ok(!existsSync(currentPointer(f)), `current is still there after:\n${out}`);
	assert.match(out.split("\n").at(-1)!, /current run cleared/);
	assert.ok(existsSync(join(dir, "events.jsonl")), "the run's events.jsonl was removed");
	for (const argv of [
		["status"],
		["event", "5", "drop", "--user", "x"],
		["cleanup"],
		["note", "--kind", "manual-fix", "--ticket", "5", "x"],
	])
		assertRefused(f.run(...argv), "no current run", "run preflight first");
	f.at("11:00");
	assertOk(f.preflight());
	assert.notEqual(f.runDir(), dir);
});

test("a cleanup that leaves a resource or a row that is not terminal keeps current", () => {
	const dirty = fixture();
	const [r5] = cleanable(dirty);
	dirty.state.exec[`git -C ${r5.wt} status --porcelain`] = ok("?? scratch.txt\n");
	assert.match(assertOk(dirty.run("cleanup")), /Resources left:\n- #5 /);
	assert.ok(existsSync(currentPointer(dirty)), "current removed while a worktree is left");
	const running = fixture();
	assertOk(running.preflight());
	assertOk(running.launch(5));
	assertOk(running.run("cleanup"));
	assert.ok(existsSync(currentPointer(running)), "current removed while #5 runs");
	const queued = fixture();
	assertOk(queued.preflight());
	assert.match(assertOk(queued.run("cleanup")), /Resources left:\n- none/);
	assert.ok(existsSync(currentPointer(queued)), "current removed while rows are QUEUED");
});

test("cleanup --dry-run never removes current", () => {
	const f = fixture();
	cleanable(f);
	f.state.exec["git rev-parse --verify --quiet refs/heads/feat/t6"] = { code: 1, stdout: "", stderr: "" };
	const out = assertOk(f.run("cleanup", "--dry-run"));
	assert.match(out, /Resources left:\n- none/);
	assert.ok(existsSync(currentPointer(f)), "dry run removed current");
});

/** Rewrites the current run's preflight to `version` and replaces its later events with `rest`. */
function otherVersion(f: Fixture, version: number, rest: object[]) {
	const path = join(f.runDir(), "events.jsonl");
	const [first] = f.events();
	writeFileSync(path, [{ ...first, version }, ...rest].map((e) => `${JSON.stringify(e)}\n`).join(""));
	return readFileSync(path, "utf8");
}

test("preflight refuses a current run of another version, finished or not, and names the flag that sets it aside", () => {
	for (const rest of [
		[{ at: "2026-11-11T10:01:00.000Z", type: "finished-v2", ticket: 5 }],
		[{ at: "2026-11-11T10:01:00.000Z", type: "launch", ticket: 5 }],
	]) {
		const f = fixture();
		assertOk(f.preflight());
		const old = f.runDir();
		otherVersion(f, 2, rest);
		f.at("11:00");
		assertRefused(
			f.preflight(),
			"written by another version of the helper",
			"version 2",
			"preflight again with --set-aside-old-run",
		);
		assert.equal(f.runDir(), old, "a refused preflight moved current");
	}
});

test("preflight --set-aside-old-run starts a new run and leaves the other version's run on disk unread", () => {
	for (const rest of [[], [{ at: "2026-11-11T10:01:00.000Z", type: "launch", ticket: 5 }]]) {
		const f = fixture();
		assertOk(f.preflight());
		const old = f.runDir();
		const before = otherVersion(f, 2, rest);
		f.at("11:00");
		const out = assertOk(
			f.run(
				"preflight",
				...["--repo", f.repo, "--tickets", "5,6", "--check", "npm test", "--chief-pane", "w1:p1"],
				"--set-aside-old-run",
				"the old run is finished and cleaned up",
			),
		);
		assert.ok(
			out.includes(`set aside run ${old.split("/").at(-1)} (version 2), not checked; it stays in ${old}`),
			out,
		);
		assert.notEqual(f.runDir(), old);
		assert.equal(readFileSync(join(old, "events.jsonl"), "utf8"), before);
	}
});

test("preflight --set-aside-old-run still refuses an unfinished run of this version", () => {
	const f = fixture();
	assertOk(f.preflight());
	assertOk(f.launch(5));
	f.at("11:00");
	assertRefused(
		f.run(
			"preflight",
			...["--repo", f.repo, "--tickets", "7", "--check", "npm test", "--chief-pane", "w1:p1"],
			"--set-aside-old-run",
			"the old run is finished and cleaned up",
		),
		"still has rows that are not terminal: #5, #6",
	);
});

const preflightArgs = (f: Fixture) => [
	"--repo",
	f.repo,
	"--tickets",
	"5,6",
	"--check",
	"npm test",
	"--chief-pane",
	"w1:p1",
];

test("preflight --set-aside-old-run takes the user's words and records them with the run set aside", () => {
	const f = fixture();
	assertOk(f.preflight());
	const old = f.runDir();
	otherVersion(f, 2, []);
	f.at("11:00");
	for (const words of ["", "   "])
		assertRefused(f.run("preflight", ...preflightArgs(f), "--set-aside-old-run", words), "--set-aside-old-run");
	assert.equal(f.runDir(), old, "a refused preflight moved current");
	assert.equal(f.run("preflight", ...preflightArgs(f), "--set-aside-old-run").code, 1);
	const words = "the old batch is merged and cleaned up";
	assertOk(f.run("preflight", ...preflightArgs(f), "--set-aside-old-run", words));
	const id = old.split("/").at(-1);
	assert.deepEqual(f.events()[0].setAside, { run: id, version: 2, user: words });
	assert.ok(
		readLedger(f).includes(`- Set aside: run ${id} (version 2), not checked: ${JSON.stringify(words)}`),
		readLedger(f),
	);
});

test("only preflight's refusal of another version names --set-aside-old-run, after the user confirms", () => {
	const f = fixture();
	assertOk(f.preflight());
	otherVersion(f, 2, []);
	f.at("11:00");
	assertRefused(
		f.preflight(),
		"Finish that run with the helper that wrote it",
		"only after the user confirms it is finished and cleaned up",
		`--set-aside-old-run "<user's words>"`,
	);
	for (const argv of [["status"], ["event", "5", "drop", "--user", "x"], ["cleanup"]]) {
		const result = f.run(...argv);
		assertRefused(result, "Finish that run with the helper that wrote it");
		assert.ok(!result.out.includes("--set-aside-old-run"), result.out);
	}
});

test("a cleanup that keeps a local branch lists it under Resources left and keeps current", () => {
	const f = fixture();
	cleanable(f);
	const out = assertOk(f.run("cleanup"));
	assert.match(out, /kept branch feat\/t6/);
	assert.match(out, /Resources left:\n- #6 branch feat\/t6: kept, the PR is not merged$/);
	assert.ok(existsSync(currentPointer(f)), `current removed while branch feat/t6 is kept:\n${out}`);
});

test("a cleanup whose branch check fails lists it under Resources left and keeps current", () => {
	const f = fixture();
	cleanable(f);
	f.state.exec["git rev-parse --verify --quiet refs/heads/feat/t6"] = {
		code: 128,
		stdout: "",
		stderr: "fatal: not a git repository\n",
	};
	const out = assertOk(f.run("cleanup"));
	assert.ok(out.includes("  left: cannot check branch feat/t6: fatal: not a git repository"), out);
	assert.match(out, /Resources left:\n- #6 .*: cannot check branch feat\/t6: fatal: not a git repository$/);
	assert.ok(existsSync(currentPointer(f)), `current removed while branch feat/t6 is unchecked:\n${out}`);
});

test("a cleanup whose current pointer cannot be removed still returns its output and names the failure", () => {
	const f = fixture();
	const [, r6] = cleanable(f);
	f.state.exec["git rev-parse --verify --quiet refs/heads/feat/t6"] = { code: 1, stdout: "", stderr: "" };
	// The last effect turns current into a directory, which unlink refuses whoever runs the test.
	f.state.exec[`herdr pane close ${r6.id}`] = () => {
		rmSync(currentPointer(f));
		mkdirSync(currentPointer(f));
		return ok();
	};
	const out = assertOk(f.run("cleanup"));
	assert.match(out, /Resources left:\n- none/);
	assert.ok(out.includes(`ran: git worktree remove ${r6.wt}`), out);
	const last = out.split("\n").at(-1)!;
	assert.ok(last.startsWith(`current run not cleared: removing ${currentPointer(f)} failed: `), out);
	assert.match(last, /E(PERM|ISDIR)/);
	assert.ok(existsSync(currentPointer(f)));
});

test("golden: a frozen version-1 events.jsonl rebuilds to the same rows", () => {
	const f = fixture();
	const golden = readFileSync(join(import.meta.dirname, "fixtures/batch-chief/v1-events.jsonl"), "utf8");
	const batch = join(`${f.repo}.worktrees`, ".batch");
	mkdirSync(join(batch, "golden-v1"), { recursive: true });
	writeFileSync(join(batch, "golden-v1", "events.jsonl"), golden);
	writeFileSync(join(batch, "current"), "golden-v1\n");
	f.at("10:55");
	const out = assertOk(f.run("status"));
	const rows = out.split("\n").filter((l) => /^(#| {2}allowed:)/.test(l));
	assert.deepEqual(rows, [
		"#5 MERGED next: nobody",
		"#release LEFT_OPEN next: nobody",
		"#7 DROPPED next: nobody",
		"#8 RUNNING(review) next: coordinator, deadline 2026-11-11T11:19:00.000Z",
		"  allowed: event 8 report --path /golden/report-8.md",
		'  allowed: event 8 drop --user "<user\'s words>"',
	]);
	assert.equal(readFileSync(join(batch, "golden-v1", "events.jsonl"), "utf8"), golden, "status recorded an event");
	const ledger = readFileSync(join(batch, "golden-v1", "ledger.md"), "utf8");
	for (const line of [
		"| #5 | MERGED | nobody |  | feat/t5 | 2026-11-11T10:23:00.000Z |  |",
		"| #release | LEFT_OPEN | nobody |  | feat/trelease | 2026-11-11T10:45:00.000Z |  |",
		"| #7 | DROPPED | nobody |  | feat/t7 | 2026-11-11T10:46:00.000Z |  |",
		"| #8 | RUNNING(review) | coordinator | 2026-11-11T11:19:00.000Z | feat/t8 | 2026-11-11T10:49:00.000Z |  |",
		'- 2026-11-11T10:22:00.000Z merge #5: "merge 5"',
		'- 2026-11-11T10:44:00.000Z merge #release: "ship them all" (inferred)',
		"- chief-answer #release: answered from the brief's clock line",
		"- gate-miss #8: CI ran on the old head",
	])
		assert.ok(ledger.includes(line), `ledger lacks ${line}:\n${ledger}`);
	assert.ok(ledger.includes("`/golden/repo`, base `main` at `1111111111111111111111111111111111111111`"), ledger);
});

// ---------------------------------------------------------------------------------------------------------------
// Cleanup of the run's scratch and live clones, and what it lists for the user.

/** A `cleanable` fixture whose #6 branch is already gone, so cleanup leaves no resource and the run can end. */
function finishable() {
	const f = fixture();
	const rows = cleanable(f);
	f.state.exec["git rev-parse --verify --quiet refs/heads/feat/t6"] = { code: 1, stdout: "", stderr: "" };
	return Object.assign(f, { rows });
}

/** Writes `text` at `path`, creating its directories. */
function put(path: string, text = "x") {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
	return path;
}

const gone = (path: string) => {
	try {
		lstatSync(path);
		return false;
	} catch {
		return true;
	}
};

test("cleanup removes the run's scratch and live directories after the coordinators quit, and keeps the run's records", () => {
	const f = finishable();
	const dir = f.runDir();
	put(join(dir, "scratch", "5", "notes.txt"));
	put(join(dir, "scratch", "6", "deep", "repro.ts"));
	put(join(dir, "live", "5", ".git", "HEAD"));
	const kept = ["contract-5.md", "report-5.md"].map((name) => put(join(dir, name)));
	assertOk(f.run("status"));
	const out = assertOk(f.run("cleanup"));
	assert.ok(gone(join(dir, "scratch")) && gone(join(dir, "live")), out);
	for (const path of [...kept, join(dir, "events.jsonl"), join(dir, "ledger.md")])
		assert.ok(existsSync(path), `${path} was removed`);
	assert.ok(out.includes(`removed: ${join(dir, "scratch")}`), out);
	assert.ok(out.includes(`removed: ${join(dir, "live")}`), out);
	assert.match(out.split("\n").at(-1)!, /current run cleared/);
});

test("cleanup unlinks a symlink inside scratch or live and never touches its target outside the run", () => {
	const f = finishable();
	const dir = f.runDir();
	const outsideDir = join(f.dir, "outside");
	const outsideFile = put(join(outsideDir, "keep.txt"), "keep");
	const loneFile = put(join(f.dir, "lone.txt"), "lone");
	mkdirSync(join(dir, "scratch", "5"), { recursive: true });
	mkdirSync(join(dir, "live"), { recursive: true });
	symlinkSync(outsideDir, join(dir, "scratch", "5", "to-dir"));
	symlinkSync(loneFile, join(dir, "scratch", "5", "to-file"));
	symlinkSync(outsideDir, join(dir, "live", "5"));
	symlinkSync(join(f.dir, "missing"), join(dir, "scratch", "dangling"));
	const out = assertOk(f.run("cleanup"));
	assert.ok(gone(join(dir, "scratch")) && gone(join(dir, "live")), out);
	assert.equal(readFileSync(outsideFile, "utf8"), "keep");
	assert.equal(readFileSync(loneFile, "utf8"), "lone");
	assert.ok(lstatSync(outsideDir).isDirectory());
});

test("cleanup unlinks a scratch directory that is itself a symlink out of the run, leaving the target and its files", () => {
	const f = finishable();
	const dir = f.runDir();
	const victim = join(f.dir, "victim");
	const file = put(join(victim, "sub", "data.txt"), "data");
	symlinkSync(victim, join(dir, "scratch"));
	const out = assertOk(f.run("cleanup"));
	assert.ok(gone(join(dir, "scratch")), out);
	assert.equal(readFileSync(file, "utf8"), "data");
	assert.ok(out.includes(`unlinked symlink: ${join(dir, "scratch")}`), out);
});

test("cleanup lists a report's Scratch paths left, including .. and absolute paths, and removes none of them", () => {
	const f = finishable();
	const dir = f.runDir();
	const relative = put(join(dir, "..", "..", "victim", "file.txt"), "rel");
	const absolute = put(join(f.dir, "abs-victim", "file.txt"), "abs");
	writeFileSync(
		join(f.dir, "report-5.md"),
		`# Report: #5\n\n## Status\nDONE\n\n## Scratch paths left\n- ../../victim\n- ${join(f.dir, "abs-victim")}\n\n## Not verified\n- none\n`,
	);
	writeFileSync(join(f.dir, "report-6.md"), "# Report: #6\n\n## Scratch paths left\n- none\n");
	for (const argv of [["cleanup", "--dry-run"], ["cleanup"]]) {
		const out = assertOk(f.run(...argv));
		assert.ok(out.includes(`- #5 scratch path left (from ${join(f.dir, "report-5.md")}): ../../victim`), out);
		assert.ok(
			out.includes(`- #5 scratch path left (from ${join(f.dir, "report-5.md")}): ${join(f.dir, "abs-victim")}`),
			out,
		);
		assert.ok(!out.includes("#6 scratch path left"), out);
	}
	assert.equal(readFileSync(relative, "utf8"), "rel");
	assert.equal(readFileSync(absolute, "utf8"), "abs");
});

test("cleanup --dry-run lists the scratch and live directories it would remove and removes nothing", () => {
	const f = finishable();
	const dir = f.runDir();
	const file = put(join(dir, "scratch", "5", "notes.txt"));
	const clone = put(join(dir, "live", "5", "README.md"));
	const out = assertOk(f.run("cleanup", "--dry-run"));
	assert.ok(existsSync(file) && existsSync(clone), out);
	assert.ok(out.includes(`would remove: ${join(dir, "scratch")}`), out);
	assert.ok(out.includes(`would remove: ${join(dir, "live")}`), out);
});

test("cleanup keeps scratch and live while a coordinator still runs or a row is not terminal", () => {
	const f = finishable();
	const [r5] = f.rows;
	f.state.exec[`herdr agent prompt ${r5.id} /quit`] = ok();
	const file = put(join(f.runDir(), "scratch", "5", "notes.txt"));
	const out = assertOk(f.run("cleanup"));
	assert.ok(existsSync(file), out);
	assert.ok(out.includes(`kept: ${join(f.runDir(), "scratch")}`), out);
	const running = fixture();
	assertOk(running.preflight());
	assertOk(running.launch(5));
	const kept = put(join(running.runDir(), "live", "5", "x"));
	assertOk(running.run("cleanup"));
	assert.ok(existsSync(kept));
});

test("cleanup lists a merged row's remote branch that still exists and a main checkout behind origin, removing neither", () => {
	const f = finishable();
	f.state.exec["git ls-remote origin refs/heads/feat/t5"] = ok(`${HEAD}\trefs/heads/feat/t5\n`);
	f.state.exec["git ls-remote origin refs/heads/main"] = ok(`${MOVED}\trefs/heads/main\n`);
	f.state.exec[`git merge-base --is-ancestor ${MOVED} HEAD`] = { code: 1, stdout: "", stderr: "" };
	const out = assertOk(f.run("cleanup"));
	assert.ok(out.includes("- #5 remote branch feat/t5 still exists on origin"), out);
	assert.ok(out.includes(`- main checkout ${f.repo} is behind origin/main (${MOVED})`), out);
	assert.ok(!f.calls.some((c) => /push|ls-remote origin refs\/heads\/feat\/t6/.test(c)), f.calls.join("\n"));
	assert.match(out.split("\n").at(-1)!, /current run cleared/);
});

test("CONTRACT.md puts all scratch in <scratch>, a placeholder of the table, and lists only paths outside it", () => {
	const contract = readFileSync(join(import.meta.dirname, "../skills/batch-chief/CONTRACT.md"), "utf8");
	assert.match(contract, /\n\| `<scratch>` \| `<run dir>\/scratch\/<n>\/`/);
	assert.match(contract, /all scratch goes in `<scratch>` and stays there/);
	assert.match(contract, /## Scratch paths left\n- <path outside `<scratch>`>, or none/);
});
