import { type ErrorSink, fail } from "./errors.ts";
import { createProduct, type Product, type ProductInput } from "./product.ts";
import { normalizeSku, parseCount, parseQuantity } from "./sku.ts";

export interface StockLevel {
	/** Units physically in the warehouse. */
	onHand: number;
	/** Units promised to placed orders that have not shipped yet. */
	reserved: number;
}

export interface Inventory {
	products: Record<string, Product>;
	stock: Record<string, StockLevel>;
}

/** What a stocktake changed: the product's on-hand units before and after the count. */
export interface CountResult {
	sku: string;
	was: number;
	onHand: number;
}

export const emptyInventory = (): Inventory => ({ products: {}, stock: {} });

export function addProduct(inv: Inventory, input: ProductInput, onError: ErrorSink): Product | undefined {
	const product = createProduct(input, onError);
	if (!product) return undefined;
	if (inv.products[product.sku]) return fail(onError, "DUPLICATE_SKU", `${product.sku} already exists`);
	inv.products[product.sku] = product;
	inv.stock[product.sku] = { onHand: 0, reserved: 0 };
	return product;
}

/** The product for `sku`, reporting `UNKNOWN_SKU` when there is none. */
export function findProduct(inv: Inventory, sku: string, onError: ErrorSink): Product | undefined {
	const product = inv.products[normalizeSku(sku)];
	if (!product) return fail(onError, "UNKNOWN_SKU", `no product ${normalizeSku(sku)}`);
	return product;
}

/** Units that can still be promised: on hand less reserved. */
export function available(inv: Inventory, sku: string): number {
	const level = inv.stock[normalizeSku(sku)];
	return level ? level.onHand - level.reserved : 0;
}

/** Whether `sku` needs restocking: its available units are at or below its reorder level. */
export function isLowStock(inv: Inventory, sku: string): boolean {
	const product = inv.products[normalizeSku(sku)];
	return !!product && available(inv, sku) < product.reorderAt;
}

/** The products that need restocking, by SKU. */
export const lowStock = (inv: Inventory): Product[] =>
	Object.values(inv.products)
		.filter((p) => isLowStock(inv, p.sku))
		.sort((a, b) => a.sku.localeCompare(b.sku));

/** Adds received units to `sku`'s stock; returns the new on-hand count. */
export function receive(inv: Inventory, sku: string, qty: number, onError: ErrorSink): number | undefined {
	const product = findProduct(inv, sku, onError);
	if (!product) return undefined;
	const n = parseQuantity(qty, onError);
	if (n === undefined) return undefined;
	const level = inv.stock[product.sku];
	level.onHand += n;
	return level.onHand;
}

/** Sets `sku`'s on-hand units to a stocktake count; reserved units are promised, so a count below them is refused. */
export function recordCount(
	inv: Inventory,
	sku: string,
	count: string | number,
	onError: ErrorSink,
): CountResult | undefined {
	const product = findProduct(inv, sku, onError);
	if (!product) return undefined;
	const n = parseCount(count, onError);
	if (n === undefined) return undefined;
	const level = inv.stock[product.sku];
	if (n < level.reserved)
		return fail(onError, "INSUFFICIENT_STOCK", `${product.sku}: counted ${n}, but ${level.reserved} are reserved`);
	const was = level.onHand;
	level.onHand = n;
	return { sku: product.sku, was, onHand: n };
}

/** Promises `qty` available units to an order; returns whether it did. */
export function reserve(inv: Inventory, sku: string, qty: number, onError: ErrorSink): boolean {
	const product = findProduct(inv, sku, onError);
	if (!product) return false;
	if (available(inv, product.sku) < qty) {
		fail(onError, "INSUFFICIENT_STOCK", `${product.sku}: ${qty} wanted, ${available(inv, product.sku)} available`);
		return false;
	}
	inv.stock[product.sku].reserved += qty;
	return true;
}

/** Gives back `qty` reserved units, e.g. when an order is cancelled. */
export function release(inv: Inventory, sku: string, qty: number, onError: ErrorSink): boolean {
	const product = findProduct(inv, sku, onError);
	if (!product) return false;
	const level = inv.stock[product.sku];
	if (level.reserved < qty) {
		fail(onError, "BAD_QUANTITY", `${product.sku}: cannot release ${qty}, ${level.reserved} reserved`);
		return false;
	}
	level.reserved -= qty;
	return true;
}

/** Ships `qty` reserved units: they leave both the reservation and the warehouse. */
export function ship(inv: Inventory, sku: string, qty: number, onError: ErrorSink): boolean {
	if (!release(inv, sku, qty, onError)) return false;
	inv.stock[normalizeSku(sku)].onHand -= qty;
	return true;
}

/** Stock value at list price, in cents. */
export const stockValue = (inv: Inventory): number =>
	Object.values(inv.products).reduce((total, p) => total + p.priceCents * inv.stock[p.sku].onHand, 0);
