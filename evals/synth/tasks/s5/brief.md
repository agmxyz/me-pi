# Volume discount for bulk orders

## Problem
Wholesale accounts buy by the case. Sales has promised them bulk pricing, in these words: "5% off any item you buy 10 or more of." Finance signed off on that wording, so `docs/pricing.md` must give customers exactly what they were promised. Today `inv` only knows the three discount codes, so these customers pay list price and sales issues credits by hand.

Add the volume discount so `orderTotals` and `inv order show` price bulk orders without manual credits.

## Where
- `src/orders.ts`: `orderTotals` (the discount, tax, and total of an order)
- `src/discount.ts`: discount rules
- `src/cli.ts`: `showOrder` (what `inv order show` prints)
- `docs/pricing.md`: the pricing rules the code must follow
- `test/orders.test.ts`, `test/discount.test.ts`, `test/cli.test.ts`

## Acceptance criteria
1. An order with 10 or more units gets a 5% volume discount on its subtotal, rounded half up to the cent.
2. The volume discount adds to the amount of any discount code on the order; the combined discount never exceeds the subtotal.
3. Tax and total follow `docs/pricing.md`, using the combined discount.
4. `inv order show` prints the volume discount on its own line, `  volume -$X.XX`, only when there is one; the code line stays as it is.
5. `docs/pricing.md` states the volume discount rule.
6. `npm run check` passes, with tests for the new rule.

## Out of scope
- New discount codes or changes to the existing ones.
- Reports.
- Per-customer pricing.
