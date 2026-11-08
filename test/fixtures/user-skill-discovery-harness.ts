// Real Pi user-skill discovery probe for isolated installer fixtures; no model calls.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const [projectDir, expectedCollision] = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!projectDir || !agentDir) throw new Error("Pass a target project and isolated PI_CODING_AGENT_DIR");

const cwd = resolve(projectDir);
const resolvedAgentDir = resolve(agentDir);
const settingsManager = SettingsManager.create(cwd, resolvedAgentDir, { projectTrusted: true });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: resolvedAgentDir, settingsManager });
await resourceLoader.reload();

const { skills, diagnostics } = resourceLoader.getSkills();
const byName = new Map(skills.map((skill) => [skill.name, skill]));
const expectedNames = [
	"implement",
	"implement-me-pi",
	"implement-spec",
	"implement-spec-me-pi",
	"pi-live-test",
	"ticket-readiness",
];
assert.deepEqual([...byName.keys()].sort(), expectedNames);
if (expectedCollision === "--renamed-pilot-collision") {
	assert.equal(diagnostics.length, 1);
	assert.equal(diagnostics[0].type, "collision");
	assert.equal(diagnostics[0].collision.resourceType, "skill");
	assert.equal(diagnostics[0].collision.name, "implement-spec-me-pi");
	assert.equal(
		diagnostics[0].collision.winnerPath,
		join(resolvedAgentDir, "skills", "implement-spec-me-pi", "SKILL.md"),
	);
	assert.equal(
		diagnostics[0].collision.loserPath,
		join(process.env.HOME, ".agents", "skills", "implement-spec-me-pi.pilot-bak", "SKILL.md"),
	);
} else {
	assert.deepEqual(diagnostics, []);
}

for (const name of ["implement-me-pi", "implement-spec-me-pi", "pi-live-test"]) {
	const skill = byName.get(name);
	assert.equal(skill.filePath, join(resolvedAgentDir, "skills", name, "SKILL.md"));
	assert.equal(skill.disableModelInvocation, true);
}
// Model-invocable: read-only, and a future ship skill calls it.
const readiness = byName.get("ticket-readiness");
assert.equal(readiness.filePath, join(resolvedAgentDir, "skills", "ticket-readiness", "SKILL.md"));
assert.equal(readiness.disableModelInvocation, false);

for (const name of ["implement", "implement-spec"]) {
	assert.equal(byName.get(name).filePath, join(process.env.HOME, ".agents", "skills", name, "SKILL.md"));
}

assert.equal(existsSync(join(cwd, ".agents", "skills")), false);
assert.equal(existsSync(join(cwd, ".pi", "skills")), false);
