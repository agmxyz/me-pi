/**
 * Every report the CLI prints. Each report has a compute function that returns rows and a render function that turns
 * those rows into an aligned text table. Revenue figures count shipped orders only: placed orders are still pending
 * and cancelled ones never earned anything.
 */
import { type ErrorSink, fail } from "./errors.ts";
import { available, isLowStock } from "./inventory.ts";
import { type Cents, formatCents, sum } from "./money.ts";
import { type Order, type OrderStatus, orderTotals } from "./orders.ts";
import type { State } from "./store.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------------------------------------------------

export type Align = "left" | "right";

export interface Column<Row> {
	title: string;
	align: Align;
	cell: (row: Row) => string;
}

const pad = (text: string, width: number, align: Align) =>
	align === "left" ? text.padEnd(width) : text.padStart(width);

/** Renders rows as a table: a header, a rule, then one line per row; `(none)` under the rule when there are no rows. */
export function table<Row>(columns: Column<Row>[], rows: Row[]): string {
	const cells = rows.map((row) => columns.map((c) => c.cell(row)));
	const widths = columns.map((c, i) => Math.max(c.title.length, ...cells.map((r) => r[i].length)));
	const line = (values: string[]) =>
		values
			.map((v, i) => pad(v, widths[i], columns[i].align))
			.join("  ")
			.trimEnd();
	const header = line(columns.map((c) => c.title));
	const rule = widths.map((w) => "-".repeat(w)).join("  ");
	const body = cells.length ? cells.map(line) : ["(none)"];
	return [header, rule, ...body].join("\n");
}

const text = <Row>(title: string, cell: (row: Row) => string): Column<Row> => ({ title, align: "left", cell });
const count = <Row>(title: string, cell: (row: Row) => number): Column<Row> => ({
	title,
	align: "right",
	cell: (row) => String(cell(row)),
});
const money = <Row>(title: string, cell: (row: Row) => Cents): Column<Row> => ({
	title,
	align: "right",
	cell: (row) => formatCents(cell(row)),
});
const percent = <Row>(title: string, cell: (row: Row) => number): Column<Row> => ({
	title,
	align: "right",
	cell: (row) => `${cell(row).toFixed(1)}%`,
});

// ---------------------------------------------------------------------------------------------------------------------
// Shared selections
// ---------------------------------------------------------------------------------------------------------------------

/** One shipped order line, priced as sold. */
export interface SoldLine {
	orderId: string;
	customer: string;
	sku: string;
	qty: number;
	/** What the line earned, in cents. */
	cents: Cents;
}

const ordersOf = (state: State): Order[] => Object.values(state.book.orders).sort((a, b) => a.id.localeCompare(b.id));

const shippedOrders = (state: State): Order[] => ordersOf(state).filter((o) => o.status === "shipped");

/** Every line of every shipped order, in order id then line order. All revenue reports read lines from here. */
export function soldLines(state: State): SoldLine[] {
	return shippedOrders(state).flatMap((order) =>
		order.lines.map((line) => ({
			orderId: order.id,
			customer: order.customer,
			sku: line.sku,
			qty: line.qty,
			cents: line.unitCents * line.qty,
		})),
	);
}

/** A product's category is its SKU's letter prefix: `ABC-1234` is in `ABC`. */
export const categoryOf = (sku: string) => sku.slice(0, 3);

const productName = (state: State, sku: string) => state.inventory.products[sku]?.name ?? "(deleted)";

/** Groups `items` by `key`, keeping first-seen order of the keys. */
function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const k = key(item);
		const group = groups.get(k);
		if (group) group.push(item);
		else groups.set(k, [item]);
	}
	return groups;
}

/** Sorts by `cents` descending, then by `key` ascending, so equal figures list in a stable order. */
function byCentsDesc<T extends { cents: Cents }>(rows: T[], key: (row: T) => string): T[] {
	return rows.sort((a, b) => b.cents - a.cents || key(a).localeCompare(key(b)));
}

// ---------------------------------------------------------------------------------------------------------------------
// Sales by product
// ---------------------------------------------------------------------------------------------------------------------

export interface ProductSalesRow {
	sku: string;
	name: string;
	units: number;
	cents: Cents;
}

export function salesByProduct(state: State): ProductSalesRow[] {
	const rows = [...groupBy(soldLines(state), (l) => l.sku)].map(([sku, lines]) => ({
		sku,
		name: productName(state, sku),
		units: sum(lines.map((l) => l.qty)),
		cents: sum(lines.map((l) => l.cents)),
	}));
	return byCentsDesc(rows, (r) => r.sku);
}

export function renderSalesByProduct(rows: ProductSalesRow[]): string {
	return table<ProductSalesRow>(
		[
			text("SKU", (r) => r.sku),
			text("Product", (r) => r.name),
			count("Units", (r) => r.units),
			money("Revenue", (r) => r.cents),
		],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Buyers by product
// ---------------------------------------------------------------------------------------------------------------------

export interface BuyersRow {
	sku: string;
	name: string;
	/** Distinct customers who bought the product. */
	buyers: number;
	cents: Cents;
}

export function buyersByProduct(state: State): BuyersRow[] {
	const rows = [...groupBy(soldLines(state), (l) => l.sku)].map(([sku, lines]) => ({
		sku,
		name: productName(state, sku),
		buyers: new Set(lines.map((l) => l.customer)).size,
		cents: sum(lines.map((l) => l.cents)),
	}));
	return byCentsDesc(rows, (r) => r.sku);
}

export function renderBuyersByProduct(rows: BuyersRow[]): string {
	return table<BuyersRow>(
		[
			text("SKU", (r) => r.sku),
			text("Product", (r) => r.name),
			count("Buyers", (r) => r.buyers),
			money("Revenue", (r) => r.cents),
		],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Sales by customer
// ---------------------------------------------------------------------------------------------------------------------

export interface CustomerSalesRow {
	customer: string;
	orders: number;
	cents: Cents;
}

export function salesByCustomer(state: State): CustomerSalesRow[] {
	const rows = [...groupBy(soldLines(state), (l) => l.customer)].map(([customer, lines]) => ({
		customer,
		orders: new Set(lines.map((l) => l.orderId)).size,
		cents: sum(lines.map((l) => l.cents)),
	}));
	return byCentsDesc(rows, (r) => r.customer);
}

export function renderSalesByCustomer(rows: CustomerSalesRow[]): string {
	return table<CustomerSalesRow>(
		[text("Customer", (r) => r.customer), count("Orders", (r) => r.orders), money("Revenue", (r) => r.cents)],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Sales by category
// ---------------------------------------------------------------------------------------------------------------------

export interface CategorySalesRow {
	category: string;
	units: number;
	cents: Cents;
	share: number;
}

export function salesByCategory(state: State): CategorySalesRow[] {
	const lines = soldLines(state);
	const total = sum(lines.map((l) => l.cents));
	const rows = [...groupBy(lines, (l) => categoryOf(l.sku))].map(([category, group]) => {
		const cents = sum(group.map((l) => l.cents));
		return {
			category,
			units: sum(group.map((l) => l.qty)),
			cents,
			share: total ? (cents * 100) / total : 0,
		};
	});
	return byCentsDesc(rows, (r) => r.category);
}

export function renderSalesByCategory(rows: CategorySalesRow[]): string {
	return table<CategorySalesRow>(
		[
			text("Category", (r) => r.category),
			count("Units", (r) => r.units),
			money("Revenue", (r) => r.cents),
			percent("Share", (r) => r.share),
		],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Top products and customers
// ---------------------------------------------------------------------------------------------------------------------

/** How many rows the top-N reports keep. */
export const TOP_N = 3;

export interface RankedRow {
	rank: number;
	label: string;
	cents: Cents;
}

const ranked = (rows: { label: string; cents: Cents }[]): RankedRow[] =>
	rows.slice(0, TOP_N).map((r, i) => ({ rank: i + 1, label: r.label, cents: r.cents }));

export function topProducts(state: State): RankedRow[] {
	return ranked(salesByProduct(state).map((r) => ({ label: `${r.sku} ${r.name}`, cents: r.cents })));
}

export function topCustomers(state: State): RankedRow[] {
	return ranked(salesByCustomer(state).map((r) => ({ label: r.customer, cents: r.cents })));
}

export function renderRanked(rows: RankedRow[]): string {
	return table<RankedRow>(
		[count("#", (r) => r.rank), text("Name", (r) => r.label), money("Revenue", (r) => r.cents)],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Average order value
// ---------------------------------------------------------------------------------------------------------------------

export interface AverageRow {
	orders: number;
	cents: Cents;
	average: Cents;
}

/** Revenue per shipped order, before tax, rounded to the cent. */
export function averageOrderValue(state: State): AverageRow[] {
	const lines = soldLines(state);
	const orders = new Set(lines.map((l) => l.orderId)).size;
	const cents = sum(lines.map((l) => l.cents));
	return [{ orders, cents, average: orders ? Math.round(cents / orders) : 0 }];
}

export function renderAverageOrderValue(rows: AverageRow[]): string {
	return table<AverageRow>(
		[count("Orders", (r) => r.orders), money("Revenue", (r) => r.cents), money("Average", (r) => r.average)],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Units sold
// ---------------------------------------------------------------------------------------------------------------------

export interface UnitsRow {
	sku: string;
	name: string;
	units: number;
	orders: number;
}

export function unitsByProduct(state: State): UnitsRow[] {
	return [...groupBy(soldLines(state), (l) => l.sku)]
		.map(([sku, lines]) => ({
			sku,
			name: productName(state, sku),
			units: sum(lines.map((l) => l.qty)),
			orders: new Set(lines.map((l) => l.orderId)).size,
		}))
		.sort((a, b) => b.units - a.units || a.sku.localeCompare(b.sku));
}

export function renderUnitsByProduct(rows: UnitsRow[]): string {
	return table<UnitsRow>(
		[
			text("SKU", (r) => r.sku),
			text("Product", (r) => r.name),
			count("Units", (r) => r.units),
			count("Orders", (r) => r.orders),
		],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------------------------------------------------

export interface StockRow {
	sku: string;
	name: string;
	onHand: number;
	reserved: number;
	available: number;
	cents: Cents;
}

export function stockReport(state: State): StockRow[] {
	const { inventory } = state;
	return Object.values(inventory.products)
		.map((p) => {
			const level = inventory.stock[p.sku];
			return {
				sku: p.sku,
				name: p.name,
				onHand: level.onHand,
				reserved: level.reserved,
				available: available(inventory, p.sku),
				cents: p.priceCents * level.onHand,
			};
		})
		.sort((a, b) => a.sku.localeCompare(b.sku));
}

export function renderStock(rows: StockRow[]): string {
	return table<StockRow>(
		[
			text("SKU", (r) => r.sku),
			text("Product", (r) => r.name),
			count("On hand", (r) => r.onHand),
			count("Reserved", (r) => r.reserved),
			count("Available", (r) => r.available),
			money("Value", (r) => r.cents),
		],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Low stock
// ---------------------------------------------------------------------------------------------------------------------

export interface LowStockRow {
	sku: string;
	name: string;
	available: number;
	reorderAt: number;
	shortfall: number;
}

export function lowStockReport(state: State): LowStockRow[] {
	const { inventory } = state;
	return Object.values(inventory.products)
		.filter((p) => isLowStock(inventory, p.sku))
		.map((p) => ({
			sku: p.sku,
			name: p.name,
			available: available(inventory, p.sku),
			reorderAt: p.reorderAt,
			shortfall: p.reorderAt - available(inventory, p.sku),
		}))
		.sort((a, b) => b.shortfall - a.shortfall || a.sku.localeCompare(b.sku));
}

export function renderLowStock(rows: LowStockRow[]): string {
	return table<LowStockRow>(
		[
			text("SKU", (r) => r.sku),
			text("Product", (r) => r.name),
			count("Available", (r) => r.available),
			count("Reorder at", (r) => r.reorderAt),
			count("Short", (r) => r.shortfall),
		],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Stock value by category
// ---------------------------------------------------------------------------------------------------------------------

export interface CategoryValueRow {
	category: string;
	products: number;
	units: number;
	cents: Cents;
}

export function stockValueByCategory(state: State): CategoryValueRow[] {
	const rows = [...groupBy(stockReport(state), (r) => categoryOf(r.sku))].map(([category, group]) => ({
		category,
		products: group.length,
		units: sum(group.map((r) => r.onHand)),
		cents: sum(group.map((r) => r.cents)),
	}));
	return byCentsDesc(rows, (r) => r.category);
}

export function renderStockValueByCategory(rows: CategoryValueRow[]): string {
	return table<CategoryValueRow>(
		[
			text("Category", (r) => r.category),
			count("Products", (r) => r.products),
			count("Units", (r) => r.units),
			money("Value", (r) => r.cents),
		],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Orders by status
// ---------------------------------------------------------------------------------------------------------------------

export const STATUSES: OrderStatus[] = ["draft", "placed", "shipped", "cancelled"];

export interface StatusRow {
	status: OrderStatus;
	orders: number;
	/** Order totals including tax. */
	cents: Cents;
}

export function orderStatusReport(state: State): StatusRow[] {
	const orders = ordersOf(state);
	return STATUSES.map((status) => {
		const group = orders.filter((o) => o.status === status);
		return { status, orders: group.length, cents: sum(group.map((o) => orderTotals(o).total)) };
	});
}

export function renderOrderStatus(rows: StatusRow[]): string {
	return table<StatusRow>(
		[text("Status", (r) => r.status), count("Orders", (r) => r.orders), money("Total", (r) => r.cents)],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Open orders
// ---------------------------------------------------------------------------------------------------------------------

export interface OpenOrderRow {
	id: string;
	customer: string;
	status: OrderStatus;
	lines: number;
	units: number;
	cents: Cents;
}

/** Drafts and placed orders: everything not yet shipped or cancelled. */
export function openOrdersReport(state: State): OpenOrderRow[] {
	return ordersOf(state)
		.filter((o) => o.status === "draft" || o.status === "placed")
		.map((o) => ({
			id: o.id,
			customer: o.customer,
			status: o.status,
			lines: o.lines.length,
			units: sum(o.lines.map((l) => l.qty)),
			cents: orderTotals(o).total,
		}));
}

export function renderOpenOrders(rows: OpenOrderRow[]): string {
	return table<OpenOrderRow>(
		[
			text("Order", (r) => r.id),
			text("Customer", (r) => r.customer),
			text("Status", (r) => r.status),
			count("Lines", (r) => r.lines),
			count("Units", (r) => r.units),
			money("Total", (r) => r.cents),
		],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------------------------------------------------

export interface ReservationRow {
	sku: string;
	orderId: string;
	customer: string;
	qty: number;
}

/** Every unit reserved by a placed order, by SKU then order. */
export function reservationsReport(state: State): ReservationRow[] {
	return ordersOf(state)
		.filter((o) => o.status === "placed")
		.flatMap((o) => o.lines.map((l) => ({ sku: l.sku, orderId: o.id, customer: o.customer, qty: l.qty })))
		.sort((a, b) => a.sku.localeCompare(b.sku) || a.orderId.localeCompare(b.orderId));
}

export function renderReservations(rows: ReservationRow[]): string {
	return table<ReservationRow>(
		[
			text("SKU", (r) => r.sku),
			text("Order", (r) => r.orderId),
			text("Customer", (r) => r.customer),
			count("Units", (r) => r.qty),
		],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------------------------------

export interface CustomerRow {
	customer: string;
	open: number;
	shipped: number;
	cancelled: number;
	/** Revenue from shipped orders. */
	cents: Cents;
}

export function customerReport(state: State): CustomerRow[] {
	const rows = [...groupBy(ordersOf(state), (o) => o.customer)].map(([customer, orders]) => {
		const shipped = orders.filter((o) => o.status === "shipped");
		return {
			customer,
			open: orders.filter((o) => o.status === "draft" || o.status === "placed").length,
			shipped: shipped.length,
			cancelled: orders.filter((o) => o.status === "cancelled").length,
			cents: sum(shipped.flatMap((o) => o.lines.map((l) => l.unitCents * l.qty))),
		};
	});
	return byCentsDesc(rows, (r) => r.customer);
}

export function renderCustomers(rows: CustomerRow[]): string {
	return table<CustomerRow>(
		[
			text("Customer", (r) => r.customer),
			count("Open", (r) => r.open),
			count("Shipped", (r) => r.shipped),
			count("Cancelled", (r) => r.cancelled),
			money("Revenue", (r) => r.cents),
		],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Discount usage
// ---------------------------------------------------------------------------------------------------------------------

export interface DiscountRow {
	code: string;
	orders: number;
	/** What the code took off shipped orders. */
	cents: Cents;
}

export function discountUsageReport(state: State): DiscountRow[] {
	const withCode = shippedOrders(state).filter((o) => o.discount);
	const rows = [...groupBy(withCode, (o) => o.discount!.code)].map(([code, orders]) => ({
		code,
		orders: orders.length,
		cents: sum(orders.map((o) => orderTotals(o).discount)),
	}));
	return byCentsDesc(rows, (r) => r.code);
}

export function renderDiscountUsage(rows: DiscountRow[]): string {
	return table<DiscountRow>(
		[text("Code", (r) => r.code), count("Orders", (r) => r.orders), money("Discounted", (r) => r.cents)],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Tax
// ---------------------------------------------------------------------------------------------------------------------

export interface TaxRow {
	orderId: string;
	taxable: Cents;
	tax: Cents;
}

/** Tax collected per shipped order: the taxable amount is the subtotal less the discount. */
export function taxReport(state: State): TaxRow[] {
	return shippedOrders(state).map((o) => {
		const t = orderTotals(o);
		return { orderId: o.id, taxable: t.subtotal - t.discount, tax: t.tax };
	});
}

export function renderTax(rows: TaxRow[]): string {
	return table<TaxRow>(
		[text("Order", (r) => r.orderId), money("Taxable", (r) => r.taxable), money("Tax", (r) => r.tax)],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Shipped lines
// ---------------------------------------------------------------------------------------------------------------------

/** Every shipped line as sold, for auditing the revenue reports against their source. */
export function shippedLinesReport(state: State): SoldLine[] {
	return soldLines(state);
}

export function renderShippedLines(rows: SoldLine[]): string {
	return table<SoldLine>(
		[
			text("Order", (r) => r.orderId),
			text("Customer", (r) => r.customer),
			text("SKU", (r) => r.sku),
			count("Units", (r) => r.qty),
			money("Revenue", (r) => r.cents),
		],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Price list
// ---------------------------------------------------------------------------------------------------------------------

export interface PriceRow {
	sku: string;
	name: string;
	priceCents: Cents;
	reorderAt: number;
}

export function priceListReport(state: State): PriceRow[] {
	return Object.values(state.inventory.products)
		.map((p) => ({ sku: p.sku, name: p.name, priceCents: p.priceCents, reorderAt: p.reorderAt }))
		.sort((a, b) => a.sku.localeCompare(b.sku));
}

export function renderPriceList(rows: PriceRow[]): string {
	return table<PriceRow>(
		[
			text("SKU", (r) => r.sku),
			text("Product", (r) => r.name),
			money("Price", (r) => r.priceCents),
			count("Reorder at", (r) => r.reorderAt),
		],
		rows,
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------------------------------

interface ReportDef<Row> {
	title: string;
	compute: (state: State) => Row[];
	render: (rows: Row[]) => string;
}

const def = <Row>(title: string, compute: (s: State) => Row[], render: (rows: Row[]) => string) =>
	({ title, compute, render }) as ReportDef<unknown>;

/** Every report by its CLI name, in the order `inv report` lists them. */
export const REPORTS: Record<string, ReportDef<unknown>> = {
	sales: def("Sales by product", salesByProduct, renderSalesByProduct),
	buyers: def("Buyers by product", buyersByProduct, renderBuyersByProduct),
	customers: def("Sales by customer", salesByCustomer, renderSalesByCustomer),
	categories: def("Sales by category", salesByCategory, renderSalesByCategory),
	"top-products": def("Top products", topProducts, renderRanked),
	"top-customers": def("Top customers", topCustomers, renderRanked),
	average: def("Average order value", averageOrderValue, renderAverageOrderValue),
	units: def("Units sold", unitsByProduct, renderUnitsByProduct),
	stock: def("Stock", stockReport, renderStock),
	low: def("Low stock", lowStockReport, renderLowStock),
	"stock-value": def("Stock value by category", stockValueByCategory, renderStockValueByCategory),
	status: def("Orders by status", orderStatusReport, renderOrderStatus),
	open: def("Open orders", openOrdersReport, renderOpenOrders),
	reservations: def("Reservations", reservationsReport, renderReservations),
	accounts: def("Customers", customerReport, renderCustomers),
	discounts: def("Discount usage", discountUsageReport, renderDiscountUsage),
	tax: def("Tax collected", taxReport, renderTax),
	lines: def("Shipped lines", shippedLinesReport, renderShippedLines),
	prices: def("Price list", priceListReport, renderPriceList),
};

/** Renders the named report with its title, or reports `BAD_ARGS` listing the names. */
export function runReport(name: string, state: State, onError: ErrorSink): string | undefined {
	const report = REPORTS[name];
	if (!report) return fail(onError, "BAD_ARGS", `unknown report ${name}; one of: ${Object.keys(REPORTS).join(", ")}`);
	return `${report.title}\n\n${report.render(report.compute(state))}`;
}
