#!/usr/bin/env node
import { parseDiscount } from "./discount.ts";
import { collect, describe } from "./errors.ts";
import { addProduct, findProduct, lowStock, receive } from "./inventory.ts";
import { formatCents } from "./money.ts";
import {
	addLine,
	applyDiscount,
	cancelOrder,
	createOrder,
	findOrder,
	orderTotals,
	placeOrder,
	shipOrder,
} from "./orders.ts";
import { renameProduct } from "./product.ts";
import { REPORTS, runReport } from "./report.ts";
import { loadState, type State, saveState } from "./store.ts";

/** Keep in sync with docs/cli.md. */
export const USAGE = `usage: inv <command> [args]

  add <sku> <name> <price> [--reorder <n>]   add a product
  rename <sku> <name>                        rename a product
  receive <sku> <qty>                        add received units to stock
  low                                        list products that need restocking
  order new <customer>                       start a draft order; prints its id
  order add <id> <sku> <qty>                 add units to a draft order
  order discount <id> <code>                 apply a discount code to a draft order
  order place <id>                           reserve stock and place the order
  order ship <id>                            ship a placed order
  order cancel <id>                          cancel a draft or placed order
  order show <id>                            print an order and its totals
  report <name>                              print a report (${Object.keys(REPORTS).join(", ")})
  help                                       print this help

The state file is ./inventory.json, or $INV_FILE when set.`;

export interface RunResult {
	code: number;
	out: string;
	err: string;
}

/** What `order show` prints. */
export function showOrder(state: State, id: string): string | undefined {
	const order = state.book.orders[id];
	if (!order) return undefined;
	const t = orderTotals(order);
	const lines = order.lines.map((l) => `  ${l.sku}  x${l.qty}  ${formatCents(l.unitCents * l.qty)}`);
	return [
		`${order.id}  ${order.customer}  ${order.status}`,
		...lines,
		`  subtotal ${formatCents(t.subtotal)}`,
		...(t.discount ? [`  discount -${formatCents(t.discount)} (${order.discount!.code})`] : []),
		`  tax ${formatCents(t.tax)}`,
		`  total ${formatCents(t.total)}`,
	].join("\n");
}

/** Runs one command against the state file at `path`; the state is saved only when the command succeeds. */
export function run(argv: string[], path: string): RunResult {
	const { sink, errors } = collect();
	const failed = (): RunResult => ({ code: 1, out: "", err: errors.map(describe).join("\n") });
	const usage = (): RunResult => ({ code: 2, out: "", err: USAGE });
	const state = loadState(path, sink);
	if (!state) return failed();
	const done = (out: string): RunResult => {
		saveState(path, state);
		return { code: 0, out, err: "" };
	};
	const { inventory: inv, book } = state;
	const [command, ...args] = argv;
	switch (command) {
		case "add": {
			const at = args.indexOf("--reorder");
			const reorderAt = at >= 0 ? Number(args.splice(at, 2)[1]) : undefined;
			if (args.length !== 3) return usage();
			const product = addProduct(inv, { sku: args[0], name: args[1], price: args[2], reorderAt }, sink);
			return product ? done(`added ${product.sku}`) : failed();
		}
		case "rename": {
			if (args.length !== 2) return usage();
			const product = findProduct(inv, args[0], sink);
			return product && renameProduct(product, args[1], sink) ? done(`renamed ${product.sku}`) : failed();
		}
		case "receive": {
			if (args.length !== 2) return usage();
			const onHand = receive(inv, args[0], Number(args[1]), sink);
			return onHand === undefined ? failed() : done(`${args[0].toUpperCase()} on hand: ${onHand}`);
		}
		case "low":
			if (args.length) return usage();
			return done(
				lowStock(inv)
					.map((p) => p.sku)
					.join("\n") || "nothing to restock",
			);
		case "report": {
			if (args.length !== 1) return usage();
			const text = runReport(args[0], state, sink);
			return text === undefined ? failed() : done(text);
		}
		case "order":
			return orderCommand(state, args, sink, done, failed, usage);
		case "help":
		case undefined:
			return { code: 0, out: USAGE, err: "" };
		default:
			return usage();
	}

	function orderCommand(
		state: State,
		[sub, id, ...rest]: string[],
		onError: typeof sink,
		ok: (out: string) => RunResult,
		bad: () => RunResult,
		help: () => RunResult,
	): RunResult {
		if (sub === "new") {
			if (!id || rest.length) return help();
			const order = createOrder(book, id, onError);
			return order ? ok(order.id) : bad();
		}
		if (!id) return help();
		const order = findOrder(book, id, onError);
		if (!order) return bad();
		switch (sub) {
			case "add":
				if (rest.length !== 2) return help();
				return addLine(inv, order, rest[0], Number(rest[1]), onError) ? ok(showOrder(state, order.id)!) : bad();
			case "discount": {
				if (rest.length !== 1) return help();
				const discount = parseDiscount(rest[0], onError);
				return discount && applyDiscount(order, discount, onError) ? ok(showOrder(state, order.id)!) : bad();
			}
			case "place":
				return placeOrder(inv, order, onError) ? ok(`${order.id} placed`) : bad();
			case "ship":
				return shipOrder(inv, order, onError) ? ok(`${order.id} shipped`) : bad();
			case "cancel":
				return cancelOrder(inv, order, onError) ? ok(`${order.id} cancelled`) : bad();
			case "show":
				return ok(showOrder(state, order.id)!);
			default:
				return help();
		}
	}
}

if (import.meta.main) {
	const result = run(process.argv.slice(2), process.env.INV_FILE ?? "inventory.json");
	if (result.out) console.log(result.out);
	if (result.err) console.error(result.err);
	process.exitCode = result.code;
}
