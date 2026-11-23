# Evals of the always-loaded text

Two sets of manual checks share one runner: **routing evals** (`scenarios/routing.json`), below, and **policy tasks** (`scenarios/policy.json`), in [their own section](#policy-tasks).

## Routing evals

Manual checks that the always-loaded text (`GLOBAL_AGENTS.md`, `PROMPT_GUIDELINES`, the delegate tool's description and schema) still routes natural requests the way it should. Each attempt is one request in a fresh Pi, scored from that Pi's session log. They make real model calls and spend real money, so they never run in `npm run check` or CI; only the scorer and sandbox have hermetic tests there. Tracked in #56.

Run them before merging any change to that text. A 3–12-word edit has flipped routing before (#58: the job id dropped from check 7, check 12 went from inline to `implement`).

## Isolation

Each ref gets its own temp root. `HOME`, `TMPDIR`, and `PI_CODING_AGENT_DIR` (= `$HOME/.pi/agent`, where `delegate.json` and the worker auth fence also resolve) point inside it. Pi loads me-pi from a clone of the ref with no remote, through a generated `settings.json`, the same way workers load it. Pi runs under `env -i` with an allowlisted environment, on a private tmux server, and writes its session to a per-attempt `--session-dir`. Code-editing checks run in a fresh copy of `fixtures/tiny-cli`; read-only checks run in their own clone of the ref.

The run never touches `install.sh`, live settings, `delegate.json`, skills, `auth.json`, or the live checkout. It hashes those before and after the run and warns if any changed. One thing is shared: the `pi` launcher's managed install (`~/.pi/agent/install`), meaning the Pi binary itself.

Policy `full-rig` (the routing checks) links the clone's `GLOBAL_AGENTS.md` as `AGENTS.md`, links its `skills/`, adds `+codemode`, and installs `npm:pi-web-access@0.46.0` into the sandbox, loaded before me-pi as in the live rig. `extensions-only` (for #56's pilot) loads the me-pi package alone.

Personal skills and extensions are not loaded by default, and routing depends on them. Check 12 on `main` (`e12bc29`), inline runs:

| Setup | Inline |
|---|---|
| Live rig | 4/5 |
| Sandbox, repo skills only (no skills block: they set `disable-model-invocation`) | 1/6 |
| + 15 personal skills | 2/5 |
| + RTK extension only | 3/5 |
| + personal skills and RTK | 5/5 |
| + personal skills and all 4 live extensions | 5/5 |

To match a live rig, pass its skills with `--skill <dir>` (linked read-only) and its extensions with `--extension <file>` (copied). Each record hashes what you added. Compare refs only under the same setup.

## Credentials

`openai-codex` (the coordinator) accepts OAuth only, so it needs a login, not an API key. Make a dedicated eval login once, outside `~/.pi`:

```sh
PI_CODING_AGENT_DIR=~/.config/me-pi-evals/agent pi   # then /login openai-codex, then quit
```

Pass that file with `--auth ~/.config/me-pi-evals/agent/auth.json`. The runner refuses any credential under `~/.pi`. Never copy the live `auth.json`: an OAuth refresh rotates the refresh token, so a copy desyncs the real login. Attempts share the eval login and its subscription quota, and an `account` error stops the sweep.

The pool (`pools/codex.json`) uses `openai-codex` models only. Check 6 also needs a credential for `claude-opus-5-5`, so it is opt-in.

## Run

```sh
node evals/run.ts --dry-run                       # no credentials, no model calls: Pi starts and loads the policy
node evals/run.ts --auth <file>                   # default checks once against HEAD
node evals/run.ts --auth <file> --only 12 --n 5 --ref main --ref my-branch   # compare two refs
node evals/run.ts --auth <file> --only 3 --skill ~/.agents/skills/code-review
```

| Option | Default | Meaning |
|---|---|---|
| `--ref` | `HEAD` | Ref to test; repeat to compare. Attempts interleave across refs, so drift during the sweep hits every ref alike |
| `--scenarios` | `scenarios/routing.json` | Scenario file; `evals/scenarios/policy.json` runs the policy tasks |
| `--coordinator` | the scenario file's | `provider/model[:thinking]`, to run the same checks on another model; the eval login needs that provider |
| `--only` | all but opt-in | Comma-separated check ids |
| `--n` | 1 | Attempts per check and ref. n=1 is noisy; use 5 where wording changed |
| `--jobs` | 4 | Attempts in parallel |
| `--budget` | 3 | `ME_PI_SPEND_BUDGET_USD` per attempt; it warns, it does not enforce |
| `--out` | `~/.local/state/me-pi-evals/<sweep>.jsonl` | Record file, mode 0600 |
| `--keep` | off | Keep the sandbox roots for inspection |

The run prints one line per attempt, then a table of passes over completed attempts per check and ref, with void, incomplete, and cost columns. Cost is Pi's estimate, not the provider's counter. Rough costs at n=1: check 3 about $2.7, check 4 about $0.8, the rest $0.03–0.5.

## Checks and records

`scenarios/routing.json` lists each check's prompt, follow-up turns, working directory (`repo` or a fixture), and assertions. `score.ts` defines the assertions: `skill`, `delegate` with `count` (`named` matches runs that set a model or thinking), `noTool`, `maxOwnRead`, `inline`, `noRerun`, `diffByPath`, `reply`, `maxReplyWords`. A tool call made from a codemode script counts like a direct one: Pi records its name, arguments and status on the codemode result, and `score.ts` reads them from there.

Each record holds:
- the commit, Pi and node versions, the coordinator and the policy;
- hashes of the prompts, assertions, fixture commit, pool, and the git trees of `packages/pi-workers/extensions/` (`extensions/` for refs before the package move), `GLOBAL_AGENTS.md`, and `skills/`;
- the duration, call count, and estimated cost;
- the state, `completed`, `void` (`STOPPED: infra` in `ME_PI_STATUS_LOG`), or `incomplete` (account stop, timeout, or no session log), and the outcome, `pass`, `fail`, or `unknown`;
- a verdict with evidence for every assertion.

Records stay outside the repo. Post only summary tables.

## Policy tasks

`scenarios/policy.json` tests single lines of `GLOBAL_AGENTS.md`'s `## Output` and `## Engineering` sections. Each task under `tasks/<id>/` is a small fixture repo, a `prompt.txt`, and a `score.mjs` the model never sees, built so that the model's default plausibly goes wrong without the line. Where a routing check is scored from the session log, a task is scored from the work directory and the final reply.

```sh
node evals/run.ts --auth <file> --scenarios evals/scenarios/policy.json --n 5 --ref main --ref my-branch
node evals/run.ts --auth <file> --scenarios evals/scenarios/policy.json --n 5 --coordinator openai-codex/gpt-6-luna
```

| Task | Line under test | Passes when |
|---|---|---|
| `out-lead` | Lead with the result; no closing offers | the first sentence states the outcome and the last paragraph offers nothing |
| `out-sentence` | answer length (no line as of #143) | the answer is right in 60 words or fewer; prints `metric=<words>` |
| `out-quote` | Quote paths, commands, identifiers, and errors exactly | the file name, the SKU and the error text appear verbatim |
| `out-disclose-needed` | the disclosure line | the reply says the real remote API was not verified or was assumed |
| `out-disclose-trivial` | the disclosure line, opposite risk | a one-line lookup carries at most one caveat sentence; prints `metric=<caveats>` |
| `eng-ask` | Proceed unless ambiguity… then ask | the reply asks or reports blocked, and the code picks no reading |
| `eng-orphan` | …existing patterns and libraries; remove code it orphans | the existing helper is reused and no dead helper is left |
| `eng-errors` | Let unexpected errors propagate… | a malformed config file throws, where a default would hide it |
| `eng-tests` | …never weaken or skip tests to pass | a hidden copy of the original test still passes |

**Scorer contract.** `node score.mjs <run-dir> <work-dir>`: `<run-dir>/answer.txt` is the final reply, `<work-dir>` the repo after the run. Exit 0 passes and exit 1 fails, with the reason on the first stdout line and an optional `metric=<n>` line. Anything else is recorded as `unknown`: exit 2, a timeout, or a scorer that crashed. A provider error makes the attempt `incomplete`, not a fail. Scorers run hidden tests, which executes code the model wrote, so they run with the sandbox's environment.

Each task keeps a good and a bad example under `examples/`; `test/evals-task.test.ts` checks in `npm run check` that every scorer passes the first and fails the second. `NOTE.md` says what could fool the scorer. Reply-text scorers are keyword patterns: read a sample of the failures before acting on a count.

**Reading results.** One attempt says little. Two runs of the same text have differed by up to 12 points pooled over 7 models and by 3 of 5 attempts on one model, so compare refs at `--n 5` or more and treat smaller gaps as noise. To test a line, compare a ref with it against a ref without it.

**Results on 2026-11-15**, from a standalone runner that predates this integration: it injected the policy with `--append-system-prompt`, on 7 models at medium thinking, 5 attempts each. Passes of 35, with the two sections removed against the text merged in #143 (a second identical run in brackets): `eng-errors` 15 against 35 (35); `eng-orphan` 0 against 19 (17); `eng-ask` 0 against 4 (3), all from `gpt-6.1-sol`; `out-lead` 28 against 29 (29); `out-quote` 14 against 21 (17); `eng-tests` 34 against 35 (33); `out-sentence` 18 against 16 (16). These numbers are not comparable with runs of this harness, which loads the full rig.

To add a task, write its folder with both examples, name it in `scenarios/policy.json`, and calibrate it: a task every model passes without the line cannot show the line working. Four such tasks were dropped for that reason.
