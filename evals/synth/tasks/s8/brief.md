# Report: buyers by product

## Problem
Merchandising wants to tell products that sell to many customers from products that one big account keeps buying. The `sales` report shows units and revenue per product but not how many different customers bought it.

Add an `inv report buyers` report that shows, for each product, how many distinct customers bought it and the revenue it earned.

## Where
- `src/report.ts`: every report lives here (compute + render functions and the `REPORTS` registry). Read it before you start: the new report must follow the conventions the existing revenue reports already follow there.
- `test/report.test.ts`

## Acceptance criteria
1. `inv report buyers` (and `runReport("buyers", …)`) prints the title `Buyers by product`, a blank line, then a table with the columns `SKU`, `Product`, `Buyers`, `Revenue`, in that order.
2. One row per product that has sold. `Buyers` is the number of distinct customers who bought it; a customer who bought it in several orders counts once.
3. Which orders count, how revenue is measured, and how products no longer in the catalogue are named are exactly as in the other sales reports in `src/report.ts`; the `Revenue` figure for a product equals what `inv report sales` shows for it.
4. Rows are ordered and columns are formatted and aligned the way the other revenue reports order and format theirs.
5. With no sales the report shows the usual empty table.
6. `inv help` lists `buyers` among the report names.
7. A test in `test/report.test.ts` covers the new report; `npm run check` passes.

## Out of scope
- Changing any existing report.
- New CLI commands or flags.
