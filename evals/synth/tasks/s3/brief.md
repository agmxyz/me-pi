# Discount codes have three owners; make `discount.ts` the only one

## Problem
The discount code rules are written out in three places:

- `src/discount.ts` holds the code table (`CODES`), parses a code (`parseDiscount`), and computes what a code takes off a subtotal (`discountAmount`).
- `src/orders.ts` ignores both and re-implements each code's terms in its own `switch` when it computes order totals.
- `src/cli.ts` keeps its own list of the codes `order discount` accepts and builds its own `BAD_CODE` error.

Rule 3 of `CODING_STANDARDS.md` says each rule has one owner, and pricing lives in `discount.ts`/`orders.ts`. Last week finance asked for a new code, and adding it to `CODES` was not enough: orders priced it at $0.00 off and the CLI refused it. Nobody should have to edit three files to add a code.

This is a refactor. What any existing code, order, or command does today must not change.

## Where
- `src/discount.ts`: the owner of the code table, code parsing, and the discount amount.
- `src/orders.ts`: `orderTotals` and its private `switch`.
- `src/cli.ts`: the `order discount` command and its private code list.

## Acceptance criteria
1. Adding an entry to `CODES` in `src/discount.ts`, and changing nothing else, makes that code work everywhere: `parseDiscount` accepts it (in any case, with surrounding spaces), `orderTotals` takes the right amount off for it (percent codes rounded half up, fixed codes never more than the subtotal), and `inv order discount <id> <code>` applies it and shows it in the order's `discount` line.
2. `src/orders.ts` computes the discount by asking `src/discount.ts`; it holds no code names or code terms of its own.
3. `src/cli.ts` validates a code by asking `src/discount.ts`; it holds no list of code names of its own.
4. Behaviour of the existing codes is unchanged: `SAVE10`, `SAVE15`, and `FIVEOFF` take exactly what they take today off every subtotal, including when the subtotal is smaller than `FIVEOFF`'s $5.00, and an order with no code has a discount of 0.
5. An unknown code through the CLI still exits 1 with exactly `error: BAD_CODE: unknown discount code "<code as typed>"` and leaves the state file unchanged.
6. Tax, totals, and every other output (`order show`, reports) are unchanged.
7. Any helper the refactor leaves without a caller is deleted. `npm run check` passes, with no existing test deleted or weakened.

## Out of scope
- Any change to the pricing rules or to `docs/pricing.md`, including how tax is computed today. If you think a rule is wrong, say so in your report; do not fix it here.
- New discount codes (the table keeps its three codes).
- The state file format.
