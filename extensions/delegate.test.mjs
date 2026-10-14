import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Scratch space for fake pi binaries and git repos.
const TEST_HOME = mkdtempSync(join(tmpdir(), "delegate-test-"));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
process.on("exit", () => {
	try {
		rmSync(TEST_HOME, { recursive: true, force: true });
	} catch {}
});

const {
	default: registerExtension,
	computeWorkingTreeDiff,
	loadRoles,
	parseFrontmatterText,
} = await import("./delegate.ts");

function fakePi() {
	const tools = {};
	const pi = {
		registerTool: (definition) => {
			tools[definition.name] = definition;
		},
	};
	return { pi, tools };
}

test("parseFrontmatterText catches unquoted colons and strips quotes cleanly", () => {
	const broken = parseFrontmatterText("---\nname: x\ndescription: bad: unquoted colon\n---\nBody");
	assert.match(broken.error ?? "", /unquoted colon/);

	const quoted = parseFrontmatterText('---\nname: x\ndescription: "good: quoted colon"\n---\nBody');
	assert.equal(quoted.error, undefined);
	assert.equal(quoted.fields.description, "good: quoted colon");
	assert.equal(quoted.body, "Body");
});

function registerDelegate(t, { workerRun } = {}) {
	const saved = process.env.ME_PI_RUN;
	if (workerRun) process.env.ME_PI_RUN = workerRun;
	else delete process.env.ME_PI_RUN;
	t.after(() => {
		if (saved === undefined) delete process.env.ME_PI_RUN;
		else process.env.ME_PI_RUN = saved;
	});
	const fp = fakePi();
	registerExtension(fp.pi);
	return fp.tools;
}

test("main session registers delegate with role list from frontmatter; workers do not", async (t) => {
	const tools = registerDelegate(t);
	assert.ok(tools.delegate, "delegate tool registered in main session");
	for (const role of loadRoles().roles.values()) {
		assert.ok(tools.delegate.description.includes(`${role.name} (${role.description})`), role.name);
	}
	assert.equal(registerDelegate(t, { workerRun: "scout-1" }).delegate, undefined, "delegate tool omitted inside worker session");
});

test("computeWorkingTreeDiff captures tracked and untracked changes without writing git objects", () => {
	const repo = mkdtempSync(join(TEST_HOME, "diff-repo-"));
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
	writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(repo, "tracked.txt"), "one\n```\ntwo\n");
	execFileSync("git", ["-C", repo, "add", "."]);
	execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);

	assert.equal(computeWorkingTreeDiff(repo), "");

	const countObjects = (dir) => {
		let total = 0;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) total += countObjects(full);
			else total++;
		}
		return total;
	};
	const objectsBefore = countObjects(join(repo, ".git", "objects"));
	const indexBefore = readFileSync(join(repo, ".git", "index"));

	writeFileSync(join(repo, "tracked.txt"), "one\n```\nTWO\n");
	writeFileSync(join(repo, "untracked.txt"), "brand-new\n");
	writeFileSync(join(repo, "ignored.txt"), "secret-ignored\n");

	const diff = computeWorkingTreeDiff(repo);
	assert.match(diff, /\+TWO/);
	assert.match(diff, /\+brand-new/);
	assert.doesNotMatch(diff, /secret-ignored/);
	assert.equal(countObjects(join(repo, ".git", "objects")), objectsBefore, "must not write loose objects into .git/objects");
	assert.deepEqual(readFileSync(join(repo, ".git", "index")), indexBefore, "must not touch .git/index");
});

test("delegate tool executes single, parallel, reviewer diff, timeout, and cost cap", async (t) => {
	const fakeBin = join(TEST_HOME, "fake-pi.mjs");
	writeFileSync(
		fakeBin,
		`#!/usr/bin/env node
const args = process.argv.slice(2);
const cost = Number(process.env.FAKE_PI_COST || "0.002");
const sleepMs = Number(process.env.FAKE_PI_SLEEP_MS || "0");
const prompt = args.at(-1) || "";
const modelIdx = args.indexOf("--model");
const model = modelIdx >= 0 ? args[modelIdx + 1] : "default-model";
const thinkingIdx = args.indexOf("--thinking");
const thinking = thinkingIdx >= 0 ? args[thinkingIdx + 1] : "none";

const run = async () => {
  if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
  console.log(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      model,
      usage: { cost: { total: cost } },
      content: [
        { type: "toolCall", name: "grep", arguments: { pattern: "foo", path: "src" } },
        { type: "text", text: \`DONE model=\${model} thinking=\${thinking} hasDiff=\${prompt.includes("## Diff")}\` }
      ]
    }
  }));
};
run();
`,
		{ mode: 0o755 },
	);
	chmodSync(fakeBin, 0o755);

	const savedPiBin = process.env.PI_BIN;
	process.env.PI_BIN = fakeBin;
	t.after(() => {
		if (savedPiBin === undefined) delete process.env.PI_BIN;
		else process.env.PI_BIN = savedPiBin;
	});

	const fp = fakePi();
	registerExtension(fp.pi);
	const delegate = fp.tools.delegate;
	const updates = [];
	const ctx = {
		cwd: REPO_ROOT,
		model: { provider: "session-prov", id: "session-mod" },
		thinkingLevel: "medium",
	};

	// 1. Single scout run inherits session model and role thinking (minimal)
	const single = await delegate.execute("c1", { role: "scout", task: "find foo" }, undefined, (u) => updates.push(u), ctx);
	assert.equal(single.isError, false);
	assert.match(single.content[0].text, /DONE model=session-prov\/session-mod thinking=minimal hasDiff=false/);
	assert.ok(updates.length >= 1, "emits streaming progress updates");

	// 2. Parallel runs
	const parallel = await delegate.execute(
		"c2",
		{
			tasks: [
				{ role: "scout", task: "t1", model: "override/m1" },
				{ role: "devils-advocate", task: "t2", thinking: "max" },
			],
		},
		undefined,
		undefined,
		ctx,
	);
	assert.equal(parallel.isError, false);
	assert.match(parallel.content[0].text, /override\/m1 thinking=minimal/);
	assert.match(parallel.content[0].text, /session-prov\/session-mod thinking=max/);

	// 3. Reviewer refuses clean repo, succeeds on dirty repo and attaches diff
	const cleanRepo = mkdtempSync(join(TEST_HOME, "rev-clean-"));
	execFileSync("git", ["init", "-q", cleanRepo]);
	execFileSync("git", ["-C", cleanRepo, "commit", "-q", "--allow-empty", "-m", "init"]);
	const cleanRes = await delegate.execute("c3", { role: "reviewer", task: "review", cwd: cleanRepo }, undefined, undefined, ctx);
	assert.equal(cleanRes.isError, true);
	assert.match(cleanRes.content[0].text, /nothing to review: working tree matches HEAD/);

	writeFileSync(join(cleanRepo, "file.ts"), "export const x = 1;\n");
	const dirtyRes = await delegate.execute("c4", { role: "reviewer", task: "review", cwd: cleanRepo }, undefined, undefined, ctx);
	assert.equal(dirtyRes.isError, false);
	assert.match(dirtyRes.content[0].text, /hasDiff=true/);

	// 4. Cost cap enforcement
	process.env.FAKE_PI_COST = "5.0";
	const costRes = await delegate.execute(
		"c5",
		{ role: "scout", task: "expensive", costCapUsd: 0.5 },
		undefined,
		undefined,
		ctx,
	);
	delete process.env.FAKE_PI_COST;
	assert.equal(costRes.isError, true);
	assert.match(costRes.content[0].text, /stopped early: cost-cap/);

	// 5. Timeout enforcement
	process.env.FAKE_PI_SLEEP_MS = "5000";
	const timeoutRes = await delegate.execute(
		"c6",
		{ role: "scout", task: "slow", timeoutSecs: 1 },
		undefined,
		undefined,
		ctx,
	);
	delete process.env.FAKE_PI_SLEEP_MS;
	assert.equal(timeoutRes.isError, true);
	assert.match(timeoutRes.content[0].text, /stopped early: timeout/);

	// 6. Invalid env limits fail loudly instead of disabling the cap
	process.env.ME_PI_DELEGATE_COST_CAP = "abc";
	await assert.rejects(
		delegate.execute("c7", { role: "scout", task: "t" }, undefined, undefined, ctx),
		/ME_PI_DELEGATE_COST_CAP must be a positive number, got "abc"/,
	);
	delete process.env.ME_PI_DELEGATE_COST_CAP;
});
