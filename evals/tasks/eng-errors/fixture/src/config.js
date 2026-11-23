import { readFileSync } from "node:fs";

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}
