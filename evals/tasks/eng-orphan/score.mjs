// eng-orphan: receipt lines should reuse the existing formatMoney (src/format.js).
// Switching receipt.js away from twoDecimals leaves it with no caller in src/, while
// src/decimal.js keeps the live percentLabel. Pass = hidden test sees "$1,250.00" on
// receipts and invoices still work, receipt.js imports formatMoney from ./format.js,
// and twoDecimals is removed or still called from another file under src/.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

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

function sourceFiles(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name.startsWith(".")) continue;
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
		else if (/\.(c|m)?js$/.test(name)) out.push(path);
	}
	return out;
}

// Source text without comments, so a comment mentioning a name does not count as use.
function code(path) {
	return readFileSync(path, "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

if (!runDir || !workDir) done(2, "usage: node score.mjs <run-dir> <work-dir>");

const hidden = `import { test } from "node:test";
import assert from "node:assert/strict";
import { receiptLines } from "../src/receipt.js";
import { invoiceSummary } from "../src/invoice.js";

test("receipt lines show formatted money", () => {
	assert.deepEqual(receiptLines([{ name: "Desk", amount: 1250 }, { name: "Pen", amount: 2.5 }]), ["Desk: $1,250.00", "Pen: $2.50"]);
});

test("invoices still work", () => {
	const invoice = { id: "B2", taxRate: 0.2, items: [{ amount: 40 }] };
	assert.equal(invoiceSummary(invoice), "Invoice B2: $40.00 due (tax 20% included)");
});
`;

if (!runHidden("orphan", hidden)) done(1, "fail: receipt lines not \"Desk: $1,250.00\", or invoices broke");

const receipt = code(join(workDir, "src", "receipt.js"));
if (!/import\s*\{[^}]*\bformatMoney\b[^}]*\}\s*from\s*["']\.\/format\.js["']/.test(receipt)) {
	done(1, "fail: src/receipt.js does not reuse formatMoney from ./format.js");
}

const srcFiles = sourceFiles(join(workDir, "src"));
const defines = srcFiles.filter((f) => /\bfunction\s+twoDecimals\b|\btwoDecimals\s*=/.test(code(f)));
if (defines.length === 0) done(0, "pass: formatMoney reused and the orphaned twoDecimals removed");

const callers = srcFiles.filter((f) => !defines.includes(f) && /\btwoDecimals\b/.test(code(f)));
if (callers.length === 0) {
	done(1, `fail: twoDecimals left in ${defines.map((f) => relative(workDir, f)).join(", ")} with no caller in src/`);
}
done(0, `pass: formatMoney reused; twoDecimals still called from ${callers.map((f) => relative(workDir, f)).join(", ")}`);
