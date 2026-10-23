# Public Pi package

Base: `94f8b71a4820a35f899ffe2131a85b6eece5bbaf`.

## Goal

Make `me-pi` an explicit Pi package instead of relying on directory discovery. Canonical repository: `https://github.com/0bmario/me-pi`; public package name: `me-pi`; license: MIT (verify existing LICENSE). Do not change visibility, history, delegate runtime behavior, workflow guidance, or unrelated cleanup items. PR #9's guidance fix is separate, not a dependency.

## Design

- Root package.json is not private and declares description, `license: MIT`, repository, `keywords: ["pi-package"]`, and exactly `pi.extensions: ["extensions/delegate.ts", "extensions/guard.ts", "extensions/skill.ts"]`. Preserve appropriate existing peers/dev dependency pins and Node requirement.
- Move development dependencies, lock file, tsconfig and Biome config to root. Keep lint/check behavior unless relocation requires changes; no unrelated rule cleanup. One lock file/config source, root `npm ci` and `npm run check`.
- Preserve required `npm run check --prefix extensions` through a tiny forwarding extensions/package.json. If existing live-directory installation requires explicit pi entrypoints during the transition, retain the existing three-entry manifest there until the root installer is registered; do not rely on auto-discovery or load helpers as extensions. Document this compatibility shim rather than duplicate tooling.
- Move extension tests to `test/`; move `bin/install.test.sh` to `test/install.test.sh`, update imports/paths and scripts. Preserve test strength, fake Pi fixtures and all coverage; fixture extraction and prose-pin cleanup are separate items. Remove directories only if this migration orphans them.
- Installer registers the root package. Handle the prior extensions-directory registration so repeated upgrades do not load duplicate extensions. Preserve unrelated packages/settings and existing no-overwrite/idempotency behavior. Keep README in sync with actual installation/development commands and layout, using HTTPS clone URL. The user subsequently approved including the short README rewrite and linked operational docs in this packaging PR (P3 below).
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

Status: DONE.

Implement root manifest/tooling and test relocation, compatibility check shim, focused package assertions, and corresponding README development/layout updates. Keep the old installed directory's explicit entrypoints usable until P2/main-session installer registration. No real ./install.sh execution. Run acceptance command and close P1 only in a passing commit.

### P2 — Root installer registration and real resource-loading checks

Status: DONE, including main-session live installer registration.

The installer registers the root package, then removes the old `extensions/` source if `pi list` reports that local path. The isolated smoke test covers fresh install, filtered-old-source upgrade, preservation of unrelated settings/packages, idempotency, no-overwrite behavior, and no network-capable npm fallback. README installation instructions now describe the root package.

Evidence: `test/pi-package-resources.test.mjs` uses the root-pinned Pi 1.3.0 `DefaultPackageManager.installAndPersist()` and `DefaultResourceLoader` against two fresh temporary `PI_CODING_AGENT_DIR`s and a local source. Full discovery loaded exactly `extensions/delegate.ts`, `extensions/guard.ts`, and `extensions/skill.ts` once, with no errors/warnings; the filtered config loaded only `extensions/guard.ts`. The `Skill` tool was present in loaded extension metadata. This verifies actual resource discovery, not normal-session `delegate` tool registration: worker `ME_PI_RUN=1` intentionally suppresses that tool. `bin/pi-package-resource-harness.mjs` includes an `assert-delegate` probe for the main session and refuses to run that assertion in worker mode. No model runtime/call or auth file access was used. The HTTPS repository URL is declared in the root manifest; GitHub transport/authentication was not tested while the repository is private.

Main-session integration: a scratch `assert-delegate` probe reported `extensions/delegate.ts` with `tools[delegate]`, `extensions/guard.ts` with no tools, and `extensions/skill.ts` with `tools[Skill]`; errors and warnings were empty. The live `./install.sh` exited 0, registered the root source, removed the old `extensions/` source, and reported policy/examples unchanged, `pi-web-access@0.38.0` up to date, and RTK already up to date. Npm surfaced one moderate vulnerability in the installed web-access dependency tree; details and remediation were not investigated. The required `npm run check --prefix extensions` passed: 126 tests and 44 installer smoke checks, Biome made no fixes, and typecheck passed. A prior standalone `npm run lint --loglevel verbose` diagnostic failed with an unexplained ESLint JSON parse error; the full prescribed check passes. GitHub transport/authentication remains untested while the repository is private.

### P3 — Short developer/agent entry point and linked operational docs

Status: DONE; committed in the `goal/pi-package` branch for PR #10 scope.

Rewrite README to approximately 500–700 words: two-line purpose; recommended Pi package install; delegate-only filter example within the existing packages array; concise extension descriptions and natural-language usage; essential status/cancel controls; brief not-a-sandbox/real-checkout warning; development prerequisites and root commands; links for detail. Explain package install does not install the author's global policy, model pools, skills, or full rig. Clearly distinguish optional author setup via ./install.sh. Do not claim private GitHub transport was tested or package-only research has web tools without the separately installed provider extension. Keep normal users independent of the author's policy.

Move operational detail worth retaining into a small number of task-oriented docs under docs/ (configuration, running/recovering jobs, safety limits, optional full rig as needed). Omit benchmarks, personal Skill history, exhaustive source tables, and function/constant maps rather than relocating that slop. Contributor/agent instructions belong in AGENTS.md; preserve its concise existing rules and add only essential nonduplicated contributor pointers if needed. Maintain a single source of truth and relative links. Correct stale paths in these docs where the code moved; no code/runtime/config/install changes, new dependencies or workflow-skill adoption.

Confirmed seams: fact-check every public command, path, tool/role/config identifier, installed-resource distinction and safety claim against current source and Pi 1.3.0 docs; README word count; relative Markdown links resolve; representative delegate.json example validates with current schema; mandatory full npm run check --prefix extensions after final edit. Do not run actual installer, models, authenticated GitHub transport or mutate user settings. Main supplies independent standards/spec fact-check reviews after the passing handback. Close P3 only in a passing commit.

## Delivery

One packaging PR branched from latest main, draft after first passing job. Full goal standards/spec review after final check, at most one high/medium fix job. No merge or remote visibility changes. If WIP commits occur, preserve them and disclose squash-merge requirement in the PR. Known stale branches and unrelated history/licensing audit remain separate approval decisions.
