# settings.json is a template, not a symlink

The live `~/.pi/agent/settings.json` is machine state pi actively writes (lastChangelogVersion, per-session prefs). Symlinking it would commit churn and risk clobbering. So the rig carries a curated template: `install.sh` copies it only when no live file exists, and meaningful changes are ported back by hand. The template carries no model choices; defaults are chosen on the machine.

Consequence: role→model assignments for subagents live in machine-local settings (`subagents.*`). The rig does not prescribe model IDs or sync overrides. The installer registers the local extension package and pinned third-party Pi packages with `pi install`; Pi records those package sources in live settings without replacing machine-local preferences.
