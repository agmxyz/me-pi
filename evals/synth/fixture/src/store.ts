import { readFileSync, writeFileSync } from "node:fs";
import { type ErrorSink, fail } from "./errors.ts";
import { emptyInventory, type Inventory } from "./inventory.ts";
import { emptyBook, type OrderBook } from "./orders.ts";

/** Everything the CLI keeps between runs, saved as one JSON file. */
export interface State {
	version: 1;
	inventory: Inventory;
	book: OrderBook;
}

export const emptyState = (): State => ({ version: 1, inventory: emptyInventory(), book: emptyBook() });

/** Reads a state file; a missing file is an empty state. */
export function loadState(path: string, onError: ErrorSink): State | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
		throw err;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return fail(onError, "BAD_FILE", `${path} is not JSON`);
	}
	const state = raw as State;
	if (state?.version !== 1 || typeof state.inventory !== "object" || typeof state.book !== "object")
		return fail(onError, "BAD_FILE", `${path} is not an inventory file (version 1)`);
	return state;
}

export function saveState(path: string, state: State): void {
	writeFileSync(path, `${JSON.stringify(state, null, "\t")}\n`);
}
