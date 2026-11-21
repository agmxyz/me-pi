import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { run } from "../src/cli.ts";
import { collect, type ErrorSink } from "../src/errors.ts";

/** A sink that fails the test on any error. */
export const noError: ErrorSink = (error) => assert.fail(`unexpected ${error.code}: ${error.message}`);

/** Calls `fn` with a collecting sink and returns the single error code it reported. */
export function errorOf(fn: (onError: ErrorSink) => unknown): string {
	const { sink, errors } = collect();
	fn(sink);
	assert.equal(errors.length, 1, `want one error, got ${errors.length}`);
	return errors[0].code;
}

/** A CLI bound to a state file in a fresh temp dir, removed after the test. */
export function cli(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "inv-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "inventory.json");
	return { file, run: (...argv: string[]) => run(argv, file) };
}
