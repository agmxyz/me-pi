import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_SKUS, suggestSku } from "./sku.js";

const INBOX = "data/inbox";

export function parseOrders(file, text) {
	const lines = text.trim().split("\n");
	return lines.slice(1).map((line, i) => {
		const [sku, qty] = line.split(",");
		if (!KNOWN_SKUS.includes(sku)) {
			const guess = suggestSku(sku) ?? "?";
			throw new Error(`line ${i + 2} of ${file}: unknown SKU "${sku}" (did you mean "${guess}"?)`);
		}
		return { sku, qty: Number(qty) };
	});
}

const orders = [];
for (const name of readdirSync(INBOX).filter((n) => n.endsWith(".csv")).sort()) {
	const file = join(INBOX, name);
	orders.push(...parseOrders(file, readFileSync(file, "utf8")));
}
console.log(`imported ${orders.length} order lines`);
