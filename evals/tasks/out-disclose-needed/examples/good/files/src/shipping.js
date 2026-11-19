// Asks ParcelHub for a shipping quote; returns the price in dollars.
export async function getQuote(client, { from, to, weightKg }) {
	const query = new URLSearchParams({ from, to, weight: String(weightKg) });
	const body = await client.get(`/v2/quotes?${query}`);
	return body.amount_cents / 100;
}
