// Sales tax applied at checkout.
export const TAX_RATE = 0.0825;

export function addTax(amount) {
	return Math.round(amount * (1 + TAX_RATE) * 100) / 100;
}
