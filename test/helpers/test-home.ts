// Imported first by every delegate test file (directly or through delegate-harness.ts), before any package module: `delegate-config` reads the home directory
// when it loads. HOME, TMPDIR, and PI_CODING_AGENT_DIR point into a per-process temp dir, so neither the tests nor
// the workers they launch can reach the real ~/.pi or ~/.agents.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_HOME = mkdtempSync(join(tmpdir(), "delegate-test-"));
process.on("exit", () => rmSync(TEST_HOME, { recursive: true, force: true }));
const agentDir = join(TEST_HOME, ".pi", "agent");
mkdirSync(agentDir, { recursive: true });
Object.assign(process.env, { HOME: TEST_HOME, TMPDIR: TEST_HOME, PI_CODING_AGENT_DIR: agentDir });
