import { applyCoupon } from "./discount.js";
import { addTax } from "./tax.js";

export function checkout(items, coupon) {
	const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
	const discounted = applyCoupon(subtotal, coupon);
	return addTax(discounted);
}
