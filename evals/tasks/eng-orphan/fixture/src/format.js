// Formats a dollar amount for display, e.g. 1250 -> "$1,250.00".
export function formatMoney(amount) {
	return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
