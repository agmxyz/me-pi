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
	const priceCents = typeof input.price === "number" ? input.price : parseMoney(input.price, onError);
	if (priceCents === undefined) return undefined;
	if (!Number.isInteger(priceCents) || priceCents <= 0)
		return fail(onError, "BAD_MONEY", `price must be positive: ${input.price}`);
	const reorderAt = input.reorderAt ?? DEFAULT_REORDER_AT;
	if (!Number.isInteger(reorderAt) || reorderAt < 0)
		return fail(onError, "BAD_QUANTITY", `reorder level must be a whole number: ${reorderAt}`);
	return { sku, name, priceCents, reorderAt };
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
