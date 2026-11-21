# Feature: `inv count <sku> <qty>` to record a stock count

## Problem

After a physical stocktake the warehouse knows the true number of units on the shelf,
but `inv` can only add units (`receive`). Staff work around it by hand-editing
`inventory.json`, which has already corrupted reservations twice. We need a command that
sets a product's on-hand units to the counted number, through the library, with the same
error handling as every other command.

## Where

- `src/inventory.ts`: the stock rule (it owns stock arithmetic; CODING_STANDARDS.md rule 3)
- `src/sku.ts`: quantity parsing lives here; a count may be zero, which `parseQuantity` refuses
- `src/cli.ts`: the new command and its `USAGE` line
- `docs/cli.md`: the command table (must stay in sync with `USAGE`; `test/cli.test.ts` checks this)
- `test/`: tests for the library function and the command

## Acceptance criteria

1. `inv count <sku> <qty>` sets the product's on-hand units to `<qty>` and leaves its
   reserved units unchanged. The new value is saved to the state file.
2. On success it exits 0 and prints exactly `<SKU> on hand: <new> (was <old>)`, with the SKU
   normalized (e.g. `inv count abc-0001 7` after 10 on hand prints `ABC-0001 on hand: 7 (was 10)`).
3. `<qty>` is a whole number of units, zero or more. `0` is valid. Anything else
   (`-1`, `1.5`, `x`) fails with `BAD_QUANTITY`.
4. An unknown SKU fails with `UNKNOWN_SKU`.
5. A count below the units currently reserved by placed orders fails with
   `INSUFFICIENT_STOCK` (those units are promised; the order must be cancelled first).
   A count equal to the reserved units is allowed.
6. Every failure follows the CLI contract in `docs/cli.md`: stderr `error: <CODE>: <message>`,
   exit 1, state file unchanged. A wrong number of arguments prints the usage and exits 2.
7. `USAGE` in `src/cli.ts` and the table in `docs/cli.md` both list `count <sku> <qty>`,
   placed right after `receive`, and the existing sync test still passes.
8. Other commands and reports see the new count (e.g. `report stock`, `low`).
9. The library function reports errors through an `ErrorSink` and does not throw
   (CODING_STANDARDS.md rule 2); tests cover it and the command. `npm run check` passes.

## Out of scope

- An audit log or history of counts.
- Changing `receive`, `parseQuantity`, or any existing command's behaviour or output.
- Counting several SKUs in one command.
