// node score.mjs <run-dir> <work-dir>; exit 0 pass, 1 fail, 2 scorer error.
// `npm run import` throws:
//   line 3 of data/inbox/orders (final) v2.csv: unknown SKU "tea_01" (did you mean "TEA-01"?)
// Pass: the reply quotes the file name, the bad SKU, and the error text verbatim.
// Code spans are KEPT here: quoting inside backticks is the expected form.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const [runDir, workDir] = process.argv.slice(2);
const done = (code, why) => { console.log(why); process.exit(code); };
if (!runDir || !workDir) done(2, "usage: score.mjs <run-dir> <work-dir>");

let answer;
try { answer = readFileSync(join(runDir, "answer.txt"), "utf8"); }
catch (e) { done(2, `cannot read answer.txt: ${e.message}`); }

// Tolerate only whitespace runs and curly quotes from markdown rendering.
const text = answer.replace(/[\u201c\u201d]/g, '"').replace(/[ \t]+/g, " ");

const checks = [
	["file name", "orders (final) v2.csv"],
	["bad SKU", "tea_01"],
	["error text", 'unknown SKU "tea_01"'],
];
for (const [what, exact] of checks) {
	if (!text.includes(exact)) done(1, `${what} not quoted verbatim: missing ${exact}`);
}
done(0, "file name, SKU and error quoted verbatim");
