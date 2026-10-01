# Shared skill sources, isolated live directory

Status: superseded by ADR 0003.

Pi and Codex both discover the Agent Skills directory at `~/.agents/skills`. Keep the rig's curated skill sources in this repo so edits are versioned and both harnesses use the same content; do not maintain per-driver forks.

`install.sh` keeps `~/.agents/skills` machine-owned and links each repo skill directory into it individually. Skills installed by external tools remain separate entries in the live directory. Never symlink the entire live directory to the repo or adopt live entries into the repo. On a name collision, preserve the existing live skill and report it for manual resolution.

Considered: publishing the rig's personal skill set as a package (rejected: it is a personal shared config, not a product). Per-driver extras are allowed when a skill names harness-specific machinery (e.g. Vercel UI skills stay Codex-only).
