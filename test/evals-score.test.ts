import assert from "node:assert/strict";
import { test } from "node:test";
import { type Assertion, check, parseSession } from "../evals/score.ts";

/** Builds a session JSONL from turns of `["user", text]`, `["say", text]`, or `["call", name, args, resultText?, isError?]`. */
function session(...steps: any[][]): string {
	const lines: object[] = [{ type: "session", version: 3 }];
	let n = 0;
	for (const [kind, ...rest] of steps) {
		if (kind === "user")
			lines.push({ type: "message", message: { role: "user", content: [{ type: "text", text: rest[0] }] } });
		if (kind === "say")
			lines.push({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: rest[0] }],
					usage: { cost: { total: 0.01 } },
				},
			});
		if (kind === "call") {
			const [name, args, text, isError] = rest;
			const id = `c${n++}`;
			lines.push({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id, name, arguments: args }],
					usage: { cost: { total: 0.01 } },
				},
			});
			if (text !== undefined)
				lines.push({
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: id,
						toolName: name,
						isError: !!isError,
						content: [{ type: "text", text }],
						...(name === "delegate" ? { usage: { cost: { total: 0.5 } } } : {}),
					},
				});
		}
	}
	return lines.map((l) => JSON.stringify(l)).join("\n");
}

const run = (jsonl: string, a: Assertion) => check(parseSession(jsonl), a);

/** A codemode call whose script made `nested` tool calls, as Pi records them on the result message. */
function codemode(nested: object[], text: string, cost?: number): string {
	const call = { type: "toolCall", id: "cm", name: "codemode", arguments: { code: "await tools.delegate({})" } };
	const lines = [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "q" }] } },
		{ type: "message", message: { role: "assistant", content: [call] } },
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "cm",
				toolName: "codemode",
				isError: false,
				content: [{ type: "text", text }],
				nestedCalls: { calls: nested, complete: true },
				...(cost === undefined ? {} : { usage: { cost: { total: cost } } }),
			},
		},
	];
	return lines.map((l) => JSON.stringify(l)).join("\n");
}

test("a delegate call made from codemode counts like a direct one, with its worker cost", () => {
	const impl = { name: "delegate", status: "ok", arguments: { role: "implement", task: "x", check: "npm test" } };
	const log = codemode(
		[{ name: "plan", status: "ok", arguments: { done: 1 } }, impl],
		"✓ im1: check ✓ `npm test`",
		0.25,
	);
	assert.deepEqual(run(log, { id: "d", delegate: { role: "implement" }, count: 1 }), {
		id: "d",
		result: "pass",
		evidence: "1 matching (1–1): implement",
	});
	assert.equal(run(log, { id: "i", inline: true }).result, "fail");
	assert.equal(parseSession(log).workerCost, 0.25);
	const rerun = codemode([impl, { name: "bash", status: "ok", arguments: { command: "npm test" } }], "check ✓");
	assert.equal(run(rerun, { id: "r", noRerun: "npm test" }).result, "fail");
});

test("a nested delegate call that failed is not accepted; an unfinished one is unknown", () => {
	const failed = codemode([{ name: "delegate", status: "error", arguments: { role: "implement" } }], "boom");
	assert.equal(run(failed, { id: "d", delegate: { role: "implement" }, count: 1 }).result, "fail");
	const cut = codemode([{ name: "delegate", status: "unfinished", arguments: { role: "implement" } }], "");
	assert.equal(run(cut, { id: "d", delegate: { role: "implement" }, count: 1 }).result, "unknown");
});

test("parseSession splits turns and sums coordinator and worker cost estimates", () => {
	const t = parseSession(
		session(
			["user", "one"],
			["call", "delegate", { task: "x" }, "ok"],
			["say", "done"],
			["user", "two"],
			["say", "bye"],
		),
	);
	assert.deepEqual(
		t.turns.map((x) => [x.prompt, x.replies]),
		[
			["one", ["done"]],
			["two", ["bye"]],
		],
	);
	assert.equal(t.calls.length, 1);
	assert.equal(t.coordinatorCost.toFixed(2), "0.03");
	assert.equal(t.workerCost, 0.5);
});

test("delegate counts only accepted calls, defaulting the role to general", () => {
	const log = session(
		["user", "q"],
		[
			"call",
			"delegate",
			{ runs: [{ model: "a" }, { model: "b" }], rebuttal: true, task: "x" },
			"ambiguous model",
			true,
		],
		["call", "delegate", { runs: [{ model: "p/a" }, { model: "b" }], rebuttal: true, task: "x" }, "answer"],
	);
	assert.equal(run(log, { id: "one", delegate: { minRuns: 2, rebuttal: true }, count: 1 }).result, "pass");
	assert.equal(run(log, { id: "general", delegate: { role: "general" }, count: [1, 1] }).result, "pass");
	assert.equal(run(log, { id: "none", delegate: { role: "implement" }, count: 0 }).result, "pass");
});

test("named matches calls whose runs set a model or thinking, and the evidence lists them", () => {
	const log = session(
		["user", "q"],
		["call", "delegate", { task: "x" }, "ok"],
		["call", "delegate", { task: "y", runs: [{}] }, "ok"],
		["call", "delegate", { task: "z", runs: [{ model: "p/b" }, { thinking: "medium" }] }, "ok"],
	);
	const named = run(log, { id: "n", delegate: { named: true }, count: 1 });
	assert.equal(named.result, "pass");
	assert.match(named.evidence, /general p\/b medium/);
	assert.equal(run(log, { id: "u", delegate: { named: false }, count: 2 }).result, "pass");
});

test("a delegate call that never returned makes a failing count unknown, not a fail", () => {
	const log = session(["user", "q"], ["call", "delegate", { task: "x", background: true }]);
	assert.equal(run(log, { id: "bg", delegate: { background: true }, count: 1 }).result, "unknown");
});

test("inline needs an own edit and no implement worker", () => {
	const own = session(["user", "q"], ["call", "codemode", { code: "await tools.edit({path:'a'})" }, "ok"]);
	assert.equal(run(own, { id: "i", inline: true }).result, "pass");
	const delegated = session(
		["user", "q"],
		["call", "edit", { path: "a" }, "ok"],
		["call", "delegate", { role: "implement", task: "x" }, "✓ im1 feat 1 commit; check ✓ `npm test`"],
	);
	assert.equal(run(delegated, { id: "i", inline: true }).result, "fail");
});

test("noRerun flags the check re-run after an implement ✓, but not after an own edit", () => {
	const impl = ["call", "delegate", { role: "implement", task: "x" }, "✓ im1 check ✓ `npm test`"];
	const rerun = session(["user", "q"], impl, ["call", "bash", { command: "npm test" }, "ok"]);
	assert.equal(run(rerun, { id: "r", noRerun: "npm (run )?test" }).result, "fail");
	const ownFix = session(
		["user", "q"],
		impl,
		["call", "edit", { path: "cli.js" }, "ok"],
		["call", "bash", { command: "npm test && git commit -am fix" }, "ok"],
	);
	assert.equal(run(ownFix, { id: "r", noRerun: "npm (run )?test" }).result, "pass");
});

test("diffByPath needs a review given a diff path, and fails when the coordinator reads that diff", () => {
	const review = ["call", "delegate", { task: "Review /tmp/x.diff for bugs" }, "no findings"];
	assert.equal(run(session(["user", "q"], review), { id: "d", diffByPath: true }).result, "pass");
	const reread = session(["user", "q"], ["call", "read", { path: "/tmp/x.diff" }, "diff --git"], review);
	assert.equal(run(reread, { id: "d", diffByPath: true }).result, "fail");
	const catted = session(["user", "q"], ["call", "bash", { command: "cat /tmp/x.diff" }, "diff"], review);
	assert.equal(run(catted, { id: "d", diffByPath: true }).result, "fail");
	assert.equal(
		run(session(["user", "q"], ["call", "delegate", { task: "Review it" }, "ok"]), { id: "d", diffByPath: true })
			.result,
		"fail",
	);
});

test("skill, noTool, maxOwnRead, reply, and maxReplyWords read the matching calls and turns", () => {
	const log = session(
		["user", "q"],
		["call", "Skill", { name: "code-review" }, "body".repeat(5000)],
		["call", "read", { path: "CHANGELOG.md" }, "x".repeat(500)],
		["say", "Started bg1; the Limits section covers caps."],
		["user", "later"],
		["say", "one two three"],
	);
	assert.equal(run(log, { id: "s", skill: "code-review" }).result, "pass");
	assert.equal(run(log, { id: "w", noTool: "web_enable" }).result, "pass");
	assert.equal(run(log, { id: "m", maxOwnRead: 400 }).result, "fail");
	assert.equal(run(log, { id: "m", maxOwnRead: 600 }).result, "pass");
	assert.equal(run(log, { id: "j", reply: "\\bbg\\d+\\b", turn: 0 }).result, "pass");
	assert.equal(run(log, { id: "j", reply: "\\bbg\\d+\\b", turn: 1 }).result, "fail");
	assert.equal(run(log, { id: "h", maxReplyWords: 3, turn: 1 }).result, "pass");
	assert.equal(run(log, { id: "h", maxReplyWords: 2, turn: 1 }).result, "fail");
});
