import { readJson } from "./config.js";
import { shippingCost } from "./shipping.js";

const FLAGS = new URL("../config/flags.json", import.meta.url);

function freeShippingEnabled() {
	try {
		return readJson(FLAGS).freeShipping === true;
	} catch {
		// A bad edit to the flags file should never break checkout.
		return false;
	}
}

export function total(order) {
	return order.subtotal + (freeShippingEnabled() ? 0 : shippingCost(order));
}
