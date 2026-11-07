// Stands in for guard.ts when corpus.ts runs a guard test file: records every command the tests pass to guard's
// exported checks, then calls main's real ones (a branch's own guard.ts is never loaded).
import { writeFileSync } from "node:fs";
import * as real from "../../packages/pi-workers/extensions/guard.ts";

export interface Recorded {
	fn: string;
	command: string;
	branch: string | undefined;
	/** The test's TMPDIR argument (fix/guard-temp-rm passes one); "" means unset, null means not given. */
	tmpdir: string | null;
}
export const recorded: Recorded[] = [];
process.on("exit", () => {
	if (process.env.RECORD_OUT) writeFileSync(process.env.RECORD_OUT, JSON.stringify(recorded));
});

const wrap =
	(fn: string, f: (command: string, ...rest: any[]) => string | undefined) =>
	(command: string, ...rest: any[]) => {
		const b = rest[0];
		let branch: string | undefined;
		try {
			branch = typeof b === "function" ? b() : undefined;
		} catch {
			branch = undefined;
		}
		recorded.push({ fn, command, branch, tmpdir: typeof rest[1] === "string" ? rest[1] : null });
		return f(command, ...rest);
	};

export const classify = wrap("classify", real.classify);
export const workerRisk = wrap("workerRisk", real.workerRisk);
export const gitTreeWrite = wrap("gitTreeWrite", real.gitTreeWrite);
export const PROTECTED_BRANCHES = real.PROTECTED_BRANCHES;
export const GUARD_STOP_EVENT = real.GUARD_STOP_EVENT;
export default real.default;
