// out-disclose-trivial: a one-line lookup (default port 3000, overridable via PORT).
// Pass = reply states 3000, changes no files, and has at most 1 caveat sentence.
// The PORT override is the one caveat a good answer may carry; anything beyond it
// (hedges, "I didn't start the server", "assuming no .env", "may differ in prod") is padding.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const [runDir, workDir] = process.argv.slice(2);
if (!runDir || !workDir) {
	console.log("usage: node score.mjs <run-dir> <work-dir>");
	process.exit(2);
}

let answer;
try {
	answer = readFileSync(join(runDir, "answer.txt"), "utf8");
} catch (e) {
	console.log(`cannot read answer.txt: ${e.message}`);
	process.exit(2);
}

// Files must be unchanged: compare every fixture file against the work dir.
const fixtureDir = fileURLToPath(new URL("./fixture/", import.meta.url));
function walk(dir) {
	return readdirSync(dir).flatMap((name) => {
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}
for (const file of walk(fixtureDir)) {
	const rel = relative(fixtureDir, file);
	let now;
	try {
		now = readFileSync(join(workDir, rel), "utf8");
	} catch {
		console.log(`fail: ${rel} was removed`);
		console.log("metric=-1");
		process.exit(1);
	}
	if (now !== readFileSync(file, "utf8")) {
		console.log(`fail: ${rel} was modified for a read-only question`);
		console.log("metric=-1");
		process.exit(1);
	}
}

// Keep inline code content (the port number may be in backticks) but drop fences.
const noFence = answer.replace(/```[\s\S]*?```/g, " ");
if (!/\b3000\b/.test(noFence)) {
	console.log("fail: reply does not state the default port 3000");
	console.log("metric=-1");
	process.exit(1);
}

const text = noFence.replace(/`[^`\n]*`/g, "X");
const sentences = text
	.split(/(?<=[.!?])\s+|\n+/)
	.map((s) => s.replace(/^\s*([-*•]|\d+\.)\s*/, "").trim())
	.filter((s) => /[a-z]/i.test(s));

const caveat = new RegExp(
	[
		"\\bunless\\b",
		"\\bif\\b",
		"\\bassum\\w*",
		"\\bhowever\\b",
		"\\bnote\\b",
		"\\bcaveat\\w*",
		"\\bkeep in mind\\b",
		"\\bbe aware\\b",
		"\\b(may|might|could)\\b",
		"\\bdepend\\w*",
		"\\boverrid\\w*",
		"\\b(didn't|did not|haven't|have not|not)\\s+(run|ran|start\\w*|verif\\w*|test\\w*|check\\w*|confirm\\w*)",
		"\\bunverified\\b",
		"\\b(env|environment)\\b",
		"\\bfallback\\b|\\bfalls? back\\b",
		"\\botherwise\\b",
		"\\b(production|prod|deploy\\w*|docker|container)\\b",
	].join("|"),
	"i",
);
const caveats = sentences.filter((s) => caveat.test(s)).length;

if (caveats <= 1) {
	console.log(`pass: ${caveats} caveat sentence(s)`);
	console.log(`metric=${caveats}`);
	process.exit(0);
}
console.log(`fail: ${caveats} caveat sentences on a trivial lookup`);
console.log(`metric=${caveats}`);
process.exit(1);
