import { total } from "./cart.js";
import { formatPrice } from "./format.js";

export function invoiceLine(name, prices) {
	return `${name}: ${formatPrice(total(prices))}`;
}
