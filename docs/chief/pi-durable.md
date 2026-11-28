# Not built on pi-durable

On 2026-11-27 the user asked whether `@earendil-works/pi-durable` could be the chief's foundation. Decision the same day: no.

Reasons, as of version 1.6.1 (published 2026-11-25):
- Its README says "**Experimental.** The API changes without notice between releases." (README line 3, read directly.) `@hatchet-dev/pi-durable` pins `~1.5.0` because a minor release can change the storage format ([web research](sources/web-pi-durable.md)).
- Its README says "One process writes a storage at a time; there is no cross-process locking." (README line 1051, read directly.) The single-chief lock would still have to be written.
- It is a library with no bin, daemon or TUI ([package read](sources/scout-pi-durable-package.md)).
- It is a separate runtime from Pi coding-agent sessions. No loading of Pi extensions, skills, `AGENTS.md` or the TUI was found in its README. This is an absence in the docs, not a tested fact.

The user wants to talk to the chief in a normal Pi session with the existing extensions and policy, which rules it out. A web-research worker rated it "partially fits" for crash survival and report-back inside one host process.

Not followed up: example `22-subagent-background.ts` (persistent subagents that survive restart) was not read; a durable coding-agent demo with a Pi-style TUI existed at v1.0.0 and was not found on main.

See [Architecture](architecture.md) for what was chosen instead.
