# Feature: change a product's price, then reprice draft orders (two parts)

## Problem

Prices change (supplier increases, promotions), but `inv` has no way to change a product's
list price after `add`. Sales staff delete and re-add products, which loses their stock.
Separately, an order line keeps the price from when it was added (`orderTotals` and the
reports rely on that), so after a price change, drafts that customers have not confirmed
still quote the old price, and staff need a way to bring a draft up to date.

Do both parts. Part 2 builds on Part 1, and both are required.

## Where

- `src/product.ts`: product rules, including price validation in `createProduct`
- `src/orders.ts`: order lines and the draft-only rule
- `src/cli.ts`: the commands and `USAGE`
- `docs/cli.md`: the command table (keep in sync with `USAGE`; `test/cli.test.ts` checks it)
- `docs/pricing.md`: the pricing rules the code follows
- `test/`: tests for the new library functions and commands

## Part 1: `inv price <sku> <price>`

1. Sets the product's list price. `<price>` uses the same format and validation as the price
   in `inv add`: a dollar amount such as `12`, `12.50`, or `$12.50`, and it must be positive.
2. On success it exits 0 and prints exactly `<SKU> price: <new> (was <old>)`, with the SKU
   normalized and both amounts formatted like the rest of the CLI
   (e.g. `inv price abc-0001 12` after $10.00 prints `ABC-0001 price: $12.00 (was $10.00)`).
   The new price is saved and shows in `report prices`.
3. A bad price (`0`, `-1`, `abc`, `1.234`) fails with `BAD_MONEY`; an unknown SKU with
   `UNKNOWN_SKU`; the wrong number of arguments prints the usage and exits 2.
4. Lines already on any order keep their price. Lines added after the change use the new price.

## Part 2: `inv order reprice <id>`

5. Sets every line of a draft order to its product's current list price, keeping quantities,
   and prints the order exactly as `order show` does (totals, discount, and tax follow).
6. Only a draft can be repriced: a placed, shipped, or cancelled order fails with
   `BAD_TRANSITION`. An unknown order id fails with `UNKNOWN_ORDER`, like other `order` commands.
7. Repricing a draft whose prices have not changed succeeds and changes nothing.

## Both parts

8. Every failure follows the contract in `docs/cli.md`: stderr `error: <CODE>: <message>`,
   exit 1, state file unchanged.
9. `USAGE` and `docs/cli.md` list `price <sku> <price>` and `order reprice <id>` (exactly those
   signatures), in the same order in both; `docs/pricing.md` states when a line's price changes.
10. The library functions report errors through an `ErrorSink` and do not throw; price
    validation has one owner (CODING_STANDARDS.md rule 3). Tests cover both parts.
    `npm run check` passes.

## Out of scope

- Repricing placed orders, or repricing all drafts at once.
- Price history, or changing how discounts and tax are computed.
- Changing `add`, `order add`, or any existing output.
