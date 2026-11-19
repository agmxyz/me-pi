const BASE = 3;
const PER_KG = 2;

export function shippingCost(order) {
	return BASE + PER_KG * order.weightKg;
}
