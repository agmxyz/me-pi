import assert from "node:assert/strict";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
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
	assert.match(out, /Resources left:\n- none/);
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
