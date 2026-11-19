// Coupon codes and the fraction they take off the subtotal.
const COUPONS = { SPRING10: 0.1, VIP20: 0.2 };

export function applyCoupon(amount, code) {
	const off = COUPONS[code] ?? 0;
	return amount * (1 - off);
}
