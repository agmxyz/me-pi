/**
 * guard.ts's own rules, reused unchanged. The rules the spike needs (`DISPOSABLE`, `tmpdirMayChange`, `gitRisk`,
 * `hasShort`, `TMPDIR_REF`) aren't exported, so this loads a byte-for-byte copy of guard.ts with one appended export
 * line. Nothing in guard.ts changes; if it does, the copy follows on the next run.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const guardPath = join(here, "../../packages/pi-workers/extensions/guard.ts");
const cache = join(here, ".cache");
mkdirSync(cache, { recursive: true });
const source = readFileSync(guardPath, "utf8").replace(
	'from "./delegate-env.ts"',
	`from ${JSON.stringify(join(dirname(guardPath), "delegate-env.ts"))}`,
);
const copy = join(cache, "guard-copy.ts");
writeFileSync(copy, `${source}\nexport { DISPOSABLE, tmpdirMayChange, gitRisk, hasShort, TMPDIR_REF };\n`);

interface GuardInternals {
	classify(command: string, currentBranch?: () => string | undefined): string | undefined;
	DISPOSABLE: RegExp;
	TMPDIR_REF: string;
	tmpdirMayChange(command: string): boolean;
	hasShort(words: string[], letter: string, long?: string): boolean;
	gitRisk(
		sub: string,
		words: string[],
		currentBranch: () => string | undefined,
		elsewhere: boolean,
	): string | undefined;
}

export const guard: GuardInternals = await import(copy);

// classify's inline `..` check (`!/(?:^|\/)\.\.(?:\/|$)/.test(t)`), the one rule that isn't a named binding.
const DOTDOT = /(?:^|\/)\.\.(?:\/|$)/;

/** A recursive-rm target guard would let through, by guard's rules (`DISPOSABLE`, no `..`, `${TMPDIR:?}` only when safe). */
export function disposable(target: string, command: string): boolean {
	return (
		guard.DISPOSABLE.test(target) &&
		!DOTDOT.test(target) &&
		!(target.startsWith(guard.TMPDIR_REF) && guard.tmpdirMayChange(command))
	);
}

/**
 * rm's recursion as rm itself reads its argv: options end at `--`; a short cluster with `r`/`R`, `--recursive`, or an
 * unambiguous GNU prefix of it (`--r`, `--rec`). guard's own `hasShort` covers the first two; the prefix is the #78 gap.
 */
export function rmRecursive(options: string[]): boolean {
	return (
		guard.hasShort(options, "[rR]", "--recursive") ||
		options.some((o) => o.length >= 3 && "--recursive".startsWith(o))
	);
}

/** Splits rm's argv into options and operands the way getopt does (GNU permutes: options may follow operands). */
export function rmSplit(args: string[]): { options: string[]; operands: string[] } {
	const end = args.indexOf("--");
	const before = end < 0 ? args : args.slice(0, end);
	const after = end < 0 ? [] : args.slice(end + 1);
	return {
		options: before.filter((a) => a.startsWith("-") && a !== "-"),
		operands: [...before.filter((a) => !a.startsWith("-") || a === "-"), ...after],
	};
}

/** git's global options before the sub-command (`-C dir`, `-c k=v`, `--git-dir=x`); the rest is the sub-command. */
export function gitSplit(args: string[]): { globals: string[]; sub: string | undefined; words: string[] } {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		const a = args[i];
		if (a === "-C" || a === "-c" || /^--(?:git-dir|work-tree|namespace|super-prefix|exec-path|config-env)$/.test(a))
			i += 2;
		else i++;
	}
	return { globals: args.slice(0, i), sub: args[i], words: args.slice(i + 1) };
}

export const movesGit = (globals: string[]) =>
	globals.some((g) => g === "-C" || /^--(?:git-dir|work-tree)(?:=|$)/.test(g));
