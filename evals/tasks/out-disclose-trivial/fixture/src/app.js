import { routes } from "./routes.js";

export function handle(req, res) {
	const route = routes[req.url];
	if (!route) {
		res.writeHead(404).end("not found");
		return;
	}
	res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(route()));
}
