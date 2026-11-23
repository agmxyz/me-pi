export function formatPrice(amount) {
	const [whole, cents] = amount.toFixed(2).split(".");
	return `${whole.replace(/\B(?=(\d{3})+$)/g, ",")}.${cents}`;
}

export function parsePrice(text) {
	const value = Number(text.replaceAll(",", ""));
	if (text.trim() === "" || !Number.isFinite(value)) throw new Error(`bad price: ${text}`);
	return value;
}
