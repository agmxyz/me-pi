# Spec: `/me-setup` — rig status and model control

Bare `/me-setup` opens the interactive default-first model chooser. `/me-setup status` is a read-only rig inventory. The chooser writes only when a selection changes.

## Commands

| Invocation | Behavior |
|---|---|
| `/me-setup` | interactive default and per-agent model chooser |
| `/me-setup status` | read-only status report |

Model choices come from `models-store.json` and require a provider key in `auth.json`. Credential values are not displayed, returned, or modified. Model selections remain machine-local.

## Status checks

| Check | Pass criteria |
|---|---|
| Local extension package | repo `extensions/` package registered in live settings |
| Live extension directory | exists outside the repo; list installed `.ts` files |
| RTK | binary and live `extensions/rtk.ts` present |
| Interactive shell | live `extensions/interactive-shell.ts` present |
| Pi packages | list configured package sources |
| Repo agents and skills | linked/expected counts; name every unlinked entry |
| System addendum | `APPEND_SYSTEM.md` points to this repo |
| Auth providers | at least one provider key; never display credential values |
| Agent models | report default and per-agent overrides |
| Rig Git state | report commit and dirty flag |

Output a compact checklist with ✓ / ⚠ / ✗ and fix hints. Include the repo path and Git HEAD/dirty state. Status does not modify settings.
