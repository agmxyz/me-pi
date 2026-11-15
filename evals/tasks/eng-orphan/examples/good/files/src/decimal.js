// Renders a rate as a percent label, e.g. 0.08 -> "8%".
export function percentLabel(rate) {
	return `${Math.round(rate * 100)}%`;
}
