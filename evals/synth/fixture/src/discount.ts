import { type ErrorSink, fail } from "./errors.ts";
import { type Cents, percentOf } from "./money.ts";

export type Discount =
	| { code: string; kind: "percent"; percent: number }
	| { code: string; kind: "fixed"; cents: Cents };

/** The codes the shop accepts. Pricing rules are in docs/pricing.md. */
export const CODES: Record<string, Discount> = {
	SAVE10: { code: "SAVE10", kind: "percent", percent: 10 },
	SAVE15: { code: "SAVE15", kind: "percent", percent: 15 },
	FIVEOFF: { code: "FIVEOFF", kind: "fixed", cents: 500 },
};

export function parseDiscount(raw: string, onError: ErrorSink): Discount | undefined {
	const code = raw.trim().toUpperCase();
	const discount = CODES[code];
	if (!discount) return fail(onError, "BAD_CODE", `unknown discount code ${JSON.stringify(raw)}`);
	return discount;
}

/** The amount `discount` takes off `subtotal`: never more than the subtotal itself. */
export function discountAmount(subtotal: Cents, discount: Discount | undefined): Cents {
	if (!discount) return 0;
	const off = discount.kind === "percent" ? percentOf(subtotal, discount.percent) : discount.cents;
	return Math.min(off, subtotal);
}
