// Renders a number with exactly two decimals, e.g. 1250 -> "1250.00".
export function twoDecimals(amount) {
	return amount.toFixed(2);
}

// Renders a rate as a percent label, e.g. 0.08 -> "8%".
export function percentLabel(rate) {
	return `${Math.round(rate * 100)}%`;
}
