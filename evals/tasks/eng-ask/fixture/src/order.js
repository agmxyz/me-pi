import { applyCodes } from "./discount.js";
import { roundCents } from "./money.js";

export function orderTotal(order) {
	const subtotal = order.items.reduce((sum, item) => sum + item.price * item.qty, 0);
	return applyCodes(roundCents(subtotal), order.codes ?? []);
}
