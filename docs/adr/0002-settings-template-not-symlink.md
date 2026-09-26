# settings.json is a template, not a symlink

The live `~/.pi/agent/settings.json` is machine state pi actively writes (lastChangelogVersion, per-session prefs). Symlinking it would commit churn and risk clobbering. So the rig carries a curated template: `install.sh` copies it only when no live file exists, and meaningful changes are ported back by hand.

Consequence: role→model assignments for subagents live in the live settings (`subagents.*`), and their intended values are documented in the rig (README/specs), not auto-synced.
