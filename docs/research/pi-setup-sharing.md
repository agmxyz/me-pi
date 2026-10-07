# Pi setup sharing: research record

This preserves the evidence and reasoning behind the rig's ownership and installation choices. Current setup and recovery steps live in [README.md](../../README.md) and [specs/migration.md](../../specs/migration.md); recorded ownership decisions live in [docs/adr/](../adr/).

## Findings

1. **User vs project scope.** Pi's user configuration lives under `~/.pi/agent`; `.pi/` is for project resources gated by trust. This is a personal setup, so user scope avoids requiring project trust. Project trust is not a sandbox because extensions retain operating-system permissions. Sources 1–3.

2. **Local package vs copied code.** Pi supports local-path packages. An explicit `pi.extensions` manifest limits loading to `me-setup.ts`, rather than treating tests and package metadata as extensions. Pi supplies its own runtime and TUI dependencies, so the package declares them as peers; `npm ci --prefix extensions` is for local tests, not package installation. Sources 4–5.

3. **External extension ownership.** The former `~/.pi/agent/extensions -> repo/extensions` link made the repo an install target. RTK's Pi setup writes `rtk.ts` in the live directory; Pi's `interactive-shell.ts` is a bundled example rather than a standalone package. Keeping both in the machine-owned directory prevents external setup from writing into tracked sources. Sources 6–8.

4. **Machine-local model assignments.** Model preferences vary by machine, so the settings template carries none; `/me-setup` and `bin/delegate` consume live settings instead. The current precedence and behavior are documented in [specs/me-setup.md](../../specs/me-setup.md) and [ADR 0002](../adr/0002-settings-template-not-symlink.md).

5. **Shared skills and ownership.** Pi and Codex discover `~/.agents/skills`, while the `skills` CLI manages its own installed entries. That shared discovery made per-skill repo links possible, but did not make externally installed skill sources repo-owned. Ownership and collision decisions are recorded in [ADR 0001](../adr/0001-single-source-skills.md) and [ADR 0003](../adr/0003-external-upstream-skills.md). Sources 9–10.

6. **Secrets in model files.** `models.json` can contain literal API keys; keep it out of Git and prefer environment- or command-backed keys. Source 11.

## Limits

Three inspected public personal configs showed copy, symlink, and clone-in-place approaches; this small sample cannot establish prevalence (Source 12). An externally managed skill with a colliding name still needs manual ownership resolution. Review globally loaded extensions as executable trusted code.

## Sources

1. Pi [Configuration](https://pi.dev/docs/latest/configuration#project-pi-directory).
2. Pi [Settings](https://pi.dev/docs/latest/settings#resources).
3. Pi [Security](https://pi.dev/docs/latest/security#understand-project-trust).
4. Pi [Packages](https://pi.dev/docs/latest/packages).
5. Pi [Extensions](https://pi.dev/docs/latest/extensions).
6. RTK [README](https://github.com/rtk-ai/rtk#installation).
7. RTK [changelog](https://github.com/rtk-ai/rtk/blob/main/CHANGELOG.md).
8. Pi [bundled extension examples](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions).
9. Pi [Skills](https://pi.dev/docs/latest/skills).
10. Vercel [`npx skills`](https://github.com/vercel-labs/skills).
11. Pi [Models](https://pi.dev/docs/latest/models).
12. Personal config examples examined: [agent-stuff](https://github.com/theskumar/agent-stuff), [dotpi](https://github.com/arjun-zosma/dotpi), and [pi-config](https://github.com/HazAT/pi-config). Their approaches are examples, not prevalence evidence.
