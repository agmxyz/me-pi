# Spec: `/me-setup` — rig status and worker commit guard

`/me-setup` and `/me-setup status` both show the read-only rig status report. Other arguments print usage.

Model/thinking precedence is defined in the [delegate skill](../skills/delegate/SKILL.md); roles pin them in `agents/*.md` frontmatter. The extension never writes settings. Credential values are never displayed, returned, or modified.

## Worker commit policy

Delegated workers (`ME_PI_RUN` set) have textual `git commit` calls blocked in the bash tool and leave changes uncommitted. Detection covers common wrappers and Git flags, not aliases, dynamically assembled commands, or all option spellings; it is not a sandbox. Main-session commits are unaffected.

For policy refresh and fresh-session validation, follow the [migration guide](migration.md#refresh-this-rig).

## Status checks

| Check | Pass criteria |
|---|---|
| Local extension package | repo `extensions/` package registered in live settings |
| Live extension directory | exists outside the repo; list installed `.ts` files |
| RTK | binary and live `extensions/rtk.ts` present |
| Interactive shell | live `extensions/interactive-shell.ts` present |
| Pi packages | list configured package sources |
| Repo skills | linked/expected counts; name every unlinked entry |
| Global agent instructions | `~/.pi/agent/AGENTS.md` symlinks to repo `GLOBAL_AGENTS.md` |
| Coding standards | `~/.agents/CODING_STANDARDS.md` symlinks to repo `CODING_STANDARDS.md` |
| Auth providers | at least one provider key; never display credential values |
| Roles | list roles in repo `agents/` |
| Rig Git state | report commit and dirty flag |

Output a compact checklist with ✓ / ⚠ / ✗ and fix hints. Include the repo path and Git HEAD/dirty state. Status does not modify settings.
