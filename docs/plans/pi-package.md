# Public Pi package

Base: `94f8b71a4820a35f899ffe2131a85b6eece5bbaf`.

## Goal

Make `me-pi` an explicit Pi package instead of relying on directory discovery. Canonical repository: `https://github.com/0bmario/me-pi`; public package name: `me-pi`; license: MIT (verify existing LICENSE). Do not change visibility, history, delegate runtime behavior, workflow guidance, or unrelated cleanup items. PR #9's guidance fix is separate, not a dependency.

## Design

- Root package.json is not private and declares description, `license: MIT`, repository, `keywords: ["pi-package"]`, and exactly `pi.extensions: ["extensions/delegate.ts", "extensions/guard.ts", "extensions/skill.ts"]`. Preserve appropriate existing peers/dev dependency pins and Node requirement.
- Move development dependencies, lock file, tsconfig and Biome config to root. Keep lint/check behavior unless relocation requires changes; no unrelated rule cleanup. One lock file/config source, root `npm ci` and `npm run check`.
- Preserve required `npm run check --prefix extensions` through a tiny forwarding extensions/package.json. If existing live-directory installation requires explicit pi entrypoints during the transition, retain the existing three-entry manifest there until the root installer is registered; do not rely on auto-discovery or load helpers as extensions. Document this compatibility shim rather than duplicate tooling.
- Move extension tests to `test/`; move `bin/install.test.sh` to `test/install.test.sh`, update imports/paths and scripts. Preserve test strength, fake Pi fixtures and all coverage; fixture extraction and prose-pin cleanup are separate items. Remove directories only if this migration orphans them.
- Installer registers the root package. Handle the prior extensions-directory registration so repeated upgrades do not load duplicate extensions. Preserve unrelated packages/settings and existing no-overwrite/idempotency behavior. Keep README in sync with actual installation/development commands and layout, using HTTPS clone URL. The final 600–800-word rewrite is separate.
- The live checkout is loaded by Pi. Never run ./install.sh from workers, worktrees or clones. Only the main session may run the real live installer after the root pointer is implemented. Test smoke scripts use isolated fixtures/stubs, not a real installer registration from scratch.

## Confirmed test seams

1. `npm ci` at root resolves pinned development dependencies; full checks include Biome, tsc, node tests, isolated install smoke checks and git diff --check. `npm run check --prefix extensions` remains the acceptance command.
2. Existing extension behavior tests and installer smoke checks retain coverage after relocation. Add focused manifest assertions: only the three entrypoints, no test/helper discovery, metadata public-ready and compatibility forwarding works.
3. A real Pi 1.3.0 package install into a fresh temporary PI_CODING_AGENT_DIR for a full local-source install. Inspect Pi resource discovery and register a scratch-only probe if needed to confirm delegate, guard and Skill loaded once; helpers/tests must not load as extension entrypoints. No model invocation or auth files needed.
4. A second fresh temporary agent dir with package source filter `{ "source": <local package>, "extensions": ["extensions/guard.ts"] }`; confirm only guard loads. Verify actual extension paths/resources, not just JSON shape. Pi local package install/discovery is real; clearly report GitHub transport untested if not exercised while private, rather than claiming the git URL succeeded.
5. Isolated installer smoke tests check root registration, prior extensions-path upgrade, preserved unrelated settings/packages, idempotency, no accidental real network/install actions. Do not expand to unrelated installer rewrites.
6. Main-session final integration: inspect installer changes/handback, run ./install.sh only here to register root path as required by AGENTS.md, surface errors/fallbacks. This is not a scratch Pi install and must not be run by a worker.

## Tickets

### P1 — Root package, development tooling and test layout

Status: TODO.

Implement root manifest/tooling and test relocation, compatibility check shim, focused package assertions, and corresponding README development/layout updates. Keep the old installed directory's explicit entrypoints usable until P2/main-session installer registration. No real ./install.sh execution. Run acceptance command and close P1 only in a passing commit.

### P2 — Root installer registration and real resource-loading checks

Status: TODO; depends on P1.

Update installer/upgrade path and isolated smoke checks. Add/run real Pi full and guard-only installs in temp agent dirs without auth/model invocation; record exact evidence and limitations. Update README root install/use instructions. Run full acceptance suite in the final job; close P2 only in a passing commit. Report BLOCKED if discovery cannot be verified rather than asserting success. The main session performs the real live installer registration after the handback, then independent goal review.

## Delivery

One packaging PR branched from latest main, draft after first passing job. Full goal standards/spec review after final check, at most one high/medium fix job. No merge or remote visibility changes. If WIP commits occur, preserve them and disclose squash-merge requirement in the PR. Known stale branches and unrelated history/licensing audit remain separate approval decisions.
