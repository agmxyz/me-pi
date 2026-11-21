import { type ErrorSink, fail } from "./errors.ts";

/** A SKU is three letters, a dash, and four digits: `ABC-1234`. */
const SKU = /^[A-Z]{3}-\d{4}$/;

/** Trims and upper-cases a raw SKU, so `" abc-1234 "` and `"ABC-1234"` name the same product. */
export const normalizeSku = (raw: string) => raw.trim().toUpperCase();

export function parseSku(raw: string, onError: ErrorSink): string | undefined {
	const sku = normalizeSku(raw);
	if (!SKU.test(sku)) return fail(onError, "BAD_SKU", `not a SKU (want ABC-1234): ${JSON.stringify(raw)}`);
	return sku;
}

/** `raw` as a number when it is digits only; signs and decimals in text become `NaN`. */
function unitsOf(raw: string | number): number {
	if (typeof raw === "number") return raw;
	return /^\d+$/.test(raw.trim()) ? Number(raw) : Number.NaN;
}

/** Parses a positive whole quantity such as `3`. */
export function parseQuantity(raw: string | number, onError: ErrorSink): number | undefined {
	const n = unitsOf(raw);
	if (!Number.isInteger(n) || n <= 0)
		return fail(onError, "BAD_QUANTITY", `quantity must be a positive whole number: ${raw}`);
	return n;
}

/** Parses a stock count: a whole number of units, where an empty shelf (`0`) is a valid count. */
export function parseCount(raw: string | number, onError: ErrorSink): number | undefined {
	const n = unitsOf(raw);
	if (!Number.isInteger(n) || n < 0)
		return fail(onError, "BAD_QUANTITY", `count must be a whole number, zero or more: ${raw}`);
	return n;
}
