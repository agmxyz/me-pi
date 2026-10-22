import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const gate = resolve(".workflow/oracle.ready");
if (!existsSync(gate)) {
	console.error("BLOCKED: oracle unavailable");
	process.exit(1);
}

const target = process.argv[2];
if (target !== "T1" && target !== "all") throw new Error("usage: node scripts/check.mjs <T1|all>");
const pattern = target === "T1" ? ["--test-name-pattern", "^sum"] : [];
const result = spawnSync(process.execPath, ["--test", ...pattern, "test/smoke.test.mjs"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
