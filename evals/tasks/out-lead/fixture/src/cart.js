import { parsePrice } from "./price.js";

export function total(prices) {
	let sum = 0;
	for (const price of prices) sum += parsePrice(price);
	return sum;
}
