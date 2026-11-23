import type { Discount } from "./discount.ts";
import { type ErrorSink, fail } from "./errors.ts";
import { findProduct, type Inventory, release, reserve, ship } from "./inventory.ts";
import { type Cents, percentOf, sum } from "./money.ts";
import { parseQuantity } from "./sku.ts";

export type OrderStatus = "draft" | "placed" | "shipped" | "cancelled";

export interface OrderLine {
	sku: string;
	qty: number;
	/** The product's price when the line was added. */
	unitCents: Cents;
}

export interface Order {
	id: string;
	customer: string;
	status: OrderStatus;
	lines: OrderLine[];
	discount?: Discount;
}

export interface Totals {
	subtotal: Cents;
	discount: Cents;
	tax: Cents;
	total: Cents;
}

/** Sales tax rate. */
export const TAX_PERCENT = 8;

export interface OrderBook {
	orders: Record<string, Order>;
	nextId: number;
}

export const emptyBook = (): OrderBook => ({ orders: {}, nextId: 1 });

export function createOrder(book: OrderBook, customer: string, onError: ErrorSink): Order | undefined {
	const name = customer.trim();
	if (!name) return fail(onError, "BAD_NAME", "an order needs a customer");
	const id = `O-${String(book.nextId++).padStart(4, "0")}`;
	const order: Order = { id, customer: name, status: "draft", lines: [] };
	book.orders[id] = order;
	return order;
}

export function findOrder(book: OrderBook, id: string, onError: ErrorSink): Order | undefined {
	const order = book.orders[id.trim().toUpperCase()];
	if (!order) return fail(onError, "UNKNOWN_ORDER", `no order ${id}`);
	return order;
}

/** Adds `qty` of `sku` to a draft order; a SKU already on the order gets its quantity raised. */
export function addLine(inv: Inventory, order: Order, sku: string, qty: number, onError: ErrorSink): boolean {
	if (order.status !== "draft") {
		fail(onError, "BAD_TRANSITION", `${order.id} is ${order.status}; only a draft can change`);
		return false;
	}
	const product = findProduct(inv, sku, onError);
	if (!product) return false;
	const n = parseQuantity(qty, onError);
	if (n === undefined) return false;
	const line = order.lines.find((l) => l.sku === product.sku);
	if (line) line.qty += n;
	else order.lines.push({ sku: product.sku, qty: n, unitCents: product.priceCents });
	return true;
}

export function applyDiscount(order: Order, discount: Discount, onError: ErrorSink): boolean {
	if (order.status !== "draft") {
		fail(onError, "BAD_TRANSITION", `${order.id} is ${order.status}; only a draft can change`);
		return false;
	}
	order.discount = discount;
	return true;
}

/** What the order's code takes off `subtotal`, never more than the subtotal. Terms per docs/pricing.md. */
function codeDiscount(subtotal: Cents, code: string | undefined): Cents {
	switch (code) {
		case "SAVE10":
			return Math.min(percentOf(subtotal, 10), subtotal);
		case "SAVE15":
			return Math.min(percentOf(subtotal, 15), subtotal);
		case "FIVEOFF":
			return Math.min(500, subtotal);
		default:
			return 0;
	}
}

export function orderTotals(order: Order): Totals {
	const subtotal = sum(order.lines.map((l) => l.unitCents * l.qty));
	const discount = codeDiscount(subtotal, order.discount?.code);
	const tax = percentOf(subtotal, TAX_PERCENT);
	return { subtotal, discount, tax, total: subtotal - discount + tax };
}

/** Places a draft: every line's units are reserved, or none are. */
export function placeOrder(inv: Inventory, order: Order, onError: ErrorSink): boolean {
	if (order.status !== "draft") {
		fail(onError, "BAD_TRANSITION", `${order.id} is ${order.status}; only a draft can be placed`);
		return false;
	}
	if (!order.lines.length) {
		fail(onError, "EMPTY_ORDER", `${order.id} has no lines`);
		return false;
	}
	const done: OrderLine[] = [];
	for (const line of order.lines) {
		if (!reserve(inv, line.sku, line.qty, onError)) {
			for (const d of done) release(inv, d.sku, d.qty, () => {});
			return false;
		}
		done.push(line);
	}
	order.status = "placed";
	return true;
}

export function shipOrder(inv: Inventory, order: Order, onError: ErrorSink): boolean {
	if (order.status !== "placed") {
		fail(onError, "BAD_TRANSITION", `${order.id} is ${order.status}; only a placed order can ship`);
		return false;
	}
	for (const line of order.lines) ship(inv, line.sku, line.qty, onError);
	order.status = "shipped";
	return true;
}

/** Cancels a draft or placed order; a placed order's reservations are released. */
export function cancelOrder(inv: Inventory, order: Order, onError: ErrorSink): boolean {
	if (order.status === "shipped" || order.status === "cancelled") {
		fail(onError, "BAD_TRANSITION", `${order.id} is ${order.status}; it cannot be cancelled`);
		return false;
	}
	if (order.status === "placed") for (const line of order.lines) release(inv, line.sku, line.qty, onError);
	order.status = "cancelled";
	return true;
}
