import { existsSync, mkdirSync, realpathSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const markerName = ".delegate-workflow-scratch.json";
const fixtureMarker = ".workflow-fixture";

function enable(rootArg, arm) {
	if (!rootArg || !["a", "b"].includes(arm)) throw new Error("usage: node test/workflow/set-oracle.mjs <scratch-root> <a|b>");
	const root = resolve(rootArg);
	const indexPath = join(root, markerName);
	if (!existsSync(indexPath)) throw new Error(`not a prepared delegate-workflow scratch root: ${root}`);
	const index = JSON.parse(readFileSync(indexPath, "utf8"));
	if (index.format !== "delegate-workflow-scratch-v1") throw new Error(`unrecognized scratch format in ${indexPath}`);
	const realRoot = realpathSync(root);
	const goalsRoot = realpathSync(join(realRoot, "goals"));
	const goal = realpathSync(resolve(index.goals?.[arm] ?? ""));
	if (dirname(goal) !== goalsRoot || basename(goal) !== arm) throw new Error(`goal path is outside the prepared scratch root: ${goal}`);
	if (readFileSync(join(goal, fixtureMarker), "utf8") !== "delegate-workflow-fixture-v1\n") {
		throw new Error(`fixture marker mismatch: ${goal}`);
	}
	const gateDir = join(goal, ".workflow");
	const gate = join(gateDir, "oracle.ready");
	if (existsSync(gate)) throw new Error(`oracle is already enabled: ${gate}`);
	if (existsSync(gateDir) && realpathSync(gateDir) !== gateDir) {
		throw new Error(`oracle gate directory resolves outside its scratch goal: ${gateDir}`);
	}
	if (!existsSync(gateDir)) mkdirSync(gateDir);
	if (realpathSync(gateDir) !== gateDir) throw new Error(`oracle gate directory resolves outside its scratch goal: ${gateDir}`);
	writeFileSync(gate, `enabled by harness at ${new Date().toISOString()}\n`, { flag: "wx" });
	console.log(`Enabled ${arm.toUpperCase()} scratch oracle: ${gate}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		enable(process.argv[2], process.argv[3]);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
