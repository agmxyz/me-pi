---
description: Scout recon then a plan — no edits (pre-ceremony exploration)
argument-hint: "<question, area, or feature idea>"
---
Explore before planning. No file may be edited. You are the coordinator.

Subject: $@

1. **Scout.** Dispatch the `scout` agent (fast, cheap) with the subject. It returns compressed context: relevant files, entry points, data flow, risks.
2. **Plan.** Using the scout's context — not re-reading the code wholesale — draft a short plan: the smallest complete solution, files to touch, risks, and open questions.
3. **Attack.** Dispatch the `devils-advocate` agent on the plan (it can read the repo itself).
4. **Synthesize.** Merge: the plan, the DA's challenges and what they change, and the open questions only you can answer.

Output: the plan, then DA challenges, then open questions. Keep it tight.
