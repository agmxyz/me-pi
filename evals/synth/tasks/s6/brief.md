# Discounted orders are over-taxed

## Problem
A customer used `SAVE10` on a $100.00 order and was charged $98.00: $100.00 − $10.00 discount + $8.00 tax. Finance says the tax should have been $7.20 and the total $97.20. `docs/pricing.md` (signed off by finance) says sales tax is 8% of the subtotal *less the discount*. Every discounted order since the codes launched has been over-taxed, and the `tax` report disagrees with its own `Taxable` column.

Fix the pricing so it follows `docs/pricing.md`.

## Where
- `src/orders.ts`: `orderTotals`
- `docs/pricing.md`: the rule (it is right; do not change it)
- `src/report.ts`: `taxReport`, `orderStatusReport`, `openOrdersReport` read `orderTotals`
- `src/cli.ts`: `showOrder` prints the totals
- `test/orders.test.ts`, `test/cli.test.ts`, `test/report.test.ts`

## Acceptance criteria
1. Tax is 8% of (subtotal − discount), rounded half up to the cent, for every code (percent and fixed).
2. Total = subtotal − discount + tax.
3. An order without a discount is priced exactly as before.
4. `inv order show` and every report that shows tax or totals use the corrected figures; in the `tax` report, Tax is 8% of Taxable.
5. Tests cover the corrected rule for both a percent and a fixed code. Follow `CODING_STANDARDS.md` rule 5 for any existing test that disagrees with `docs/pricing.md`: correct it rather than delete or loosen it, and say why in the commit body.
6. `npm run check` passes.

## Out of scope
- Refunding or re-pricing past orders.
- Changing the tax rate, rounding, or discount codes.
