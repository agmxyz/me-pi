# Bug: `inv low` misses products sitting exactly at their reorder level

## Problem

User report (warehouse lead, verbatim):

> I set ABC-0001 to reorder at 3 (`inv add ABC-0001 Widget 2.50 --reorder 3`) and
> received 3 units. `inv low` says "nothing to restock", and `inv report low` shows
> `(none)`. `inv help` / docs/cli.md say `low` lists products whose available units
> are "at or below" their reorder level, so 3 on hand with a level of 3 should be
> listed. It only shows up once I'm down to 2, which is one unit too late.

Reproduce:

```
inv add ABC-0001 Widget 2.50 --reorder 3
inv receive ABC-0001 3
inv low            # prints "nothing to restock"; expected "ABC-0001"
```

The same thing happens when reservations bring available units down to the reorder
level: 8 on hand, 5 reserved by a placed order, reorder at 3 → 3 available, not listed.

## Where

- `src/inventory.ts` (the low-stock rule; `inventory.ts` owns stock arithmetic)
- `test/inventory.test.ts` (regression test)
- For reference only: `docs/cli.md` (the documented rule), `src/report.ts` (`low` report reuses the rule)

## Acceptance criteria

1. A product whose available units (on hand less reserved) equal its reorder level
   counts as low stock: `isLowStock` returns `true`, and it appears in `lowStock(...)`,
   in `inv low`, and in `inv report low`.
2. A product with available units one or more above its reorder level is not low.
3. Products below their reorder level stay low (current behaviour kept).
4. Reserved units count against the level exactly as they do today (available = on hand − reserved).
5. A regression test in `test/` fails without the fix and passes with it.
6. `npm run check` passes; no existing test is deleted or weakened.

## Out of scope

- Changing how the `low` report computes its `Short` column.
- Changing the reorder-level default or validation in `product.ts`.
- Any other report, pricing, or CLI change.
