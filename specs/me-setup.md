# Spec: /me-setup — rig pre-flight check

A `/` command that shows what the rig has wired before the user starts working. Read-only.

## Checks

| # | Check | Source | Pass criteria |
|---|---|---|---|
| 1 | Rig symlinks | stat `~/.pi/agent/{extensions,agents,prompts}` , `~/.agents/skills`, `~/.pi/agent/APPEND_SYSTEM.md`, `~/.pi/damage-control-rules.yaml` | symlink, target inside this repo |
| 2 | Extensions loaded | dir scan of live extensions dir | list .ts/.dirs found |
| 3 | pi packages | `~/.pi/agent/settings.json` `packages[]` | list name@version |
| 4 | rtk binary | `which rtk` + `rtk --version` (2s timeout) | present, ≥0.23 |
| 5 | Auth providers | parse `auth.json` **filenames/keys only** (existence; never values) | ≥1 provider |
| 6 | Agents | scan live agents dir (*.md → name field) | list names + model override if any |
| 7 | Prompts | scan live prompts dir | list commands |
| 8 | Skills | count entries in `~/.agents/skills` | count + note shared-with-codex |
| 9 | Role→model | settings `subagents.agentOverrides` | table |
| 10 | Guardrails | rules file readable + pattern count | loaded, N patterns |

## Output

Compact checklist, ✓ / ⚠ (works with caveat) / ✗ (broken + fix hint). Footer: rig repo path + git HEAD (dirty flag).

## Non-goals

No mutation, no auto-fix, no network. `--json` mode deferred (v2 if needed).
