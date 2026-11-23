import { shippingCost } from "./shipping.js";

export function total(order) {
	return order.subtotal + shippingCost(order);
}
