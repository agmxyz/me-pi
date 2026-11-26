---
name: implement-me-pi
description: Run one implementation task as its coordinator, writing the change yourself with mandatory independent review.
disable-model-invocation: true
metadata:
  credits:
    - skill: implement
      author: Matt Pocock
      license: MIT
      url: "https://github.com/mattpocock/skills/tree/4ae2317/skills/engineering/implement"
      use: adapted
---

# Implement one task with me-pi

User entry: `/skill:implement-me-pi` followed by one ticket, issue, or task, its repository, and any execution constraints, or a contract (a chief's, or an unattended run's) that answers them. This skill owns one task; running a ticket graph is the chief's job.

You are the task's **coordinator** and its only writer: you edit, run the check, and commit yourself. Use `delegate` with `scout` or `general` only for read-only help: exploration, research, and review.

**Unattended mode.** When a contract is supplied, nobody answers in your pane. Asking, proposing, or waiting ends the run with nothing delivered. Where the brief leaves a choice open, take the reading that satisfies every stated criterion, record `Ruling: <choice>, because <why>; if wrong: <cost>`, and continue. In an interactive session, ask the user instead. When the contract names someone who answers (a chief), follow its rule for questions.

**Goal.** You are done when all three hold: the exact check passes on `HEAD`, `HEAD` is committed with a clean tree, and every acceptance criterion has evidence. Until then, keep looping. Reading, a plan, or partial work is not a stopping point; unfinished is not BLOCKED.

**BLOCKED, the closed list.** End with BLOCKED only for one of these, quoting the evidence: (1) two quoted criteria that no implementation can satisfy together; (2) a guard-denied action with no other route; (3) an environment impasse shown with commands and output, after at least one real attempt. Nothing else stops the run.

## 1. Ground (four facts, then go)

Record the branch and tip, the fixed review point as a SHA (never a moving `HEAD`), the exact check, and the acceptance criteria as a numbered list. Read the repository instructions and the code the task owns. Then run the exact check once on the untouched tree, so you know its baseline output. Do not judge the task's size first; start.

## 2. Loop until the goal holds

Repeat:
1. Make the smallest change that moves one criterion forward, reading the owning code and tests first. Send broad reading to `scout` or `general`.
2. Run focused tests for it, with a per-test timeout.
3. Run the exact check alone. When it passes, **commit at once**, using the repository's commit convention. Your first green commit should come early: later criteria are later commits, so delivered work is never lost.
4. Mark which criteria now have evidence.

Repair ordinary failures (a failed test, lint, or typecheck) in the loop without asking. Load `tdd` only when the task or repository requires test-first work.

## 3. Review the committed result

Once the goal holds, load `code-review` with `Skill`, give it the fixed review point and the task/spec, and run its **Standards** and **Spec** axes in parallel with read-only reviewers. Include a reviewer from a different provider/model family whenever your delegate models offer one; otherwise record `no cross-family reviewer`. Fix findings of Medium or higher yourself in one more pass of the loop (change, check, commit), and have a read-only reviewer check that corrective delta. List the rest with dispositions. A review step you could not complete goes under Not verified; it never turns committed, green work into BLOCKED.

## 4. Report

First re-check the goal: if it does not hold and no closed-list reason applies, go back to the loop. Then write the report the contract asks for: final SHA, the exact check and its result on that SHA, each criterion with its evidence, every ruling, review findings and dispositions, and what is not verified. A BLOCKED report names its closed-list reason and still reports the commits and progress made.

## Safety

Never silently switch branches, reset, rebase, stash, discard, or create a worktree. A guard-denied action stays denied: never retry or relay it through another tool, worker, path, session, model, account, or provider. After an interruption, check the repository's state (branch, tip, status, what your last commands changed) before acting, and never repeat a destructive or external command until that state shows its outcome.
