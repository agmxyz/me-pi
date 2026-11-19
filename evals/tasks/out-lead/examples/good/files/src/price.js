// Parses a price string such as "12.50" into a number of dollars.
export function parsePrice(text) {
	return Number.parseFloat(text.trim());
}
