# Spec: `/me-setup` — rig status and model control

Bare `/me-setup` opens the interactive default-first model chooser. `/me-setup status` is a read-only rig inventory. The chooser writes only when a selection changes.

## Commands

| Invocation | Behavior |
|---|---|
| `/me-setup` | interactive default and per-agent model chooser |
| `/me-setup status` | read-only status report |

Model choices come from `models-store.json` and require a provider key in `auth.json`. Credential values are not displayed, returned, or modified. Model selections remain machine-local.

The chooser writes `subagents.defaultModel`, `subagents.defaultProvider`, `subagents.defaultThinking`, and per-role `subagents.agentOverrides` in live `~/.pi/agent/settings.json`. Picking a default also switches the active session's model (`ctx.setModel` / `pi.setModel`, resolved via the model registry). The sync is bidirectional: the extension listens to Pi's `model_select` event and mirrors `/model` selections (and Ctrl+P cycling) back into `subagents.defaultModel` / `subagents.defaultProvider`, leaving `defaultThinking` and per-role overrides untouched. Session restores (`source: "restore"`) and no-op selections (settings already match) do not rewrite settings; models absent from the catalog are still saved. `bin/delegate` consumes per-role overrides for matching `agents/<role>.md` files, falling back to `subagents.defaultModel` / `subagents.defaultProvider`. Resolution is strict: `delegate run -m MODEL` wins; otherwise a role override supplies `--model` as `defaultProvider/model` (or bare `model` when the provider is false or absent) and its thinking; otherwise the rig default supplies `--model` while the role frontmatter keeps its thinking; otherwise pi chooses the model and frontmatter thinking applies. A role's frontmatter thinking always wins over `subagents.defaultThinking` when an override has no thinking. Invalid or missing settings are ignored. The chooser offers only repository roles and prunes stale override keys when saving.

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
