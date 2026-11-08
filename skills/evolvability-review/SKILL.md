---
name: evolvability-review
description: Review a diff for the cost it adds to the next change, using code as the evidence.
disable-model-invocation: true
metadata:
  credits:
    - skill: codebase-design
      author: Matt Pocock
      license: MIT
      url: "https://github.com/mattpocock/skills/tree/4ae2317/skills/engineering/codebase-design"
      use: loaded for its vocabulary
---

# Evolvability review

User entry: `/skill:evolvability-review` with a fixed point (commit, branch, tag, or `main`), or `working tree` for uncommitted changes. This lens asks one question: **what does the code show about the cost of the next change?** Documented-rule conformance belongs to `code-review`'s Standards axis and requirement fit to its Spec axis; this lens reports neither.

Load `codebase-design` for vocabulary: **module**, **interface** (every fact a caller must know, including invariants, error modes, and side effects), **seam**, **locality**. Its seam heuristics are leads here, never findings by themselves.

## Evidence rule

Code is the evidence: source, callers, tests, and git history. Prose (docs, comments, commit messages, `GLOSSARY.md`, ADRs) is a claim: use it to choose where to look, then confirm or refute it in code. When prose and code disagree, report **drift** naming both locations, without assuming which side is wrong. Drift covers prose the diff touches and prose the diff makes false; commit messages count only when they misdescribe the diff itself. Authorship is irrelevant; review the code, never whether an agent wrote it.

## 1. Pin the change

Resolve the fixed point (`git rev-parse <ref>`) and capture `git diff <ref>...HEAD` plus `git log <ref>..HEAD --oneline`; for `working tree`, capture `git diff HEAD` and untracked files. Stop on a bad ref or empty diff.

**Ready:** one diff command, its commit list, and its changed files.

## 2. Trace the blast radius

For each changed interface, follow it out of the diff: its callers, its implementers, the tests that exercise it, and the other places holding the same rule or representation (search by name, literal, and shape). For changed files, run `git log --format= --name-only -- <file>` style co-change lookups to see what historically moves with them. A **changed interface** is one exported or cross-module entry point whose signature, behavior, errors, or side effects the diff alters; count each once. Pre-existing code is in scope when the diff newly creates, endorses, or relies on a path into it (a new caller, a newly supported case, a guard that assumes it). Read until each changed interface is traced or explicitly marked untraced.

**Ready:** a coverage list naming each changed interface, marked traced, partially traced (why), or untraced (why).

## 3. Hunt for change cost

Look for mechanisms by which the next plausible change gets more expensive or riskier:

- **Leaked decision**: a choice likely to change (format, storage, protocol, policy, vendor) becomes visible to callers instead of hidden behind one interface.
- **Duplicated knowledge**: one rule, mapping, or representation now lives in two or more places that must change together and can drift. A test that spells out expected values independently is an oracle, not a copy.
- **Change amplification**: one plausible requirement would force coordinated edits across modules that do not otherwise belong together.
- **Contract drift**: validation, error handling, defaults, ordering, state transitions, or side effects changed silently, or differ from what callers and tests assume.
- **Blind feedback**: a rule or behavior the diff adds or changes has no test that would go red if a later change broke it, or its tests pin implementation details that will break on harmless refactors. Gaps the diff neither creates nor changes are out of scope.
- **Prose drift**: docs or comments touched or relied on by the diff now disagree with the code.

For each candidate, write the **chain**:

1. **Evidence**: file and lines quoted from the code.
2. **Change scenario**: a plausible next change, grounded in the diff, nearby history, or a stated requirement, not invented.
3. **Mechanism**: why that change costs more here (which edits, which places, which hidden assumption).
4. **Consequence**: the concrete outcome: missed edit, silent wrong behavior, test that cannot catch it, wider diff.
5. **Counterevidence**: what you checked that would make it fine (a seam justified by volatility or testing, a test already pinning the contract, a single owner elsewhere, a documented decision covering this exact choice in a standards file, ADR, or the commit that made it), and what you found. A documented constraint confirmed in code reshapes the remedy; it drops the candidate only when no remedy fits within it. Prose alone does neither.
6. **Remedy**: the smallest bounded change that removes the root cause named in the mechanism, within the repo's documented constraints, and how to verify it.

A candidate whose chain breaks at any link is listed under abstentions with the broken link named. A wider future diff is a valid consequence: report it at Low rather than abstaining. Size, line counts, and smell names alone are leads, not findings.

**Ready:** every candidate has a complete chain, or sits in abstentions with the broken link named.

## 4. Grade

- **Severity** follows consequence: **High** (silent wrong behavior or a missed edit likely on the next plausible change), **Medium** (the next change needs coordinated edits a reader would likely find), **Low** (friction with no correctness risk). A missing test alone is not a consequence: grade blind feedback by what the untested break would do to users, capped at Medium unless the diff itself introduces the fragile rule.
- **Confidence** follows evidence: **High** (chain traced in code and history), **Medium** (traced in code; scenario inferred), **Low** (partial trace).
- Severity and confidence stay separate. A Low-confidence candidate is reported as a Minor line, never as a finding.
- A change that newly creates, endorses, or relies on a path where data can be lost, orphaned, or left inconsistent is at least Medium.
- Report High and Medium findings with their full chain. Report each Low as one line under **Minor** (evidence location, mechanism, remedy).
- Security, performance, and style concerns are out of scope unless they raise the cost of the next change; note them under abstentions with that reason.

**Ready:** each finding carries one severity and one confidence.

## 5. Report

```markdown
## Evolvability

Scope: <diff command> · <N> files · interfaces traced <a>/<b>
Checks run: <commands and results, or "none">

### Findings
#### <id>. <title> — Severity <H/M/L> · Confidence <H/M/L>
- Evidence: <path:lines> `<quote>`
- Change scenario: <...>
- Mechanism: <...>
- Consequence: <...>
- Counterevidence checked: <...>
- Remedy and verification: <...>

### Minor
- <path:lines>: <mechanism> → <remedy>

### Drift
- <doc path:line> says <...>; <code path:line> does <...>.

### Abstentions
- <lead>: dropped because <broken link>.

### Not covered
- <untraced interfaces, unread areas, checks not run>
```

An empty Findings section is a valid result; state it plainly. "Not run" is reported as not run, never as a pass.

**Ready:** the report states scope, every High and Medium finding with its chain, every Low as a Minor line, drift, abstentions, and what was not covered.
