# Spec: `/me-setup` — rig status and model control

Bare `/me-setup` opens the interactive default-first model chooser. `/me-setup status` is a read-only rig inventory. The chooser writes only when a selection changes.

## Commands

| Invocation | Behavior |
|---|---|
| `/me-setup` | interactive default and per-agent model chooser |
| `/me-setup status` | read-only status report |

Model choices come from `models-store.json` and require a provider key in `auth.json`. Credential values are not displayed, returned, or modified. Model selections remain machine-local.

The chooser writes `subagents.defaultModel`, `subagents.defaultProvider`, `subagents.defaultThinking`, and per-role `subagents.agentOverrides` in live `~/.pi/agent/settings.json`. `bin/delegate` consumes per-role overrides for matching `agents/<role>.md` files. Resolution is strict: `delegate run -m MODEL` wins; otherwise a role override supplies `--model` as `defaultProvider/model` (or bare `model` when the provider is false or absent) and its thinking; otherwise the role frontmatter supplies thinking and pi chooses the model. A role's frontmatter thinking always wins over `subagents.defaultThinking` when an override has no thinking. Invalid or missing settings are ignored. The chooser offers only repository roles and prunes stale override keys when saving.

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
