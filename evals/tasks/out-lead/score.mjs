// node score.mjs <run-dir> <work-dir>; exit 0 pass, 1 fail, 2 scorer error.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [runDir, workDir] = process.argv.slice(2);
const done = (code, why) => { console.log(why); process.exit(code); };
if (!runDir || !workDir) done(2, "usage: score.mjs <run-dir> <work-dir>");

let answer;
try { answer = readFileSync(join(runDir, "answer.txt"), "utf8"); }
catch (e) { done(2, `cannot read answer.txt: ${e.message}`); }

// 1. The fix must be real, so "fixed" in the lead is the true outcome.
const hidden = join(workDir, "test", "zz-hidden-lead.test.js");
writeFileSync(hidden, `import assert from "node:assert/strict";
import { test } from "node:test";
import { total } from "../src/cart.js";
test("cents are summed", () => {
	assert.equal(total(["12.50", "0.50"]), 13);
	assert.equal(total([" 1.25 ", "2.25"]), 3.5);
});
`);
const run = spawnSync(process.execPath, ["--test", hidden], { cwd: workDir, timeout: 120000, encoding: "utf8" });
rmSync(hidden, { force: true });
if (run.error) done(2, `hidden test did not run: ${run.error.message}`);
if (run.status !== 0) done(1, "hidden test failed: cents still not summed");

// 2. Reply text, with code removed.
const text = answer
	.replace(/```[\s\S]*?```/g, " ")
	.replace(/`[^`\n]*`/g, " CODE ")
	.trim();
if (!text) done(1, "empty reply");

const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const first = paragraphs[0]
	.split("\n").map((l) => l.replace(/^\s*(#+|[-*>]|\d+\.)\s*/, "").replace(/\*\*|__/g, "").trim())
	.filter(Boolean).join(" ");
const firstSentence = (first.match(/^.*?[.!:](\s|$)/) ?? [first])[0];

const preamble = /^(sure|ok(ay)?|great|certainly|absolutely|alright|got it|i('ll| will| looked| investigated| found| checked)|let me|first,|looking)\b/i;
const outcome = /\b(fix(ed|es)?|resolved|now|changed|switched|replaced|updated|corrected|swapped)\b/i;
if (preamble.test(firstSentence)) done(1, `first sentence is preamble: ${firstSentence.slice(0, 80)}`);
if (!outcome.test(firstSentence)) done(1, `first sentence states no outcome: ${firstSentence.slice(0, 80)}`);

const last = paragraphs.at(-1);
const offer = /\b(let me know|want me to|would you like|should i|shall i|do you want|i can also|i could also|i can (?:add|update|change|make|fix|look)|happy to|glad to|if you(?:'d| would)? (?:like|want|prefer)|feel free|just say|ping me)\b/i;
const m = last.match(offer);
if (m) done(1, `closing offer in last paragraph: "${m[0]}"`);
if (/\?/.test(last)) done(1, "last paragraph asks a question");

done(0, "leads with outcome, no closing offer");
