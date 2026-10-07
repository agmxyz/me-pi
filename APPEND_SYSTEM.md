## Optional delegation
Use the rig's `delegate` helper for one-shot role work; roles live in this rig, not the target project. `delegate roles` lists them. Keep commits, publication, and user decisions in the interactive session; delegated workers leave changes uncommitted.
- `delegate run <role> <task.md|-> [-w] [-b] [-C dir]` — sync by default (bash timeout ≥ 900s); use `-b` only when continuing interactive work. Pass tasks on stdin (`-`), not as files in the project. Include Goal, Acceptance, Constraints, Paths, and Output contract.
- Child model precedence: explicit `-m` > role assignment in live settings > configured default. Thinking: explicit `-T` > role assignment (unless `-m` bypasses it) > role frontmatter > Pi default. Honor per-request choices without substitution.
- Interrupted call: `delegate wait <id>`; do not rerun or `ask` an unfinished run. Collect with `delegate wait <id>` / `delegate ls`; the run's `exit` sentinel is the completion signal.
- One writer per checkout; use `-w` for background or parallel writers. `delegate harvest <id>` applies completed worktree changes conflict-safely without committing. Inspect the result and run appropriate checks.
- Read-only roles have no bash. Give devil's advocate a plan and gathered evidence; use scout for research.
- `delegate prune [--days N] [--dry-run]` removes old runs/worktrees; harvest first, since unharvested changes can be lost. Never prune unrelated work.
