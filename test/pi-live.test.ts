import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const SCRIPT = new URL("../skills/pi-live-test/pi-live.sh", import.meta.url).pathname;

/** Runs pi-live.sh with stub `herdr` and `tmux` on PATH; each stub logs its argv and runs `body`. */
function piLive(t: any, stubs: Record<string, string>, args: string[], env: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-live-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const log = join(dir, "calls.log");
	for (const [name, body] of Object.entries(stubs)) {
		const path = join(dir, name);
		writeFileSync(path, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
		chmodSync(path, 0o755);
	}
	const res = spawnSync("bash", [SCRIPT, ...args], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...env },
	});
	const calls = (() => {
		try {
			return readFileSync(log, "utf8").trim().split("\n");
		} catch {
			return [];
		}
	})();
	return { ...res, calls };
}

test("herdr ask does not resend a prompt whose wait failed", (t) => {
	const res = piLive(
		t,
		{ herdr: `[ "$1 $2" = "agent prompt" ] && { echo "timed out waiting" >&2; exit 1; }; echo screen` },
		["ask", "herdr:p1", "check"],
	);
	assert.notEqual(res.status, 0);
	assert.match(res.stderr, /timed out waiting/);
	assert.equal(res.calls.filter((c) => c.startsWith("herdr agent prompt")).length, 1, res.calls.join("\n"));
});

test("herdr ask retries a stalled prompt once", (t) => {
	const res = piLive(
		t,
		{
			herdr: `if [ "$1 $2" = "agent prompt" ]; then
  n=$(grep -c "agent prompt" "$(dirname "$0")/calls.log")
  [ "$n" -eq 1 ] && { echo '{"error":"agent_prompt_stalled"}'; exit 1; }
fi
echo screen`,
		},
		["ask", "herdr:p1", "check"],
	);
	assert.equal(res.status, 0, res.stderr);
	assert.equal(res.calls.filter((c) => c.startsWith("herdr agent prompt")).length, 2, res.calls.join("\n"));
	assert.match(res.stdout, /screen/);
});

test("a start that never settles kills its tmux session", (t) => {
	const res = piLive(
		t,
		{ tmux: `[ "$1" = capture-pane ] && echo "ctrl+c/ctrl+d $RANDOM$RANDOM"; exit 0` },
		["start", tmpdir()],
		{ PI_LIVE_TIMEOUT: "2" },
	);
	assert.notEqual(res.status, 0);
	assert.equal(res.stdout, "");
	assert.ok(
		res.calls.some((c) => /^tmux kill-session -t pi-live-\d+$/.test(c)),
		res.calls.join("\n"),
	);
});
