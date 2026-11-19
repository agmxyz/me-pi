import { readJson } from "./config.js";
import { shippingCost } from "./shipping.js";

const FLAGS = new URL("../config/flags.json", import.meta.url);

export function total(order) {
	const { freeShipping } = readJson(FLAGS);
	return order.subtotal + (freeShipping ? 0 : shippingCost(order));
}
