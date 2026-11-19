import assert from "node:assert/strict";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scoreTask, TASKS, taskFixture, taskPrompt } from "../evals/task.ts";

/** A temp root that stands in for the sandbox: the scorer's HOME and TMPDIR point inside it. */
function root(t: any) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "evals-task-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const tmp = join(dir, "tmp");
	mkdirSync(tmp);
	const env = { HOME: dir, TMPDIR: tmp, PI_CODING_AGENT_DIR: join(dir, "agent"), PATH: process.env.PATH ?? "" };
	return { dir, tmp, env };
}

/** The task's fixture with one of its examples laid over it, as a run that produced that example would leave it. */
function workOf(dir: string, task: string, example: string): { work: string; reply: string } {
	const work = join(dir, `${task}-${example}`, "shop");
	cpSync(taskFixture(join(TASKS, task)), work, { recursive: true });
	const from = join(TASKS, task, "examples", example);
	if (existsSync(join(from, "files"))) cpSync(join(from, "files"), work, { recursive: true });
	return { work, reply: readFileSync(join(from, "answer.txt"), "utf8") };
}

const tasks = readdirSync(TASKS).sort();

test("every task named by the policy scenarios exists, and every task is named", () => {
	const spec = JSON.parse(readFileSync(join(TASKS, "..", "scenarios", "policy.json"), "utf8"));
	assert.deepEqual(spec.scenarios.map((s: { task: string }) => s.task).sort(), tasks);
	for (const task of tasks) assert.ok(taskPrompt(join(TASKS, task)).length > 0, `${task} has a prompt`);
});

for (const task of tasks)
	test(`task ${task}: its scorer passes the good example and fails the bad one`, (t) => {
		const { dir, tmp, env } = root(t);
		for (const [example, want] of [
			["good", "pass"],
			["bad", "fail"],
		]) {
			const { work, reply } = workOf(dir, task, example);
			const v = scoreTask(join(TASKS, task), work, reply, tmp, env);
			assert.equal(v.result, want, `${example}: ${v.evidence}`);
		}
	});

test("a scorer that prints a metric reports it", (t) => {
	const { dir, tmp, env } = root(t);
	const { work, reply } = workOf(dir, "out-sentence", "good");
	const v = scoreTask(join(TASKS, "out-sentence"), work, reply, tmp, env);
	assert.equal(v.metric, reply.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length);
});

test("a scorer that errors or cannot run is unknown, never a fail", (t) => {
	const { dir, tmp, env } = root(t);
	const task = join(dir, "broken");
	mkdirSync(task);
	writeFileSync(join(task, "score.mjs"), 'console.log("scorer error: boom"); process.exit(2);\n');
	assert.deepEqual(scoreTask(task, dir, "reply", tmp, env), {
		id: "task scorer",
		result: "unknown",
		evidence: "scorer error: boom",
	});
	writeFileSync(join(task, "score.mjs"), "this is not javascript (\n");
	assert.equal(scoreTask(task, dir, "reply", tmp, env).result, "unknown");
});

test("the scorer leaves no hidden test behind in the work directory", (t) => {
	const { dir, tmp, env } = root(t);
	const { work, reply } = workOf(dir, "eng-errors", "good");
	const before = readdirSync(work, { recursive: true }).sort();
	const flags = readFileSync(join(work, "config", "flags.json"), "utf8");
	scoreTask(join(TASKS, "eng-errors"), work, reply, tmp, env);
	assert.deepEqual(readdirSync(work, { recursive: true }).sort(), before);
	assert.equal(readFileSync(join(work, "config", "flags.json"), "utf8"), flags);
});
