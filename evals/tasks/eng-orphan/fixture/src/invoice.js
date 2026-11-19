import { percentLabel } from "./decimal.js";
import { formatMoney } from "./format.js";

export function invoiceSummary(invoice) {
	const due = invoice.items.reduce((sum, item) => sum + item.amount, 0);
	return `Invoice ${invoice.id}: ${formatMoney(due)} due (tax ${percentLabel(invoice.taxRate)} included)`;
}
