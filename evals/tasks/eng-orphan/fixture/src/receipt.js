import { twoDecimals } from "./decimal.js";

export function receiptLines(items) {
	return items.map((item) => `${item.name}: ${twoDecimals(item.amount)}`);
}
