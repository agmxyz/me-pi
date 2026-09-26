# Single source of truth for agent skills

Both pi and Codex natively discover the Agent-Skills spec directory `~/.agents/skills`. Divergent per-driver copies (codex fork, claude symlink farm) caused drift and stale skills (caveman surviving in three places). We consolidated to one copy of each skill at `~/.agents/skills`, realized as a symlink into the `me-pi` rig repo, so skill edits are git-versioned and every harness sees them.

Considered: keeping per-driver forks (rejected: drift bit within weeks); publishing skills as packages (rejected: personal config, not products). Per-driver extras are allowed when a skill names harness-specific machinery (e.g. Vercel UI skills stay Codex-only).
