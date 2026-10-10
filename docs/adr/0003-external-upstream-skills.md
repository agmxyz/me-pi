# Keep externally managed skills out of the repo

Track only me-pi-owned skills here. Matt Pocock skills installed and updated globally remain external copies in `~/.agents/skills`; don't vendor duplicate names or customized upstream copies, which create competing sources of truth. `install.sh` links repo-owned skills individually and leaves external entries untouched.

Repo-owned skills (what `~/.agents/skills` links to): `edit-article`, `find-skills`, `obsidian-vault`, `resolving-merge-conflicts`, `task-first-ui`, `write-a-skill`, `zoom-out`, `delegate`. Removed as deprecated upstream or overlapping installed skills (`codebase-design`, `domain-modeling`): `design-an-interface`, `ubiquitous-language`, `qa`, `request-refactor-plan`.
