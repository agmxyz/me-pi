import { createServer } from "node:http";
import { handle } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

createServer(handle).listen(port, () => {
	console.log(`shop listening on ${port}`);
});
