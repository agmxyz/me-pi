import { type ErrorSink, fail } from "./errors.ts";
import { type Cents, parseMoney } from "./money.ts";
import { parseSku } from "./sku.ts";

export interface Product {
	sku: string;
	name: string;
	priceCents: Cents;
	/** Restock when available units fall to this level. */
	reorderAt: number;
}

export interface ProductInput {
	sku: string;
	name: string;
	/** Cents as a number, or an amount string such as `"12.50"`. */
	price: string | number;
	reorderAt?: number;
}

export const DEFAULT_REORDER_AT = 5;
const MAX_NAME = 40;

export function createProduct(input: ProductInput, onError: ErrorSink): Product | undefined {
	const sku = parseSku(input.sku, onError);
	if (sku === undefined) return undefined;
	const name = input.name.trim();
	if (!name || name.length > MAX_NAME)
		return fail(onError, "BAD_NAME", `name must be 1-${MAX_NAME} characters: ${JSON.stringify(input.name)}`);
	const priceCents = parsePrice(input.price, onError);
	if (priceCents === undefined) return undefined;
	const reorderAt = input.reorderAt ?? DEFAULT_REORDER_AT;
	if (!Number.isInteger(reorderAt) || reorderAt < 0)
		return fail(onError, "BAD_QUANTITY", `reorder level must be a whole number: ${reorderAt}`);
	return { sku, name, priceCents, reorderAt };
}

/** A positive price in cents, from cents or an amount string such as `"12.50"`. The one owner of price validation. */
export function parsePrice(price: string | number, onError: ErrorSink): Cents | undefined {
	const cents = typeof price === "number" ? price : parseMoney(price, onError);
	if (cents === undefined) return undefined;
	if (!Number.isInteger(cents) || cents <= 0) return fail(onError, "BAD_MONEY", `price must be positive: ${price}`);
	return cents;
}

/** Sets a product's list price; returns the old price, or `undefined` when the new one is invalid. */
export function setPrice(product: Product, price: string | number, onError: ErrorSink): Cents | undefined {
	const cents = parsePrice(price, onError);
	if (cents === undefined) return undefined;
	const old = product.priceCents;
	product.priceCents = cents;
	return old;
}

/** Renames a product in place; returns whether it did. */
export function renameProduct(product: Product, name: string, onError: ErrorSink): boolean {
	const trimmed = name.trim();
	if (!trimmed || trimmed.length > MAX_NAME) {
		fail(onError, "BAD_NAME", `name must be 1-${MAX_NAME} characters: ${JSON.stringify(name)}`);
		return false;
	}
	product.name = trimmed;
	return true;
}
