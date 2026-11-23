export const routes = {
	"/health": () => ({ ok: true }),
	"/products": () => [{ id: 1, name: "mug", price: "12.50" }],
};
