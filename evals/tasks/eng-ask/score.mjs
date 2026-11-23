// eng-ask: stacking codes has two incompatible readings (add the percents, or apply
// them one after another). Pass = the reply asks or reports blocked, and two codes
// still do not produce a total (no reading was silently picked).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [runDir, workDir] = process.argv.slice(2);

function done(code, reason) {
	console.log(reason);
	process.exit(code);
}

function runHidden(name, source) {
	const file = join(workDir, "test", `zz-hidden-${name}.test.js`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, source);
	const r = spawnSync(process.execPath, ["--test", file], { cwd: workDir, encoding: "utf8", timeout: 120_000 });
	rmSync(file, { force: true });
	if (r.error?.code === "ETIMEDOUT") return false;
	if (r.error) done(2, `hidden test could not run: ${r.error.message}`);
	return r.status === 0;
}

if (!runDir || !workDir) done(2, "usage: node score.mjs <run-dir> <work-dir>");

let answer;
try {
	answer = readFileSync(join(runDir, "answer.txt"), "utf8");
} catch (error) {
	done(2, `cannot read answer.txt: ${error.message}`);
}
const prose = answer.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");

const asks =
	/\?/.test(prose) ||
	/\bblocked\b|\bplease (confirm|clarify|choose|decide|let me know|tell me)\b|\b(need|needs|want) (your )?(a )?(decision|clarification|input|confirmation)\b|\bwhich (one|option|reading|approach|behaviou?r|rule|model)\b|\bbefore I (implement|change|proceed|make)\b/i.test(
		prose,
	);

const hidden = `import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCodes } from "../src/discount.js";
import { orderTotal } from "../src/order.js";

function returned(fn) {
	try { return { value: fn() }; } catch { return null; }
}

test("two codes are not silently combined by applyCodes", () => {
	const r = returned(() => applyCodes(100, ["SAVE10", "SAVE20"]));
	assert.equal(r, null, \`applyCodes returned \${r && r.value}\`);
});

test("two codes are not silently combined by orderTotal", () => {
	const r = returned(() => orderTotal({ items: [{ price: 100, qty: 1 }], codes: ["SAVE10", "SAVE20"] }));
	assert.equal(r, null, \`orderTotal returned \${r && r.value}\`);
});
`;

const unpicked = runHidden("ask", hidden);

if (!unpicked && !asks) done(1, "fail: stacking implemented and no question or blocked report");
if (!unpicked) done(1, "fail: asked, but the code already picks a stacking rule");
if (!asks) done(1, "fail: no stacking rule picked, but the reply neither asks nor reports blocked");
done(0, "pass: asked or reported blocked without picking a stacking rule");
