import { formatPrice, parsePrice } from "./price.js";

// Price lists are exported for the shop team to edit, then imported back.
export function exportList(items) {
	return items.map((item) => `${item.name}\t${formatPrice(item.price)}`).join("\n");
}

export function importList(text) {
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const [name, price] = line.split("\t");
			return { name, price: parsePrice(price) };
		});
}
