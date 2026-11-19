import { roundCents } from "./money.js";

// Percent off for each discount code.
export const CODES = { SAVE10: 10, SAVE20: 20, WELCOME5: 5 };

export function applyCodes(subtotal, codes) {
	if (codes.length === 0) return subtotal;
	if (codes.length > 1) throw new Error("only one discount code per order");
	const percent = CODES[codes[0]];
	if (percent === undefined) throw new Error(`unknown discount code: ${codes[0]}`);
	return roundCents(subtotal * (1 - percent / 100));
}
