import { type ErrorSink, fail } from "./errors.ts";

/** Money is always an integer number of cents. */
export type Cents = number;

/** Formats cents as dollars with thousands separators, e.g. `123456` → `$1,234.56`. */
export function formatCents(cents: Cents): string {
	const dollars = Math.trunc(cents / 100);
	const rest = Math.abs(cents % 100);
	return `$${dollars.toLocaleString("en-US")}.${String(rest).padStart(2, "0")}`;
}

/** Parses `12`, `12.5`, `12.50`, or `$12.50` into cents. More than two decimals, signs, or text are errors. */
export function parseMoney(text: string, onError: ErrorSink): Cents | undefined {
	const m = /^\$?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(text.trim());
	if (!m) return fail(onError, "BAD_MONEY", `not an amount: ${JSON.stringify(text)}`);
	return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

/** `percent` of `cents`, rounded half up to a whole cent. */
export function percentOf(cents: Cents, percent: number): Cents {
	return Math.round((cents * percent) / 100);
}

export function sum(values: Cents[]): Cents {
	return values.reduce((total, v) => total + v, 0);
}
