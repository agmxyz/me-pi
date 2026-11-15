export const KNOWN_SKUS = ["TEA-01", "MUG-02", "POT-03"];

// Returns the known SKU a mistyped one most likely meant, or undefined.
export function suggestSku(sku) {
	const normal = sku.trim().toUpperCase().replace(/_/g, "-");
	return KNOWN_SKUS.find((known) => known === normal);
}
