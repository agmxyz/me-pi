import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runOracle, summary } from "./guard-oracle.ts";

// The oracle's fixtures must sit outside temp (guard allows temp repos by design), so it keeps the real HOME and
// builds them under a fresh `$HOME/.cache/guard-oracle-*` it removes. No system or global git config is read, and Pi's
// config dir points into a scratch dir; nothing in `~/.pi`, `~/.agents`, or this checkout is touched.
test("guard oracle: no regression against 0.1.3 on the corpus and the generated rows", async (t) => {
	const scratch = mkdtempSync(join(tmpdir(), "guard-oracle-test-"));
	const saved = { ...process.env };
	t.after(() => {
		for (const k of ["GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "PI_CODING_AGENT_DIR"])
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		rmSync(scratch, { recursive: true, force: true });
	});
	writeFileSync(join(scratch, "gitconfig"), "");
	Object.assign(process.env, {
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"),
		PI_CODING_AGENT_DIR: join(scratch, "agent"),
	});
	const r = await runOracle();
	t.diagnostic(summary(r));
	assert.deepEqual(
		r.regressions.map((v) => `[${v.row.cwd}] ${v.row.cmd}  # ${v.row.source}`),
		[],
		"0.1.3 asks and the new guard allows (`npm run guard-oracle -- --list`)",
	);
	// Old gaps are reported, not failed; an unlisted one shows here so it gets a `known` mark or a fix.
	t.diagnostic(`old gaps not marked known: ${r.oldGaps.filter((v) => !v.row.known).length}`);
});
