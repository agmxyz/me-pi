import { roundCents } from "./money.js";

// Percent off for each discount code.
export const CODES = { SAVE10: 10, SAVE20: 20, WELCOME5: 5 };

export function applyCodes(subtotal, codes) {
	let percent = 0;
	for (const code of codes) {
		const off = CODES[code];
		if (off === undefined) throw new Error(`unknown discount code: ${code}`);
		percent += off;
	}
	return roundCents(subtotal * (1 - Math.min(percent, 100) / 100));
}
