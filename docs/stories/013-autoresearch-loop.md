---
id: "013"
title: Let an agent propose review workflows and keep the better ones
summary: "`awf-lab loop` has a codex agent write one changed review workflow per try from the tuning cases' feedback, runs it in a container against the incumbent with story 011's comparison, keeps it only on `better`, logs every try as a tree, stops at a spend cap, and checks the final incumbent once on a holdout fixed before the first proposal."
type: story
status: in-progress
discovered_in: "docs/stories/todo/autoresearch-loop.md, 2026-09-30"
depends_on: ["011"]
---

# Let an agent propose review workflows and keep the better ones

## Outcome

`awf-lab loop {name}` runs the autoresearch loop over review workflows on the data repository's
dataset, with no person in it ([ADR 0002](../adr/0002-autoresearch-lives-here.md)). In each try a
proposer agent reads what the incumbent missed on the tuning cases and why, and writes one changed
workflow with one hypothesis. `awf-lab` checks the change is in scope and runs it against the
incumbent case by case until story 011's comparison says stop. The change is kept only on
`better`. Every try is logged, the loop stops at a spend cap enforced from the records, and the
final incumbent is checked once, on fresh trials, against cases the proposer never saw.

Why now: the comparison (011), isolated trials (010), workflow tests (012) and the fixtures (005)
exist. The loop is the first consumer that changes workflows instead of only measuring them.

## How it works

```text
            tuning cases only                          holdout (10, fixed now)
                  │                                          │
   ┌──────────────▼──────────────┐                           │
   │ bundle: metrics, `missed`,  │                           │
   │ incumbent source, history,  │                           │
   │ program.md, rules, $ left   │                           │
   └──────────────┬──────────────┘                           │
                  ▼                                          │
   proposer (codex, awf run, srt)                            │
   writes workflow.ts + hypothesis.json                      │
                  ▼                                          │
   scope check ── fails ──► try logged "refused"             │
                  ▼                                          │
   run --baseline incumbent (011's runAgainst),              │
   every trial whole in a container, the key not in it       │
                  ▼                                          │
   verdict ── better ──► incumbent := candidate              │
          └─ else ─────► discarded                           │
                  ▼                                          │
   try logged: parent, change, Δ, interval, decision         │
   loop again until the cap, the rounds, or a stall          │
                  ▼                                          ▼
                       loop --final: fresh trials of the
                       incumbent vs the start, on the holdout
```

- **The split.** The dataset's last 10 cases in the seeded order are held out, named by id in
  `awf-lab.json` before the first proposal. `run`, `score`, `report`, `show` and `check` refuse
  them outside `loop --final`, and the proposer's bundle never holds them. The other 23 cases tune.
- **The proposer** is a workflow `awf-lab` ships and runs through `awf run`, like its scorer. One
  codex agent, in an srt sandbox, reads a bundle folder and writes a candidate folder. It sees the
  incumbent's source, per tuning case and trial the metrics and the scorer's `missed` text (what the
  review missed and why), the history of tries, the comparison's rules, the spend left and a
  `program.md` the operator wrote.
- **A candidate** is one file, `workflow.ts`, that imports only the author surface and typebox and
  returns the review findings shape, plus `hypothesis.json`: what changed, why, the predicted
  effect, and the mechanism the records must show. `awf-lab` writes the variant file around it.
- **Generated code runs in a container.** Story 010 sandboxes the agents, but the workflow's own
  code runs on the host and could read the key. A trial of a loop candidate runs `awf run` whole in
  a container from the docker provider's default image, with only the checkout and the request
  mounted ([`evaluation.md`](../design/evaluation.md) option B, "the only option that survives
  autoresearch writing workflows"). The incumbent's trials run the same way, so the two are
  compared on the same footing.
- **The network stays open** in a contained trial (user, 2026-09-30). A real reviewer has the
  internet, so a closed one would measure a different job. The key is not in the container, and the
  reviewed project's GitLab is private with no token inside, so the answer cannot be read back; what the network still allows is
  generated code sending the copied codex credential out. Closing that, a proxy to the model
  domains as the docker provider's, waits on [`workflow-in-sandbox`](todo/workflow-in-sandbox.md):
  the engine, not the lab, owns the sandbox package (boundary 5).
- **Keep or discard** is story 011's verdict, unchanged: `better` keeps, anything else with `stop`
  discards. The log keeps the reason.
- **Spend** is summed from the loop's trial and score records' `run.estimate`, and each try's
  `run --baseline` gets what is left as its budget. Unpriced runs are counted as the mean of their
  kind, never as zero.

## Scope

In scope:

- The holdout: named in `awf-lab.json`, refused outside the final check.
- Running a trial whole in a container, for loop candidates and their incumbent.
- The proposer workflow, its bundle (tuning cases only), the candidate's scope check.
- `awf-lab loop`: tries, the log, keep or discard, the loop-wide cap, stopping.
- `awf-lab loop --final`: the incumbent against the start, on the holdout, on fresh trials.
- A first live loop on air-1, codex everywhere, within the night's $40 (experiments included).

Out of scope:

- A generic case side; the loop stays review-specific until
  [`second-case-kind`](todo/second-case-kind.md) (user, 2026-09-30: loop first).
- Growing the dataset to ~40 + 20 ([`key-growth-from-runs`](todo/key-growth-from-runs.md)). With
  10 held-out cases × 2 trials the final check resolves ~0.2: it catches a collapse, not a small
  overfit. Accepted for now (user, 2026-09-30).
- Acceptance that tightens over rounds, a Pareto front for parents, the stall round that sorts
  failures by root cause, the model × effort staircase, and "same quality, cheaper" as a keep
  ([`comparison-efficiency`](todo/comparison-efficiency.md)). Each goes to todo.
- The thin agent skill that drives `check`, `run` and `report`.
- Pane agents in a contained trial: headless only.

## Context and evidence

- Fact: `run X --baseline Y` is `runAgainst` in `packages/lab/src/review/lab/against.ts`. It runs
  the next case of the seeded order for both variants until the verdict's `stop`, the budget (exit
  3) or a case that cannot be made whole. Read the verdict with `report --json`.
- Fact: `Verdict` is `{ verdict, stop, reason, metrics }` (`packages/lab/src/compare/types.ts`);
  `default` 1.1.0 stops `undecided` at a look when 0.05 is out of reach. Simulated: no true
  difference → "better" 2.1%, true +0.10 → 99%
  ([story 011](011-compare-variants.md)).
- Fact: variance on air-1 is sd 0.19 between cases and 0.13 between trials. A try against the
  stored codex baseline costs ~$1.6 a case at 2 trials ($0.45 review + $0.36 score a trial), ~$13
  at look 8 and ~$26 at 16, and 1–4 h.
- Fact: the scorer writes `judgement.missed`, "What the review missed, and why: feedback"
  (`packages/lab/src/review/format/scoring.ts`). It is the GEPA signal the todo asks for.
- Fact: `tunedOn` is reported, never enforced (`report.ts` `tuned()`). Nothing refuses a case.
- Fact: the docker provider's default image (`packages/sandbox/docker/Dockerfile`) holds bun, git
  and codex. Option B needs no engine change.
- Constraint: `lab` imports contract only and runs workflows through `awf run` (boundary 5).
- Constraint: no person approves anything in the loop (memory: no human in autoresearch).
- Constraint: experiments run codex, never claude.
- Fact (E-a): `awf run` and a headless codex agent run inside the default image with the awf
  checkout mounted; see Implementation notes.
- Assumption: the `missed` text is specific enough to steer a proposer. Experiment E-b tests it.

## Code map

### packages/lab

- `src/review/lab/against.ts` — `runAgainst`: the loop's inner step, reused as is with the budget
  it is handed.
- `src/review/lab/selection.ts` — `selectCases`; `cli.ts` — `rankOf`: where the holdout is
  removed from every selection.
- `src/review/format/workspace.ts` — `WorkspaceConfigSchema`: gains `holdout`, and a `container`
  sandbox kind.
- `src/review/lab/execute.ts` — `executePlan`, the `sandbox.json` it writes and the `awf run` it
  starts (`runner.ts`): a contained trial is started here instead.
- `src/review/format/records.ts` — the trial record's `sandbox`: records a container trial apart.
- `src/review/format/variant.ts` — `defineReviewVariant`: the variant `awf-lab` writes around a
  candidate.
- New: `src/review/lab/loop/` — the bundle, `propose.workflow.ts`, the scope check, the records,
  `runLoop`; inside `lab/`, whose CLI calls it and whose modules it builds on.

### packages/sandbox

- `docker/Dockerfile` and `src/docker/` — the image and the proxy a contained trial reuses. Checked:
  no provider change is planned; whether the image needs awf in it is E-a's answer.

### docs

- `docs/design/evaluation.md` — option B moves from "later" to built.
- `docs/status.md`, `docs/stories/README.md` — the story's state.

## Proposed design

### Records and config (the expensive part)

- `awf-lab.json`: `"holdout": { "{dataset}": { "cases": ["{id}", …], "chosen": "2026-09-30" } }`.
  By dataset, since `--dataset` picks another. Ids, not "the last n": a grown dataset or a new seed
  must not move a case across the split. A held-out id the dataset lacks fails every command on
  that dataset until the config is fixed.
- `awf-lab.json`: `"sandbox": { "container": { "image"?: string } }`, a third kind beside `srt` and
  `docker`. A trial's record says which it ran in, so contained and uncontained trials never pair.
- A loop lives at `{results}/{dataset}/loops/{loop}/`:
  - `loop.json` (`awf.lab-loop/1`): the start variant, the comparison and its version, the holdout
    digest, the cap, `program.md`'s digest, started at;
  - `tries/{n}/`: `workflow.ts`, `hypothesis.json`, the bundle it was given, and `try.json`
    (`awf.lab-try/1`): parent, variant key, change, decision (`kept`, `discarded`, `refused`,
    `failed`), the verdict copied whole, spend.
  - Records are written once. The tree is read back from the tries' parents.
- A candidate's variant is `{loop}-{n}` at `1.0.0`; every try is its own series.

### The proposer

`packages/lab/src/review/lab/loop/propose.workflow.ts`, run by `awf run` with the bundle folder read
only and the candidate folder writable, one codex agent (`gpt-6-sol` by default, set by
`--proposer`). Its prompt is short; `program.md` carries the steering. Its answer is
`hypothesis.json`'s schema through `wf result`.

### The scope check

Before any spend: the candidate is one file; it imports only `agentswf/workflow`, `typebox` and
`@agentswf/contract/workflow`; it typechecks against the author surface and its result has the
findings shape; it holds no string from the tuning cases' keys or diffs longer than 40 characters
(the no-paste guard). A failed check is a `refused` try, logged with why, and costs only the
proposer.

### The loop

`awf-lab loop {name} [--rounds n] [--budget usd] [--proposer harness/model]`: resume from
`loop.json` if it exists, else start one from the workspace's `baseline`. Each round: bundle,
propose, check, `runAgainst(candidate, incumbent, budget = cap − spent)`, log, keep or discard.
Stop at the rounds, the cap, or three tries in a row without `better` (the stall; the root-cause
round is out of scope). Exit codes as `run`'s: 3 for the cap.

`awf-lab loop {name} --final`: runs the incumbent and the start on the holdout with fresh trials
and reports the comparison. It is the only command that may select holdout cases, and it records
that it ran, so a second final check is visible.

Alternatives rejected:

- A Claude Code session following a skill as the proposer — the cap and the scope would be
  convention, and it spends claude usage.
- A proposer limited to a prompt file and argv, no code — safer and simpler, but the user chose
  workflow code (2026-09-30); it is a scope file away if code proves unsafe.
- Generated workflows on the host under srt (option D) — srt cannot nest, and the workflow's code
  would still see the operator's files.
- A scalar objective — story 011's lexicographic rule stands.

## Tasks at a glance

- [x] 1. The holdout is named in `awf-lab.json` and refused outside the final check
- [x] 2. A trial runs whole in a container, the key absent
- [x] 3. The proposer writes a checked candidate from a tuning-only bundle
- [x] 4. `awf-lab loop` keeps or discards, logs the tree and stops at the cap
- [x] 5. `loop --final` checks the incumbent on the holdout
- [ ] 6. The first live loop on air-1

## Open questions

### 2. A trial runs whole in a container

- The stored codex baseline ran under srt. Under the rule that trials in other sandboxes do not
  pair, the first try reruns the baseline in the container too: about double the first try's cost
  (~$13 more at look 8). The alternative, pairing srt and container trials as one setting, saves it
  but mixes environments. Recommendation: rerun; it is a one-off.

### 6. The first live loop

- The night's $40 holds the experiments (~$15) and one try with a contained baseline. A second try
  needs more.

## Task execution rule

Process one task at a time. Every task repeats the checklist shown under its details. Do not begin
the next task because the current implementation merely compiles: its design must be recorded, its
diff reviewed by subagents, findings resolved, and focused verification complete.

After all tasks are complete, run story-level verification and request human review of the complete
deliverable.

## Task details

### 1. The holdout is named in `awf-lab.json` and refused outside the final check

Outcome: a case named in `holdout` cannot be run, scored, reported, shown or checked except by
`loop --final`.

Execution:

- [x] Plan: the split lives in `datasetCases` (`review/lab/execute.ts`), the one reader of a
  dataset: it returns the tuning cases as `entries` and the held-out ids as `held`, and fails a
  holdout naming a case the dataset lacks or leaving none. `readCases` refuses a held-out id
  unless asked with `{ heldOut: true }`, the door task 5 uses. `selectedCases` and `show` turn a
  named held-out case into a usage error (exit 2).
- [x] Implement
- [x] Review
- [x] Resolve
- [x] Verify: `bun test tests/review-lab.test.ts packages/lab` 166 pass; `bun run check` clean.

Work:

- `holdout` in `WorkspaceConfigSchema` and its JSON schema; every selection drops it before the
  seeded order; an explicit id or `--only` naming one is refused, saying why.
- air-1's split written in the data repository: the last 10 of the seeded order.

Done when:

- Tests show each command refusing a held-out case and `--cases n` taking n tuning cases; the
  stored 16 baseline cases are all tuning.

### 2. A trial runs whole in a container, the key absent

Outcome: with `"sandbox": { "container": { "image" } }`, each trial's `awf run` runs inside the
image, and its records come back out.

Execution:

- [x] Plan: from E-a, below.
- [x] Implement
- [x] Review
- [x] Resolve
- [x] Verify: `bun test` 986 pass; `bun run check` clean. Live, from the data repository with a
  second config naming `{ "container": { "image": "awf-agent:8ea26352e621" } }` and results in a
  scratch folder (2026-09-30):
  - a canary variant with no agent, probing the dataset, results, runs, `awf-lab.json`, awf's
    `.env`, `~/.codex/sessions`, `~/.codex/auth.json` and `~/.claude` by host path: none readable;
    its home was the trial's fresh one;
  - `one-codex-r1` on air-2119: succeeded, 3 findings, should-fix 1/2, precision 1.00, 4 min,
    $0.25, scored $0.20; no container left behind.

Work:

- The engine checks a harness's subscription login when its first agent opens, not at start, so
  a codex-only run needs no claude login.
- `"sandbox": { "container": { "image"? } }`: `awf-lab` starts `docker run` on the default image
  instead of `awf run --sandbox`, with `--cap-drop ALL`, `no-new-privileges` and the operator's
  uid; mounts: awf's `packages/` and `node_modules` read-only (never the repository root), the
  variant's directory read-only, the restored checkout, the request read-only, and a fresh home
  per trial seeded with codex's `auth.json` only; the network through the docker provider's proxy,
  allowing the model domains; `output.json` read from stdout as now.
- The trial record names the container sandbox, so its trials pair only with each other.
- A canary test: a workflow that tries to read the dataset and the host's agent sessions fails.

Done when:

- One live trial of `one-codex-r1` runs contained and scores; the canary passes.

### 3. The proposer writes a checked candidate from a tuning-only bundle

Outcome: given a loop and an incumbent, `awf-lab` builds the bundle, runs the proposer, and returns
a candidate that passed the scope check or a refusal saying why.

Execution:

- [ ] Plan
- [ ] Implement
- [ ] Review
- [ ] Resolve
- [ ] Verify

Work:

- The bundle from stored records, tuning cases only; `propose.workflow.ts` with a workflow test
  beside it (story 012); the scope check.

Done when:

- Tests show no held-out id or feedback in a bundle, and the scope check refusing each rule's
  breach; one live proposal passes it.

### 4. `awf-lab loop` keeps or discards, logs the tree and stops at the cap

Outcome: `awf-lab loop {name}` runs tries until the rounds, the cap or a stall, and resumes.

Execution:

- [ ] Plan
- [ ] Implement
- [ ] Review
- [ ] Resolve
- [ ] Verify

Work:

- `loop.json` and `try.json` formats with schemas; the cap from records; keep or discard from the
  verdict; `list loops`, and `show` of a loop's tree.

Done when:

- With scripted proposer and runner, tests show keep on `better`, discard otherwise, refusal
  logged, the cap stopping a try, and a resumed loop continuing its tree.

### 5. `loop --final` checks the incumbent on the holdout

Outcome: the incumbent and the start run fresh on the holdout and the comparison is reported, once
and visibly.

Execution:

- [ ] Plan
- [ ] Implement
- [ ] Review
- [ ] Resolve
- [ ] Verify

Done when:

- Tests show `--final` the only path to held-out cases and its run recorded in the loop.

### 6. The first live loop on air-1

Outcome: a loop has run at least one try live, within the cap, and its log reads back.

Done when:

- The try's record, cost and verdict are in Implementation notes.

## Verification

Automated:

- [ ] The tests named under each task
- [ ] `bun test`
- [ ] `bun run check`

Manual or live evaluation:

- [ ] E-a and E-b (below), then task 2's contained trial and task 6's loop; codex only; the night's
  cap $40 at list price.

## Review record

### Task 1

- Architecture and scope (read the diff and every case reader in `review/lab/`): no leak through
  the existing commands. Important: the split was a convention in `selectedCases`, and
  `datasetCases` and `readCases` stayed open to task 3's bundle and task 5's `--final`. Fixed:
  `datasetCases` returns the tuning cases and the held-out ids, and `readCases` refuses a held-out
  id unless asked with `{ heldOut: true }`. Minor: `list datasets` counted every case; it now
  counts tuning cases and says how many are held out. The story's design showed the unkeyed shape;
  fixed. `scoresBy` still reads held-out runs' estimates for cost history: harmless, noted.
- Correctness and proof (edge cases in `--cases`, `--only`, `--dataset`, `run --baseline`'s
  planned count, `check --rescore`): logic sound. A holdout of every case left nothing to tune on
  silently; now refused. The test proved too little: it now covers `run`, `score`, `report` and
  `show` refusals by id, comma list and trial address, nothing run after them, an unfiltered
  `report` and `list cases` without the case, `list datasets`' counts, a positive `show`, and both
  broken holdouts.

### Task 5

- One reviewer covered both architecture and correctness: the diff is small (a deviation from
  two). `--final` is the only caller of `readCases(…, { heldOut: true })`; it compares the last
  kept candidate with the start, planned over the holdout. Fixed: "fresh" was a comment, so the
  check now counts the held-out trials already on file, records them as `reused` in
  `finals/{k}.json` and says so; `--final` requires `--budget`, as it spends outside the loop's
  cap; it refuses a loop's other flags. Left: two final checks at once could race for the same
  number; nothing runs them that way.

### Tasks 3 and 4, reviewed together as one diff

- Architecture and scope: the candidate is never imported on the host (its settings are the
  start's, its file the workflow `awf run` runs in the container), and only `candidate/` is
  mounted, never `bundle/`: sound. Important: the start's file could change under a resumed loop;
  `loop.json` now holds its digest and a resume refuses a changed one. The scope check lacked the
  story's no-paste guard on key text: added (40 characters of a tuning key's mechanism, any case);
  the typecheck and the result-shape check are left to the candidate's first trial, which fails
  cheaply and is recorded as `failed`. `unfinished` joins the decisions: the cap can end a try
  before a verdict. Deferred: `list loops` and `show` of a loop's tree, and the allowed models
  living in the CLI rather than the loop's records.
- Correctness and proof: high: a try cut short and redone reused `{loop}-{n}@1.0`, so its earlier
  code's trials could count for new code; a candidate is now named by its code,
  `{loop}-{n}-{digest}@1.0`. An unpriced proposer counted as free; it now counts as the earlier
  proposers' mean, logged. A resume trusted the command line; trials, scorer, comparison, proposer
  and the start's digest must now match `loop.json`. The scope regexes matched prompt prose
  ("check the process."); they now read code with strings and comments blanked. A failed try took
  the first error of either variant; now the candidate's. Tests cover keep, refuse, failed,
  unfinished at the cap, resume with fixed settings, the holdout's absence from the bundle, and
  the scope rules; not the stall rule or a proposer that fails.

### Task 2

- Architecture and scope (the diff, the docker provider, option B): `RunRequest.contained` on the
  lab's runner is acceptable while the lab owns `docker run`; the clean seam is the engine's
  (`workflow-in-sandbox`), which would also close the network. Network: open by the user's choice,
  documented here, in status' known gaps and in the todo. `container` in the lab's sandbox setting
  keeps pairing right; `image` is required, as the lab cannot find the provider's default.
  Mounts: the variant's folder holds sibling variants, not secret; a folder holding the workspace's
  data is now refused. `examples` stays mounted: data-repository variants import from it. The
  copied `auth.json` can rotate apart from the host's: noted, as story 004's X13.
- Correctness and proof: a login refused at the first agent became a stored failed trial, where
  `plan.ts` promises "never started"; fixed in `summaryOf` (no agent opened and the login
  refusal) with a test. A missing codex login was silent; it now fails before the run, tested,
  and the test no longer copies the operator's own login. The container had no name: `--name`
  (the trial's scratch folder) and `--init`. The run-folder move could mask the run's error; it no
  longer throws. The uid no longer falls back to 1000. Not done: a kill path on a lab abort (awf's
  `--timeout` runs inside; a stray container is found by name); the real-container canary is the
  live check below.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [ ] Evidence and research support the proposed design. (E-a, E-b running)
- [ ] Expensive interface, record-format, and stage-gate decisions are settled. (the open question
  under task 2)
- [x] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

### Decisions at refinement (user, 2026-09-30)

- Holdout: split air-1 23/10 now, the last 10 of the seeded order; growing the key comes later.
- The proposer may write workflow code; so trials run contained (option B).
- Loop before `second-case-kind`; the case side stays review's.
- Tonight's cap: $40 list price, experiments included.

### Experiments

- E-a, a trial whole in the default image (2026-09-30): it works with no engine change beyond
  one. `awf-agent:8ea26352e621` (already built) ran `single-agent-review` on air-2092 with codex in
  2:09, 4 must-fix findings, ~$0.32 list price, in line with the stored baseline (4–5 findings,
  ~2 min, $0.30–0.38). Mounted: the awf checkout read-only, the restored checkout, the request, and
  a fresh home holding only codex's `auth.json`. Inside, the dataset, the key, the host's
  `~/.codex/sessions`, `/Users` and `/private/tmp` were absent. Overhead: ~1.5 s container start,
  ~3 s restore. macOS-installed `node_modules` run on linux arm64 (no native modules). Spend
  ~$0.33. What it found:
  - The engine demands a claude login at start even for a codex-only run
    (`assertSubscriptionAuthentication`, `engine/src/operator-runtime.ts`). Passing the claude token
    in would hand it to generated code; task 2 checks each harness's login when its first agent
    opens instead.
  - Mounting the whole checkout exposes `.env` (the OpenRouter key, a claude token): mount the
    packages, not the repository root.
  - A reused home kept an earlier session: one fresh home per trial.
  - The network is open: the provider's proxy and `{id}-net` network limit it to the model domains.
  - `output.json` comes back on `--json`'s stdout, as `awf-lab` reads it today.
- E-b, one proposer round by hand from the `missed` feedback, against `one-codex-r1` with
  `--budget 15`: running.

### Screening AIR's own review (2026-10-01)

The user named the real baseline: an agent with the reviewed repository's `air-code-review`
skill, which every case's checkout already holds. Three hand-written shapes were screened on the
first tuning cases in the data repository: `air-lenses` (three agents, one lens each) reached
weighted recall 0.41 against `air-skill`'s 0.20 over 8 cases, +0.24 [+0.09, +0.40], 7 won and
none lost, no wrong claims, at 2.8× the cost; `default` 1.1.0 says undecided at look 8. The skill
alone matched a bare agent. Report: `reports/2026-10-01-air-review-screen.md` in the data
repository.

### The first live loop (task 6, 2026-10-01)

Decided with the user: start from AIR's own review, not `air-lenses`, since a gain of about
+0.24 is known to exist there and the try tests whether the loop finds one itself; 1 trial a case;
$25 in all, the start's own trials included. Every agent moved to codex `gpt-6.1-sol` (cached
input $0.10, half of `gpt-6-sol`'s; about 16% off a review), which needed codex 0.159.3 in the
agent image: 0.157.1 refuses the model on a ChatGPT login. The scorer stays on `gpt-6-sol`, so
earlier scores still count.

The start is a new variant, `air-single`: `air/workflow.ts`'s single shape with the other shapes
cut out. Starting from the three-shape file would hand the proposer the lenses code to switch on.
The program now names it and tells the proposer to import `agentswf/workflow`: the start imports
`@agentswf/contract/workflow`, which the host needs and the scope check refuses.

The start's first run, 8 cases in the container, showed three problems, each fixed before the loop:

- The container's fresh home held codex's login and no config, so codex ran `gpt-6.1-sol` at its
  own default effort, `low` (6-sol's is `medium`): 0 findings on 3 of 8 cases. A contained home now
  carries the host's top-level `model_reasoning_effort`, so a contained trial matches a host one.
  awf has no per-agent effort yet; that belongs in the runtime, a contract change for later.
- One trial failed with `agent cleanup exceeded 5000ms shutdown grace`: the review had answered,
  and awf failed the run as its codex agent shut down slowly. Counted as a review that found
  nothing, it would bias any comparison, so the lab now treats it as a run that never started:
  run again, its spend counted.
- The scorer needs `OPENROUTER_API_KEY` for Jev; the run's shell lacked it. awf's `.env` has it.

`air-single` moved to 1.1 for the effort, so its low-effort trials don't count.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [ ] Record the human's explicit approval or requested changes here.
- [ ] If changes are requested, return to the affected task and repeat its review and verification.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
