import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BASE_SHA, prepareScratch } from "./prepare.mjs";

const HERE = new URL(".", import.meta.url);
const WORKFLOW_DIR = fileURLToPath(HERE);
const REPO_ROOT = resolve(WORKFLOW_DIR, "../..");
const TEMP = mkdtempSync(join(tmpdir(), "delegate-workflow-test-"));
process.on("exit", () => rmSync(TEMP, { recursive: true, force: true }));

test("candidate artifacts are model-invocable, routed, and within the inline word budget", () => {
	const guidelines = JSON.parse(readFileSync(join(WORKFLOW_DIR, "candidate/prompt-guidelines.json"), "utf8"));
	assert.ok(Array.isArray(guidelines) && guidelines.length <= 8);
	assert.ok(guidelines.join(" ").trim().split(/\s+/).length <= 240);
	assert.ok(guidelines.some((line) => /spec, ticketed goal \(including a single ticket\), or PR workflow/.test(line)));
	assert.doesNotMatch(guidelines.join(" "), /Approval rules|review rules are met by your goal-end review/);
	const skill = readFileSync(join(WORKFLOW_DIR, "candidate/implement-goal/SKILL.md"), "utf8");
	assert.match(skill, /^---\nname: implement-goal\ndescription: .+\n---/);
	assert.match(skill.split("\n").slice(0, 5).join("\n"), /single-ticket goal/);
	assert.doesNotMatch(skill.split("\n").slice(0, 5).join("\n"), /disable-model-invocation/);
	assert.match(skill, /## Goal review and delivery/);
	assert.match(skill, /later goal-wide review/);
	assert.doesNotMatch(skill, /under the Approval rules|their review rules are met by your goal-end review/);
});

test("preparation builds isolated A/B scratch artifacts and verifies real Pi package discovery", async () => {
	const liveDelegate = readFileSync(join(REPO_ROOT, "extensions/delegate.ts"), "utf8");
	const liveManifest = readFileSync(join(REPO_ROOT, "extensions/package.json"), "utf8");
	const root = join(TEMP, "prepared");
	const prepared = await prepareScratch({ repoRoot: REPO_ROOT, scratchRoot: root });
	assert.equal(prepared.base, BASE_SHA);
	assert.equal(prepared.piVersion, "1.3.0");
	assert.equal(readFileSync(join(REPO_ROOT, "extensions/delegate.ts"), "utf8"), liveDelegate);
	assert.equal(readFileSync(join(REPO_ROOT, "extensions/package.json"), "utf8"), liveManifest);

	const baseline = JSON.parse(readFileSync(join(prepared.packages.a, "extensions/package.json"), "utf8"));
	const candidate = JSON.parse(readFileSync(join(prepared.packages.b, "extensions/package.json"), "utf8"));
	assert.equal(baseline.pi.skills, undefined);
	assert.deepEqual(candidate.pi.skills, ["./skills"]);
	assert.deepEqual(candidate.pi.extensions, baseline.pi.extensions);
	assert.ok(existsSync(join(prepared.packages.b, "extensions/skills/implement-goal/SKILL.md")));
	const patched = readFileSync(join(prepared.packages.b, "extensions/delegate.ts"), "utf8");
	for (const line of JSON.parse(readFileSync(join(WORKFLOW_DIR, "candidate/prompt-guidelines.json"), "utf8"))) {
		assert.ok(patched.includes(JSON.stringify(line)), "candidate prompt contains each source guideline");
	}

	assert.equal(prepared.discovery.a.delegateTools, 1);
	assert.equal(prepared.discovery.a.skill.discovered, false);
	assert.equal(prepared.discovery.b.delegateTools, 1);
	assert.deepEqual(prepared.discovery.b.skill, {
		discovered: true,
		source: "skill",
		origin: "package",
		path: join(prepared.packages.b, "extensions/skills/implement-goal/SKILL.md"),
	});
	assert.equal(prepared.discovery.b.modelInvoked, false);
	assert.equal(
		JSON.parse(readFileSync(join(root, "artifact-index.json"), "utf8")).liveComparison,
		"UNRUN: authenticated lifecycle comparison not performed",
	);

	for (const arm of ["a", "b"]) {
		const goal = prepared.goals[arm];
		assert.equal(execFileSync("git", ["-C", goal, "status", "--porcelain"], { encoding: "utf8" }).trim(), "");
		assert.equal(execFileSync("git", ["-C", goal, "remote"], { encoding: "utf8" }).trim(), "");
		assert.equal(existsSync(join(goal, ".workflow/oracle.ready")), false);
	}

	const blocked = spawnSync(process.execPath, [join(WORKFLOW_DIR, "fixture/scripts/check.mjs"), "T1"], {
		cwd: prepared.goals.a,
		encoding: "utf8",
	});
	assert.equal(blocked.status, 1);
	assert.match(`${blocked.stdout}${blocked.stderr}`, /^BLOCKED: oracle unavailable/m);

	const enabled = spawnSync(process.execPath, [join(WORKFLOW_DIR, "set-oracle.mjs"), root, "a"], { encoding: "utf8" });
	assert.equal(enabled.status, 0, enabled.stderr);
	assert.equal(existsSync(join(prepared.goals.a, ".workflow/oracle.ready")), true);
	writeFileSync(
		join(prepared.goals.a, "src/math.mjs"),
		"export function sum(values) { return values.reduce((total, value) => total + value, 0); }\nexport function mean(values) { return values.length ? sum(values) / values.length : 0; }\n",
	);
	const t1Check = spawnSync(process.execPath, [join(WORKFLOW_DIR, "fixture/scripts/check.mjs"), "T1"], {
		cwd: prepared.goals.a,
		encoding: "utf8",
	});
	assert.equal(t1Check.status, 0, t1Check.stderr || t1Check.stdout);
	const fullCheck = spawnSync(process.execPath, [join(WORKFLOW_DIR, "fixture/scripts/check.mjs"), "all"], {
		cwd: prepared.goals.a,
		encoding: "utf8",
	});
	assert.equal(fullCheck.status, 0, fullCheck.stderr || fullCheck.stdout);
	const duplicate = spawnSync(process.execPath, [join(WORKFLOW_DIR, "set-oracle.mjs"), root, "a"], { encoding: "utf8" });
	assert.notEqual(duplicate.status, 0);
	assert.match(duplicate.stderr, /oracle is already enabled/);

	for (const script of [
		join(WORKFLOW_DIR, "prepare.mjs"),
		join(WORKFLOW_DIR, "set-oracle.mjs"),
		join(WORKFLOW_DIR, "fixture/scripts/check.mjs"),
	]) {
		const syntax = spawnSync(process.execPath, ["--check", script], { encoding: "utf8" });
		assert.equal(syntax.status, 0, `${script}: ${syntax.stderr}`);
	}
});
