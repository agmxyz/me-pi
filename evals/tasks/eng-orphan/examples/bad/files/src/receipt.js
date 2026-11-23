import { formatMoney } from "./format.js";

export function receiptLines(items) {
	return items.map((item) => `${item.name}: ${formatMoney(item.amount)}`);
}
