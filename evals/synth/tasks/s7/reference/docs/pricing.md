# Pricing

Signed off by finance; code follows this file, not the other way round.

- Prices and totals are whole cents.
- An order line keeps the price its product had when the line was added. A price change reaches a line only when its draft order is repriced (`inv order reprice`); placed, shipped, and cancelled orders are never repriced.
- An order holds at most one discount code. Applying another code replaces it.
- `SAVE10` and `SAVE15` take 10% and 15% off the subtotal, rounded half up to the cent. `FIVEOFF` takes $5.00 off.
- Percentage codes are always computed on the full subtotal, before any fixed-amount code.
- A discount never takes the subtotal below $0.00.
- Sales tax is 8% of the subtotal less the discount, rounded half up to the cent.
- Total = subtotal − discount + tax.
- Revenue in reports is pre-tax and counts shipped orders only.
