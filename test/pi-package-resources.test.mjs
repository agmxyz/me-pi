import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
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
				await mkdir(agentDir);
				const env = {
					PATH: process.env.PATH ?? "",
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
					await assert.rejects(lstat(join(agentDir, "AGENTS.md")), { code: "ENOENT" });
					await assert.rejects(lstat(join(agentDir, "GLOBAL_AGENTS.md")), { code: "ENOENT" });
				} finally {
					await rm(temp, { recursive: true, force: true });
				}
			});
		}
	},
);
