# me-pi

The personal pi coding-agent rig: shared config, skills, extensions, and agent definitions that personalize both pi and the Codex CLI from one source of truth.

## Language

### Rig

The `me-pi` repo plus its symlinked live locations (`~/.pi/agent/*`, `~/.agents/skills`). The rig is the single source of truth; live dirs are views.
_Avoid_: dotfiles, config repo

### Co-driver mode

The operating split where Codex stays primary for interactive work and pi runs daily on real work, split by task type. Neither is a demo; both are used. _Avoid_: migration, lab

### Ticket

One independently-grabbable unit of work produced by the Pocock ticket flow (`to-tickets`), small enough for one fresh agent context. The unit the orchestration layer works in.
_Avoid_: issue, task, story

### Output contract

The fixed, compressed return format an agent must produce so the coordinator's context stays lean (path:line — symbol — note; verdict+findings; etc). Inspired by the retired cavecrew skill.
_Avoid_: summary, report

### Ceremony threshold

Work below it runs directly with no agents (quick fixes, questions); work above it enters the ticket flow. Coarse but explicit.
_Avoid_: complexity gate
