---
name: pi-live-test
description: Live-test a me-pi change in a real interactive Pi with real models, through tmux or a herdr pane.
disable-model-invocation: true
---

# Live-test a me-pi change

The user names the change (issue, PR, or branch) and optionally a herdr pane already running Pi. Run this from the main session; `pi-live.sh` (beside this file) drives Pi. Pi loads me-pi from the installed checkout, so the branch under test must be checked out there.

## 1. Plan

Turn the change's acceptance criteria into live **checks**: one delegate call as exact JSON (or a slash command such as `/delegate status`) plus its expected result. To test the coordinator's own judgement (whether and how it delegates), use the routing evals instead (`evals/README.md` in the me-pi repo): natural requests in isolated Pis, scored from their session logs, with no live checkout switch. Cover each behavior the change adds or removes, and its edge: refusals, config errors, explicit `runs[].model`, web on and off. Leave unchanged behavior to the hermetic tests.

Show the user the checks and an estimated cost (recent `/delegate status` costs are a guide). Name any edit to `~/.pi/agent/delegate.json`, with a timestamped backup first.

**Ready:** the user approved the checks, the cost, and every config edit.

## 2. Run

- Target: `pi-live.sh start <repo root>` starts a throwaway Pi and prints `tmux:<session>`. For a named pane use `herdr:<pane-id>` and run `pi-live.sh cmd <target> /reload` first.
- Send the checks in one `pi-live.sh ask <target> "<prompt>"`. The prompt numbers the calls, says to make them one at a time exactly as written, then paste each result verbatim including its `[model @thinking …]` footer, with no other tool calls and no retries.
- Run slash-command checks with `pi-live.sh cmd <target> "<command>"`.
- Briefs for `general` and `scout` name files to read: read-only workers have no shell.

**Ready:** the screen shows a pasted result for every check.

## 3. Verify and report

Compare each result with its expectation: footer model and thinking, `web` badge, tools, refusal text. Pi validates arguments against the tool schema before `execute` runs, so a schema refusal shows Pi's validation error, not the tool's own. Report a table of check, expected, actual, and pass or fail, with the run's cost from `/delegate status`, then `pi-live.sh stop <target>` for a tmux target.

**Ready:** every check has a verdict, and any config edit is listed with its backup path.
