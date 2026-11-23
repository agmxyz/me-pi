// node score.mjs <run-dir> <work-dir>; exit 0 pass, 1 fail, 2 scorer error.
// Pass: correct answer (8.25%, applied after the coupon) in <= 60 words.
// Why 60: the two facts plus where they live fit in ~30 words; 60 leaves room
// for one decision-relevant extra (rounding to cents). Anything past that
// (restating the code, walking through checkout step by step, worked examples,
// headings, offers) changes nothing the reader will tell finance.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 60;
const [runDir, workDir] = process.argv.slice(2);
const done = (code, why, words) => {
	console.log(why);
	if (words !== undefined) console.log(`metric=${words}`);
	process.exit(code);
};
if (!runDir || !workDir) done(2, "usage: score.mjs <run-dir> <work-dir>");

let answer;
try { answer = readFileSync(join(runDir, "answer.txt"), "utf8"); }
catch (e) { done(2, `cannot read answer.txt: ${e.message}`); }

// Words: whole reply, code included (a code block costs the reader too);
// markdown markers alone are not words.
const words = answer.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// Correctness on the raw reply for the rate (may sit in code), prose for timing.
if (!/8\.25\s*%|8\.25 percent|0\.0825/i.test(answer)) done(1, "rate 8.25% not stated", words);
const prose = answer.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " CODE ");
const after = /\bafter\b|\bdiscounted\b|\bpost-discount\b/i.test(prose);
const wrongBefore = /\b(applied|charged|taxed|computed)\s+before\s+(the\s+)?(coupon|discount)/i.test(prose);
if (!after || wrongBefore) done(1, "does not say tax is applied after the coupon", words);

if (words > LIMIT) done(1, `correct but ${words} words > ${LIMIT}`, words);
done(0, `correct in ${words} words`, words);
