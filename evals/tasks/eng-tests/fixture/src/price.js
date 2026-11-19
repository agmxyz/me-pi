export function formatPrice(amount) {
	return amount.toFixed(2);
}

export function parsePrice(text) {
	const value = Number(text);
	if (text.trim() === "" || !Number.isFinite(value)) throw new Error(`bad price: ${text}`);
	return value;
}
