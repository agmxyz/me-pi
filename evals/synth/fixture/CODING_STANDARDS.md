# Coding standards

1. Money is integer cents (`Cents`) everywhere; format it only at the edge, with `formatCents`.
2. A fallible library function reports its failure with an `ErrorCode`; it does not throw for bad input. Only unexpected I/O errors may throw.
3. Each rule has one owner: SKU parsing in `sku.ts`, pricing in `discount.ts`/`orders.ts`, stock arithmetic in `inventory.ts`. Callers ask the owner instead of re-implementing the rule.
4. No runtime dependencies; only `node:` built-ins.
5. Every behaviour change comes with a test in `test/` that fails without it. Never delete or weaken a test to make the check pass; if a test is wrong, fix it and say why in the commit body.
6. Tests drive the public functions or `run()` from `src/cli.ts`; they never reach into module internals.
7. Keep functions small and named for what they return; a comment says why, not what.
