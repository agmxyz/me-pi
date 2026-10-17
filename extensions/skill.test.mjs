import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { default: registerSkill } = await import("./skill.ts");

const HOME = mkdtempSync(join(tmpdir(), "skill-test-"));
process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));

function skillFile(name, frontmatter, body) {
	const dir = join(HOME, name);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, "SKILL.md");
	writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}\n`);
	return { name, description: `${name} skill`, filePath, baseDir: dir, disableModelInvocation: false };
}

// Register against a fake Pi; `start(skills)` fires before_agent_start with Pi's discovered skills.
function setup() {
	let tool;
	const handlers = {};
	registerSkill({
		on: (event, handler) => {
			handlers[event] = handler;
		},
		registerTool: (definition) => {
			tool = definition;
		},
	});
	return {
		tool,
		start: (skills) => handlers.before_agent_start({ systemPromptOptions: { skills } }),
		call: (name) => tool.execute("c1", { name }),
	};
}

const tdd = skillFile("tdd", "name: tdd\ndescription: test first", "# TDD\nRead tests.md.");
const implement = {
	...skillFile("implement", "name: implement\ndescription: x\ndisable-model-invocation: true", "Implement it."),
	disableModelInvocation: true,
};

test("registers the Skill tool with a name parameter", () => {
	const { tool } = setup();
	assert.equal(tool.name, "Skill");
	assert.deepEqual(tool.parameters.required, ["name"]);
});

test("returns a discovered skill's body without frontmatter, with its location and base dir", async () => {
	const { start, call } = setup();
	await start([tdd, implement]);
	const res = await call("tdd");
	assert.equal(res.isError, undefined);
	const text = res.content[0].text;
	assert.match(text, new RegExp(`^<skill name="tdd" location="${tdd.filePath}">`));
	assert.match(text, new RegExp(`References are relative to ${tdd.baseDir}\\.`));
	assert.match(text, /# TDD\nRead tests\.md\.\n<\/skill>$/);
	assert.doesNotMatch(text, /description: test first/);
	assert.deepEqual(res.details, { name: "tdd", path: tdd.filePath });
});

test("unknown skills fail and list only model-invocable skills", async () => {
	const { start, call } = setup();
	await start([tdd, implement]);
	const res = await call("nope");
	assert.equal(res.isError, true);
	assert.equal(res.content[0].text, 'unknown skill "nope" (available: tdd)');
});

test("user-invoked skills are refused with the /skill command to use", async () => {
	const { start, call } = setup();
	await start([tdd, implement]);
	const res = await call("implement");
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /user-invoked only; the user starts it with \/skill:implement$/);
});

test("before any run, no skills are available", async () => {
	const { call } = setup();
	const res = await call("tdd");
	assert.equal(res.isError, true);
	assert.equal(res.content[0].text, 'unknown skill "tdd" (available: none)');
});

test("skill metadata is XML-escaped in the wrapper and the available list", async () => {
	const { start, call } = setup();
	const crafted = { ...tdd, name: 'x"><evil>', baseDir: "/a&b" };
	await start([crafted]);
	const ok = await call('x"><evil>');
	assert.match(ok.content[0].text, /^<skill name="x&quot;&gt;&lt;evil&gt;" location=/);
	assert.match(ok.content[0].text, /References are relative to \/a&amp;b\./);
	const unknown = await call("nope");
	assert.equal(unknown.content[0].text, 'unknown skill "nope" (available: x&quot;&gt;&lt;evil&gt;)');
});

test("an unreadable skill file fails with its path", async () => {
	const { start, call } = setup();
	await start([{ ...tdd, filePath: join(HOME, "gone", "SKILL.md") }]);
	const res = await call("tdd");
	assert.equal(res.isError, true);
	assert.match(res.content[0].text, /not readable: .*gone\/SKILL\.md \(ENOENT\)$/);
});
