# Repo rules

This is `inv`, a small inventory and orders library with a CLI (`src/cli.ts`), on Node 24 with no runtime dependencies. A change is done when `npm run check` passes (typecheck, Biome, and every test). When you change a command, keep `USAGE` in `src/cli.ts` and `docs/cli.md` in sync; pricing rules live in `docs/pricing.md` and the code must follow it. Follow `CODING_STANDARDS.md`. Commit with Conventional Commits (`fix: …`, `feat: …`, `refactor: …`, `test: …`), one logical change per commit, with a body that says why.
