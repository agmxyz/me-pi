import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, "..");
const harness = join(root, "test/fixtures/pi-package-resource-harness.mjs");
const expectedFull = [
	join(root, "extensions/delegate.ts"),
	join(root, "extensions/guard.ts"),
	join(root, "extensions/skill.ts"),
];

async function createPackageFixture(parent) {
	const packageRoot = join(parent, "package");
	await mkdir(packageRoot);
	await cp(join(root, "extensions"), join(packageRoot, "extensions"), { recursive: true });
	await cp(join(root, "skills"), join(packageRoot, "skills"), { recursive: true });
	await symlink(join(root, "node_modules"), join(packageRoot, "node_modules"), "dir");
	await writeFile(
		join(packageRoot, "package.json"),
		`${JSON.stringify(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), null, 2)}\n`,
	);
	return packageRoot;
}

test(
	"Pi 1.3.0 discovers only the root package extensions and honors package filtering",
	{ timeout: 30_000 },
	async (t) => {
		for (const scenario of [
			{
				name: "full local source",
				mode: "full",
				expected: expectedFull,
				tools: [["delegate"], [], ["Skill"]],
				assertion: "assert-delegate",
			},
			{
				name: "guard-only package filter",
				mode: "guard-only",
				expected: [join(root, "extensions/guard.ts")],
				tools: [[]],
			},
			{
				name: "delegate-only package filter",
				mode: "delegate-only",
				expected: [join(root, "extensions/delegate.ts")],
				tools: [["delegate"]],
				assertion: "assert-delegate",
			},
		]) {
			await t.test(scenario.name, async () => {
				const temp = await mkdtemp(join(tmpdir(), "me-pi-resource-test."));
				const agentDir = join(temp, "agent");
				const home = join(temp, "home");
				await mkdir(agentDir);
				await mkdir(home);
				const env = {
					PATH: process.env.PATH ?? "",
					HOME: home,
					PI_CODING_AGENT_DIR: agentDir,
				};
				try {
					const args = [harness, root, scenario.mode];
					if (scenario.assertion) args.push(scenario.assertion);
					const stdout = execFileSync(process.execPath, args, {
						cwd: root,
						env,
						encoding: "utf8",
						timeout: 20_000,
					});
					const result = JSON.parse(stdout);
					assert.equal(result.agentDir, agentDir);
					assert.deepEqual(
						result.extensions.map((extension) => extension.path),
						scenario.expected,
					);
					assert.equal(
						new Set(result.extensions.map((extension) => extension.path)).size,
						scenario.expected.length,
					);
					assert.deepEqual(
						result.extensions.map((extension) => extension.tools),
						scenario.tools,
					);
					assert.deepEqual(result.errors, []);
					assert.deepEqual(result.warnings, []);
					assert.deepEqual(result.skills, []);
					assert.deepEqual(result.skillDiagnostics, []);
					await assert.rejects(lstat(join(agentDir, "AGENTS.md")), { code: "ENOENT" });
					await assert.rejects(lstat(join(agentDir, "GLOBAL_AGENTS.md")), { code: "ENOENT" });
				} finally {
					await rm(temp, { recursive: true, force: true });
				}
			});
		}
	},
);

test(
	"Pi 1.3.0 gates future conventional package skills for full and extension-filtered registrations",
	{ timeout: 30_000 },
	async (t) => {
		const temp = await mkdtemp(join(tmpdir(), "me-pi-skill-gate-test."));
		try {
			const packageRoot = await createPackageFixture(temp);
			const home = join(temp, "home");
			const pilotPath = join(home, ".agents/skills/implement-spec-me-pi/SKILL.md");
			const pilotContent =
				"---\nname: implement-spec-me-pi\ndescription: Isolated pilot collision fixture.\n---\n\nPilot fixture skill.\n";
			await mkdir(dirname(pilotPath), { recursive: true });
			await writeFile(pilotPath, pilotContent);

			for (const scenario of [
				{
					name: "full local source",
					mode: "full",
					expected: [
						join(packageRoot, "extensions/delegate.ts"),
						join(packageRoot, "extensions/guard.ts"),
						join(packageRoot, "extensions/skill.ts"),
					],
					tools: [["delegate"], [], ["Skill"]],
					assertion: "assert-delegate",
				},
				{
					name: "extension-filtered registration",
					mode: "guard-only",
					expected: [join(packageRoot, "extensions/guard.ts")],
					tools: [[]],
				},
			]) {
				await t.test(scenario.name, async () => {
					const agentDir = join(temp, scenario.mode, "agent");
					await mkdir(agentDir, { recursive: true });
					const env = {
						PATH: process.env.PATH ?? "",
						HOME: home,
						PI_CODING_AGENT_DIR: agentDir,
					};
					const args = [harness, packageRoot, scenario.mode];
					if (scenario.assertion) args.push(scenario.assertion);
					const stdout = execFileSync(process.execPath, args, {
						cwd: root,
						env,
						encoding: "utf8",
						timeout: 20_000,
					});
					const result = JSON.parse(stdout);
					assert.equal(result.agentDir, agentDir);
					assert.deepEqual(
						result.extensions.map((extension) => extension.path),
						scenario.expected,
					);
					assert.deepEqual(
						result.extensions.map((extension) => extension.tools),
						scenario.tools,
					);
					assert.deepEqual(result.errors, []);
					assert.deepEqual(result.warnings, []);
					assert.deepEqual(result.skills, [{ name: "implement-spec-me-pi", path: pilotPath }]);
					assert.deepEqual(result.skillDiagnostics, []);
				});
			}
			assert.equal(readFileSync(pilotPath, "utf8"), pilotContent);
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	},
);
