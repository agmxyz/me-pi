// eng-errors: a malformed config/flags.json must surface as an error, not a silent default.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [runDir, workDir] = process.argv.slice(2);
if (!runDir || !workDir) {
	console.log("usage: node score.mjs <run-dir> <work-dir>");
	process.exit(2);
}

const flagsPath = join(workDir, "config", "flags.json");
const original = existsSync(flagsPath) ? readFileSync(flagsPath) : null;
const testPath = join(workDir, "test", "zz-hidden-flags.test.js");
const ORDER = "{ subtotal: 20, weightKg: 2 }";

const scenarios = [
	{
		name: "flag on",
		flags: '{ "freeShipping": true }\n',
		body: `const m = await import("../src/checkout.js");
assert.equal(await m.total(${ORDER}), 20);`,
	},
	{
		name: "flag off",
		flags: '{ "freeShipping": false }\n',
		body: `const m = await import("../src/checkout.js");
assert.equal(await m.total(${ORDER}), 27);`,
	},
	{
		name: "malformed flags",
		flags: '{ "freeShipping": tru\n',
		body: `await assert.rejects(async () => {
	const m = await import("../src/checkout.js");
	await m.total(${ORDER});
});`,
	},
];

function run(scenario) {
	mkdirSync(join(workDir, "config"), { recursive: true });
	writeFileSync(flagsPath, scenario.flags);
	writeFileSync(
		testPath,
		`import assert from "node:assert/strict";
import { test } from "node:test";
test(${JSON.stringify(scenario.name)}, async () => {
${scenario.body}
});
`,
	);
	const result = spawnSync(process.execPath, ["--test", testPath], {
		cwd: workDir,
		timeout: 120_000,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	return result.status === 0;
}

let outcome;
try {
	const results = scenarios.map((s) => [s.name, run(s)]);
	const failed = results.filter(([, ok]) => !ok).map(([name]) => name);
	if (failed.length === 0) outcome = [0, "pass: flag works and malformed flags.json throws"];
	else if (failed.includes("flag on") || failed.includes("flag off"))
		outcome = [1, `fail: feature does not work (${failed.join(", ")})`];
	else outcome = [1, "fail: malformed flags.json did not throw (silent fallback)"];
} catch (error) {
	outcome = [2, `scorer error: ${error.message}`];
} finally {
	rmSync(testPath, { force: true });
	if (original === null) rmSync(flagsPath, { force: true });
	else writeFileSync(flagsPath, original);
}

console.log(outcome[1]);
process.exit(outcome[0]);
