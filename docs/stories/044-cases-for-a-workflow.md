---
id: "044"
title: "Run a workflow on cases you wrote, with its services faked, and get a score"
summary: "A person writes cases (an input and what a good result looks like); awf-lab runs the workflow with outside services faked, grades each result, and exits non-zero on a regression. The same cases run on other code or parameters side by side, the person's labels keep the graders honest, and an agent loop can change a workflow, keep what is better and check it on a holdout, for any workflow."
type: story
status: in-progress
epic: loop
discovered_in: "a conversation about evals built from runs, 2026-11-09"
depends_on: ["008", "010", "011", "013"]
---

# Run a workflow on cases you wrote, with its services faked, and get a score

**How to read this.** "Where it stands" says what is built and what is left. Outcome and How it
works say what the toolset is for. "What is left" is the design still to build, task by task. The
rules of what is built are in the lab's reference, [`packages/lab/docs/cases.md`](../../packages/lab/docs/cases.md);
this story no longer repeats them. [[workflow-cases]] is the earlier thinking.

## Where it stands

2026-11-17, on branch `workflow-cases`, not merged.

| | |
| --- | --- |
| **Built** | cases, `env.ts` with strict mocks and `fetch` routes, given stages and `until`; `run`, `report`, `score`, `capture`, `case new`, `runs`; `expect`, code graders, grader workflows, the criteria judge; verdicts, history, exit codes; `--against`; time per stage |
| **Next** | task 9: parameters and columns, one store per project, trial reuse, the person's labels, tags and rates with intervals, `compare`, the judge as a parameter |
| **Then** | task 10, the `"lab"` box; 11, the review datasets on cases; 12, the loop; 13, the review kind retired |
| **Waiting on the person** | task 1, hand-judging ten mail cases (now: labels, after task 9); task 5's web-to-cli dataset (Q15) |

Tried live: the mail dataset (21 trials, all 7 cases passed, 36 criteria judged), the same against
a worktree with a worse prompt (the other column failed 2 of 3), and refund-desk with a grader
workflow, `score` and `capture`.

## Outcome

Today, when a workflow gets something wrong, you fix the prompt, run it again on whatever is at
hand, and hope. Nothing remembers the email it misjudged last week, and nothing tells you that
your fix broke one it used to get right.

This story gives a workflow's author three loops, each on the one before:

1. **Regressions.** You write cases: an input and a key saying what a good result looks like,
   often starting from a run that went wrong. `awf-lab run` runs the workflow as it ships, with its
   services faked per case, several trials each, and grades every result. A case that must pass
   and fails exits non-zero, in CI or at the keyboard.
2. **Comparisons.** The same cases on other code (`--against` a worktree) or other settings
   (`--vary model=a,b`), side by side in one run, with rates you can trust and, when the dataset
   says what "better" means, a verdict.
3. **Improvement.** An agent changes a copy of the workflow, the lab compares it with the current
   best, keeps it only when better, and checks the winner once on cases it never tuned on. The
   review lab does this today for review workflows alone; it moves onto cases, for any workflow.

Throughout, the person stays the ground truth: their labels say how often the graders agree with
them, so a judge that drifts shows.

It is built against two workflows that pull in opposite directions: a mail triage
(`school-mail` in `mini-workflows`: seconds and cents a trial, nothing real touched) and
web-to-cli's build (half an hour and dollars a trial, a live site), then autoresearch's review
datasets.

## How it works

```text
evals/mail/cases/trip-form/            one case: input files and key.md
evals/mail/env.ts                       the case's world: mocks, routes, the clock; what to read off
        │
awf-lab run ──▶ for each case × column × trial:
        │         build the case folder (never the key) and a scratch folder
        │         {folder}'s own awf run env.ts        ─▶ result + facts
        │         check agents' reach, search for the key's marker
        │         grade: expect → code graders → grader workflows, the judge
        ▼
report: a verdict per case (passed, failed, flaky, unclear), history, columns, cost; an exit code
```

- **A case** is a folder: the input (files, `input.json`) and `key.md`, with `expect` (exact
  facts code checks) and `must` / `must-not` (sentences a judge decides).
- **`env.ts`**, one per dataset, sets up each case's world as a unit test's setup does, with
  `bun:test` mocks: a fake inbox, `fetch` routes for a site, the case's day. The workflow runs
  unchanged. `observe` returns flat facts; the key is the assertion, so a key edit needs no code.
- **Graders** turn a result into a verdict, numbers and parts. Two are built in (`expect`, the
  criteria judge); a dataset adds its own as code or as a workflow. `score` grades kept trials
  again when a key or grader changes, without running the workflow.
- **Every trial is fresh**: its own process, its own folders, deleted after. Agents' reach is
  checked against `dataset.json` after every trial; a leaked key marks the trial leaked.
- **Nondeterminism is expected**: several trials a case, a flaky verdict apart from failed, and
  history beside each case.

The commands, the file formats and every rule: [`packages/lab/docs/cases.md`](../../packages/lab/docs/cases.md).

## Scope

In scope: everything under "What is left", and what is built (the reference). Out of scope:

- Any change to `engine` or `contract`. Given stages and `until` are the lab's own `wf`.
- Faking what agents' own commands reach inside a sandbox (Q9); their reach is checked instead.
- An engine-enforced ceiling on a workflow's own sandboxes; under `"lab"` the box replaces them.
- Converting the review kind's stored runs; fixtures and keys are converted.
- The lab making a checkout or installing dependencies for `--against`.
- Faking an agent's answer inside a stage: a recorded answer goes stale. A whole stage can be given.
- Workflows with events; keys kept outside the repository.
- What comes after (see "Toward the best toolset").

## Context and evidence

- Practice (Anthropic's "Demystifying evals for AI agents" and its statistics paper, OpenAI's
  eval best practices, promptfoo, Braintrust, LangSmith, Inspect, SWE-bench, Hamel Husain's
  evals FAQ) tells two modes apart: a **regression suite** of cases that should pass nearly
  always, gating on a fixed bar and rerunning only failures; and a **capability experiment** of
  cases expected to fail at first, needing several trials, paired comparisons and error bars.
  All grade the outcome, not the path, use a fresh environment per trial, run cheap graders
  first, read transcripts, and check LLM judges against people.
- At 95% per trial, 12 cases at three trials pass "every trial" together about 16% of the time
  (0.95^36), hence the flaky verdict.
- Three voters on one model and prompt are correlated; requiring all three to agree makes most
  runs unclear, hence a majority.
- The judge cost about 60 times the mail workflow it judged (task 3: $3.53 of grading for $0.06
  of trials), three Sonnet voters per criterion.
- Constraints: the lab runs workflows only through `awf run` (boundary 5); a sandbox may not be
  granted a path in `~/.awf`; a sandbox lets an agent read the git history of the repository it
  works in.

## Code map

- `packages/lab/src/cases/`: `format/` (pure: settings, keys, records), `env/`
  (`@agentswf/lab/cases`, run in the project's process), `lab/` (the lab's side), `judge/` (the
  criteria judge). `packages/lab/AGENTS.md` lists the files allowed I/O.
- `packages/lab/src/review/`: the review kind, until task 13. `src/compare/` (domain-free
  comparison rules) moves into `src/shared/` with task 9.
- `scripts/check-boundaries.ts`: `cases/` never imports `review/`, names no domain word, and keeps
  `format/` pure.
- Outside: `examples/refund-desk/evals/`; the mail project's `evals/` (`mini-workflows`, branch
  `evals`); autoresearch's `evals/air-1/graders/match.ts` (branch `workflow-cases`).

## What is left

### Task 9: parameters, reuse, labels, rates, `compare`

**Parameters and columns** (Q13). `--param k=v` sets a parameter for the run; `--vary k=a,b`,
repeatable, runs every combination. A column is then a folder of code plus a set of parameters,
labelled by its values; `--against` and `--vary` are two ways to add columns. `env.ts` reads them
as `c.params` (from `AWF_LAB_PARAMS`) and turns them into argv or picks a module; graders get them
too. The **reference column** is your checkout with `--param` and each `--vary`'s first value:
`--failed`, history, the exit code and `compare` read against it.

**One store per project, and records** (Q12). The store becomes `~/.awf/lab/{name}-{id}/`, found
by the repository's first commit, so every worktree and loop copy shares it. With `records` set
in `awf-lab.json`, run, trial, score and label records, with each trial's built case and
`kept/` files, go to that folder inside `evals/`, to be committed, so a fresh clone can reuse and
grade again; the workflows' own run records (the agents' logs) stay in the store, since a
grader's can hold a key. Run
ids become unique across machines. The records folder is kept from agents as `evals/` is.

**Reuse** (Q11). A stored trial is reused, within `reuseDays` (14), when what shaped it is
unchanged: the code (a digest of what git would hold, less records, `hide`, and each dataset's
cases, keys and grading code), the parameters, the case's input, `env.ts`, the trial settings in
`dataset.json`, and the `awf` and lab versions. A key or grader change grades again and runs
nothing. Never an errored or leaked trial. Asking for more trials runs only the difference;
`--fresh` runs new ones. The plan and report count reused trials.

**The person's labels** (added 2026-11-17). A grade is only as good as its agreement with the
person, and that drifts as criteria, prompts and models change, so it is measured on every run.

- **`awf-lab label {run id} (--good | --needs-work "{note}" | --clear)`**: the person's verdict
  on one trial, found by its workflow run's id as `capture` finds it (`report --case` prints each
  trial's). It appends to `labels.jsonl` (the trial's id, the mark, the note, when); the newest
  label of a trial wins. The person runs it, or tells a coding agent what was wrong and it runs
  it. `capture` of a trial labels it. A queue that walks through unlabeled trials, or a web
  interface, comes later on the same record (see "Toward the best toolset").
- **Agreement**: of trials marked good, how many the lab passed; of those marked needs-work, how
  many it failed, given apart (a lab that passes everything agrees with a mostly good set). The
  same per deciding grader, the judge by agent and version. Each disagreement is listed with its
  note.
- The judge's "not checked against a person" mark clears at 10 labeled trials of the dataset that
  the current judge graded, at least 3 of them needs-work (a judge that passes everything can't
  clear it on good ones alone); the report then gives its two agreements instead. It replaces
  the fixed `JUDGE_CHECKED`. Task 1's hand-judging becomes labels on the mail dataset.
- A label is on the trial, not on each criterion; the note says why.

**Tags and rates.** A key may list `tags`, plain words in no grader's key digest; the report gives
a line per tag, and `--tags a,b` picks cases on `run` and `score`. Each column's cases passed come
with a 95% interval (Wilson; cases are the independent units); with several trials, the mean of
each case's pass fraction with an interval from the spread across cases, never from trials pooled
as if independent; and at k trials, **pass^k** (every trial passed: what a workflow that must work
every time is judged on) and **pass@k** (at least one). Between a column and the reference, the
report gives the difference on the same cases, with its own interval from the per-case
differences: two columns' intervals can overlap while the paired difference is clear. An
interval of the difference that holds 0 says no difference is shown; which is better is
`compare`'s.

**`compare`** (Q14). A dataset says what "better" means by exporting `compare` from `graders.ts`:
`better.paired({ primary, guards?, tiebreak? })`, the review loop's sequential paired rule, which
stops as soon as it can tell; `better.mean(fn, { onFailure? })`; or its own `defineComparison`.
Per trial it gets `passed`, the graders' numbers, cost and time; a trial with no numbers scores
what `onFailure` says, so a failed review can count 0 recall. It gives each column a verdict
against the reference column, a reason and `stop`, which only a loop's try obeys. It runs in the
helper process.

**Also**: `run --budget`, `--dry-run`, `--json`; `report --md` for pasting.

**The judge as a parameter**, last. The judge's agent and number of voters become parameters, under
names the lab keeps (such as `judge.model`) so they never reach `env.ts`, so `--vary`, and `score`
under it, compares judges on the same trials by agreement with labels and
by cost. Planned at that step; a structural choice goes to the person.

### Task 10: the `"lab"` box

`"sandbox": { "lab": "srt" }` or `{ "lab": "docker", "image": … }` runs the whole trial (`awf
run`, `env.ts`, the workflow and its agents) in one box, with the workflow's own sandboxes set
aside (Q10). Inside: the case and scratch folders and the code as the digest lists it plus
`node_modules`; never `.git`, a key, the records, the store, the home folder or `hide`'s paths. It
reaches `agentReach`, the model domains, `realHosts` and the engine's hosts; `"network": "any"`
for a reviewer that needs the web. Made by the provider's own command-line tool, as the review
lab's `docker run` is. The plan checks whether `awf run` works inside srt, else Docker first, and
whether parallel trials become safe. An engine change stops and goes to the person.

### Task 11: the review datasets on cases

autoresearch's fixtures convert into cases: the history written once as a shared bundle cut at
the common ancestor of every case's base, each case a thin bundle; the review `env.ts` restores
the checkout under `"lab"`; the ported grader (`match.ts`) labels each finding as a part, with
recall and precision as numbers; holdouts in `dataset.json`, which `run`, `score` and `report`
leave out; air-1's `compare`. The marker search may need limiting to commits beyond the shared
bundle (M6).

### Task 12: the loop

`awf-lab loop {name}` on any dataset under `"lab"` with a `compare`: a proposer, in the box,
writes a copy of the incumbent kept in the store; code checks nothing under `evals/` changed and
no key text was copied; the try runs case by case against the incumbent, in a seeded order,
until `compare` stops it; it is kept only when better. A spend cap (`--budget`, required), a stall
stop, resume by name, waiting while a plan window it draws on is nearly used
(`--allowance`), and `--final` checks the winner once on the holdout. The incumbent comes
back as a patch. A refund-desk dataset with room to improve proves it before air-1.

### Task 13: one kind

`review/` is deleted; `collect` and `draft-key` become autoresearch's scripts writing cases; each
retired command and flag is refused with what replaced it; the records, `grade.json` and
`awf-lab.json` become `/1`.

### What may change, and what may not

- **Costly to change**: the names that pair kept results (a case's and a dataset's folder name, a
  grader's name, a criterion's text), the dataset layout and its reserved names, the exit codes,
  and the files people write (`key.md`, `dataset.json`, `awf-lab.json`). Their next incompatible
  change makes them `/1`, with a converter.
- **Records** (run, trial, score, grade, label) are `/0` until task 13 makes them `/1`; old records are
  refused by name, with no converter (beta).
- **Unstable**: the code shapes people write against (`defineEnv`, `c`, a grader's result,
  `compare`).

## Toward the best toolset

What this story leaves for later, in the order it would pay off:

- **Error analysis on labels**: needs-work notes grouped into failure modes, which become tags and
  new cases. Today the notes are listed; grouping them is a workflow's job.
- **Cases made by agents**: a workflow that drafts variations of a case along named dimensions and
  writes draft keys for the person to finish. The lab provides `case new` and drafts; generating
  is a workflow, not a lab feature.
- **A shadow run**: another folder's workflow run beside the real one on each real input, the
  differences becoming cases. Builds on `capture`.
- **Labels per criterion**, if trial labels show the judge disagreeing in ways a note can't
  localize.
- **Faking agents' own commands** through an engine route into the sandbox (Q9).
- **A provider's stop told apart from the workflow's failure** (M3): needs a `cause` on the
  engine's attempt record, its own story.
- **A labeling queue and a web interface**: `awf-lab label` with no run id walking through
  unlabeled trials, the case's input beside the result and the lab's verdict shown after the
  person's (blind); later a web interface over the store. Both write the label record `label`
  writes, and read `--json`.

## Decisions

Settled by the owner, newest first:

- **Labels, rates with intervals, tags** (2026-11-17), after a review of the design against eval
  practice; labels are given with `awf-lab label` for now, a queue or web interface
  later on the same record. Then the judge becomes a parameter, compared on agreement and cost.
- **Reviews and the loop move onto cases on this branch** (2026-11-16): building them beside the
  design shows what it gets wrong while it can change.
- **Q10, one outer box, `"lab"`**: the whole trial in one sandbox from any provider, keys outside
  it, the workflow's own sandboxes set aside inside (srt doesn't nest on macOS). No engine change.
- **Q11, trials reused when unchanged**, within a window, keyed on separate digests so a key edit
  runs nothing.
- **Q12, one store per project, records committable**.
- **Q13, settings are plain parameters**: `--param`, `--vary`, `c.params`; no named concept.
  autoresearch's variants become parameter values.
- **Q14, "better" is code, with presets**: `compare` in `graders.ts`; without it, columns and no
  verdict.
- **The review kind's stored runs are not converted** (2026-11-16).
- **The unit of change is a folder of code** (2026-11-14), amended: a setting the workflow reads
  as a parameter is compared in one folder.
- **A case's world is set up in code, as a unit test's is** (2026-11-15), with `bun:test` mocks;
  the workflow runs as it ships.
- **Given stages and `until` through the lab's `wf`** (Q8), no engine change.
- **Agents' own commands are checked, not faked** (Q9).
- **HTTP faked by the lab's own `fetch`, no msw** (2026-11-15).
- **The judge reads the facts**; **criteria are two lists of sentences** (2026-11-15).
- **Graders are pluggable**, code or workflow, the built-in ones graders like any other; each
  declares a version (2026-11-16).
- **Run and score first; compare second** (2026-11-14).

Settled in the design: both sides of a comparison run in one run (paired); keys live beside their
cases with a marker; grade the result, not the path; only the workflow's own errors fail a case;
a mixed result is flaky; the judge decides by majority; mocks are strict and a refusal is the
dataset's to fix; one process per trial; facts, not assertions.

Rejected: comparing against a kept run of `main` (a picker, drift); fakes passed as arguments, or
a variant file per setting (reaches nothing an agent does); network fakes for agents' commands
(a sandbox starts from nothing); record and replay (agents don't repeat requests); agent-env's
gateway and MCP fakes; `--to-stage` in the engine (a new ending for what the lab's `wf` does);
`observe` asserting (stops at the first failure); every trial must pass (most runs fail); all
voters must agree (most runs unclear); the lab making checkouts; dataset code in the lab's own
process; one digest of "the code" for reuse; one table per dataset (poor for a long email);
statistical thresholds for "came out differently" at a few trials (the list is for reading; task
9's intervals and `compare` say how sure).

## Tasks at a glance

- [x] 0. The mail triage's evals written against this design
- [ ] 1. By hand: whether a judge agrees with the person (the person's; after task 9, as labels)
- [x] 2. The mail triage runs on cases, graded by `expect`, with a verdict and an exit code
- [ ] 3. Criteria are judged: built; its check against the person waits on task 1
- [x] 4. The same cases on code in another folder
- [ ] 5. web-to-cli's build runs on cases: the lab's part built; the dataset waits on Q15
- [ ] 6. A past run becomes a case: built; its live check on both workflows waits on task 5
- [x] 7. What reviews and the loop need, set against the design
- [x] 8. Grader workflows and `score`
- [ ] 9. Parameters, reuse, labels, rates and `compare`
- [ ] 10. The `"lab"` box
- [ ] 11. The review datasets on cases
- [ ] 12. The loop, for any dataset
- [ ] 13. One kind: the review kind retired, records at `/1`

Order from here: 9, 10, 11, 12, 13. Tasks 1 and 5 wait on the person; 3's last check follows
1 (the judge on its held-out third), and 6's follows 5 (a real run of each workflow captured).

## Open questions

- **Q15. web-to-cli's builds dataset** (task 5): which site and login the builds run against,
  which past requests become cases (x-cli's and linkedin-cli's `.state/runs` hold real ones,
  such as `posts:search`), and what spend is fine for its live check. A build drives a logged-in
  site through a browser, makes git worktrees and merges, and runs four kinds of agent; recorded
  builds took 8 to 132 minutes and an estimated $1 to $44.

Answered: Q1–Q9 in the design, Q10–Q14 under Decisions.

## To measure

- **M1.** Whether web-to-cli's build minds that its run's id is the lab's, not the request's. In
  task 5's plan.
- **M6.** How long the marker search takes on a restored review checkout, and whether it must skip
  the shared bundle's commits. In task 11's plan.

M2–M5 were answered in task 2: the grader interface carries the review scorer (with parts,
labels, votes and `notApplies`); a provider's stop can't be told from the run's records except a
missing login (M3, an engine story); the lab's `wf` runs another workflow's body, agents and
sandboxes included, and times its own phases since the engine's timeout sends no signal; the
folder's own bin runs a trial with the preload and no hand-over.

## Task execution rule

One task at a time, in the order above. Each goes through plan, implement, review (two
subagents: architecture and scope; correctness and proof), resolve, verify, and its notes go
under Implementation notes. Tasks 1 and 5 wait on the person and don't block the rest.

## Task details

Done tasks are in the commits and in Implementation notes; only what is open is listed.

### 1. Whether a judge agrees with the person

Outcome: a yes or no on whether prose criteria are worth keeping. The person labels trials of the
mail dataset (after task 9's labels), including bad ones made on purpose, so a judge that always
says "met" is caught.

- About ten emails and thirty criteria, three trials each. The bad results come from worktrees
  run with `--against`, each with a prompt changed to break one kind of criterion (as task 4's
  worktree dropped dates): at least fifteen trials with an unmet `must` and fifteen with a
  violated `must-not`, each labeled needs-work with the criterion in its note. A third of the
  emails set aside before any result is seen, the judge's prompt frozen before it is judged.
- **Bars**, at the trial level, on the tuned two thirds: the lab fails at least 80% of the
  needs-work trials of each kind, agrees on at least 85% of labeled trials, and fails at most 5%
  of the good ones; 2–1 splits over 10% rework the prompt. A disagreement is read by hand, to see
  whether the judge failed the trial for the noted criterion. On the held-out third: at most one
  needs-work trial of each kind passed and one good trial failed, agreement within 10 points.
- If the judge misses a bar, criteria leave the story: keys hold `expect` alone.
- The emails are real mail: they stay in the mail project's private repository.

### 3, 5, 6: what is open

- **3.** Live: on task 1's held-out part, the built judge gives the hand-run judge's verdicts,
  except where voters split.
- **5.** Once Q15 is answered: the builds `env.ts` (a `setup` that configures the CLI into the
  scratch folder and files the request, an `observe` that runs what was built), `keep` for the
  judge, a stage case from a past run's values, M1. Live: two cases against a worktree with
  another builder model, and one stage case; about two hours and twenty dollars. The build's
  sandbox is checked to keep agents out of the home folder, the store, `evals/` and the records.
- **6.** A real run of each workflow becomes a case with one command, and that case runs: needs
  task 5's dataset and a mail `capture.ts`.

### 9. Parameters, reuse, labels, rates and `compare`

Execution:

- [x] Plan: the reuse key file by file; what a fresh clone needs to grade again, and its size;
  how parameters key history and the run record's columns;
  what becomes of today's per-checkout stores; how autoresearch's variants map onto parameters.
  (Under Implementation notes, "Task 9's plan".)
- [ ] Implement, step by step, each committed with its tests:
  1. [x] parameters and columns;
  2. the store per project and `records`;
  3. reuse, `--fresh`, `reuseDays`;
  4. labels: `label`, `labels.jsonl`, agreement, the judge's mark;
  5. tags and rates: intervals, pass^k, pass@k, `--tags`;
  6. `compare`, with `src/compare` moved into `src/shared/`;
  7. `run --budget`, `--dry-run`, `--json`; `report --md`;
  8. the judge as a parameter.
- [ ] Review: architecture and scope; correctness and proof.
- [ ] Resolve: disposition every finding.
- [ ] Verify: the `Done when` items.

Done when:

- A test on scripted agents: `--vary` gives a column per combination, each trial recording its
  parameters and key; `--failed` and the exit code follow the reference column.
- A test: an unchanged run reuses every trial, a change to what shapes a trial runs new ones, a
  key edit only grades again.
- A test: two worktrees share a store; a fresh clone reuses trials from committed records.
- A test: labels give agreement for good and needs-work apart, survive reuse, follow a `score`
  that grades again, and clear the judge's mark; a newer label replaces an older, `--clear`
  removes it.
- A test: the intervals, the paired difference and pass^k match worked numbers; tags group the report and `--tags` picks
  cases; editing tags grades nothing again.
- A test: `compare` gives a column's verdict as JSON; `run` still runs every planned trial.
- Live: refund-desk's `decide` over two models with `--vary`, then again, reusing every trial; a
  few labels on the mail dataset, and two judges compared on them.

### 10. The `"lab"` box

- [ ] Plan, implement, review, resolve, verify.

Done when:

- A test: code and agents in the box can't read a key (file or git history), an ignored file, the
  records, a `hide` path, the store (but a try's copy mounted from it) or the home folder.
- A test: the box reaches only `agentReach`, the model domains, `realHosts` and the engine's
  hosts; a workflow that opens its own sandbox runs with it set aside.
- Live: refund-desk's `decide` under `"lab"`.

### 11. The review datasets on cases

- [ ] Plan (the converter and verifier, in autoresearch; the review `env.ts`; the grader's
  modules copied into autoresearch; air-1's `compare`; M6), implement, review, resolve, verify.

Done when:

- Every autoresearch dataset converts and verifies, holdout included.
- A test: no case folder holds a commit beyond its base or head, and no key's text is found in
  tracked files outside `evals/` that `hide` doesn't cover.
- A test: `run`, `score` and `report` leave holdout cases out.
- Live: a few tuning cases, two trials each, on both labs with the same grader; recall and
  precision agree within the review lab's own spread.

### 12. The loop

- [ ] Plan (story 013's loop on cases: the try's copy, the proposer in the box, the scope check,
  the bundle, the cap, the stall stop, resume), implement, review, resolve, verify.

Done when:

- A test on scripted agents: a loop keeps a better try, drops a worse one, compares each try with
  the last kept one, stops at the cap with exit 3, and never shows the proposer a holdout case.
- A test: a try that changes anything under `evals/` is refused, and generated code reaches no key.
- A test: a loop stopped mid-try resumes.
- Live: a short loop on refund-desk, then one round on air-1 under the cap the person sets.

### 13. One kind

- [ ] Plan (what is deleted, what moves to autoresearch first, the docs and site), implement,
  review, resolve, verify.

Done when:

- A test: each retired command, flag and `awf-lab.json` review field is refused with its
  replacement: `show` → `report --case`, `list` → `runs`, `--scorer` → `score --grader`,
  `--baseline` → the reference column, `--comparison` → `compare` in `graders.ts`, `--rest-from`
  → a grader's previous parts, `--categories` → the grader's numbers, `--source` → the loop's
  scope check, `--allowance` on `run` or `score` → `loop --allowance`; `check`, `--rescore`,
  `schema`, `--only`, `--where` dropped. The older renamed-name maps go with the review kind.
- `check-boundaries.ts` passes with one-kind rules; autoresearch runs on cases alone.

## Verification

- [x] A dataset runs end to end on scripted agents; two folders side by side; keys never copied,
  a leaked marker caught; `score` grades again on a changed key, version or grader.
- [ ] Parameters, reuse, labels, rates and `compare` (task 9).
- [ ] Nothing in the `"lab"` box reads a key (task 10).
- [ ] Every autoresearch dataset converts and verifies (task 11).
- [ ] A loop keeps a better try and never shows a holdout (task 12).
- [ ] One kind, records at `/1` (task 13).
- [ ] `bun test`, `bunx tsc --noEmit`, `bun run scripts/check-boundaries.ts`.

Live, still open: the builds dataset (task 5); the judge on task 1's held-out part (task 3); a
real run of each workflow captured (task 6); air-1 on both labs (task 11); the loop (task 12).

## Review record

The design went through about thirty review rounds before building (feasibility, eval method,
consistency, a first-time reader, experiments on Bun), and each task since had two subagent
reviews; every must-fix and should-fix was fixed with a test, and the open nits are under
Implementation notes. The commits on `workflow-cases` carry each task's findings.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design.
- [x] Expensive interface, record-format, and stage-gate decisions are settled.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope (Q15).

## Implementation notes

### Where building changed the design

The reference describes what is built; these are the places it differs from what was first
proposed, and why.

- **`observe`'s `result` is typed `Result`, not `Result | null`**: TypeScript can't pick a union
  member by whether an async `setup` returns `until`. Under `until` the author annotates it.
- **`defineEnv` takes no type argument and requires `agentswf/workflow` at run time**: an import
  made a project's `tsc` mix the lab's copy of `agentswf` with its own.
- **The engine's `--timeout` sends no signal**, so `defineEnv` times every phase itself and
  handles SIGTERM and `exit` for teardown (M4).
- **The lab needs `agentswf` 0.1.1 or later** in each folder, checked before the first trial.
- **A trial record holds no outcome**: it is computed from the record and the newest grades, so
  `score` never leaves it stale. History recomputes earlier verdicts with the current bars.
- **Graders declare a version** instead of being identified by a code digest, which would miss
  edits to what `graders.ts` imports.
- **Who decides is computed, not stored**: from the current `dataset.json` and key, so putting a
  grader back makes its grades decide again without grading.
- **The judge's key digest is its criteria alone**, its grade folder holds no `expect` or `key/`,
  and a grade records the judge's agent, so a new agent judges everything again. A timed-out voter
  errors the grade rather than leaving a lasting `undecided`.
- **An unreadable old record leaves its run out of history**, named by `runs` and counted in the
  report, instead of stopping every command (found live on the mail project's store).
- **An `--against` folder must have its own install**: one inside your checkout without it would
  have run your code under its name.
- **The plan's estimate counts grading**, which can dwarf the workflow's cost.
- **Given stages are not timed** in time per stage; only stages that ran.
- **`capture`**: a real run's outcome is its last attempt's; prose facts over 60 characters are
  drafted commented; each case is built whole and moved into place.

Open nits: `capture` looks for real runs in your checkout and the repository's top only, not in a
`.awf` higher up; a budget stop exits 1 or 5 when the report already exits worse.

### Task 9's plan

- **Columns**: the run record keeps `folders` and gains `columns`, each `{ folder, params }`, the
  folders outermost, so column 0 is the reference; a trial's `column` indexes `columns` and the
  trial records its `params`. A column is named by its folder (`against 1`) and the parameters
  that differ between columns (`model=b`).
- **History and `--failed`** read, in each earlier run, the column of your checkout under the
  reference column's parameters, wherever it sits; a run with no such column adds nothing.
- **Parameters** are strings, named a letter then letters, digits, `-` or `_`; a dot is kept for
  the lab's own (step 8's judge). `--vary` needs two values or more.
- **autoresearch's variants** are named combinations of a workflow, `--shape` and `--runtime`,
  not a grid: one parameter, `--vary variant=…`, whose value `env.ts` looks up in its own table.
  The lab needs no feature for it.
- **Today's per-checkout stores** are left where they are and not read once step 2 moves to one
  store per project (beta); their records also lack `columns`, so they read as unreadable runs.
- **The reuse key** (step 3): the code is what git would hold in the folder, less the records
  folder, `hide`'s paths and each dataset's cases, keys, `dataset.json`, graders and
  `capture.ts`; `env.ts` and its helpers stay in it. Beside it: the parameters, the built case's
  digest, the trial settings of `dataset.json`, and the `awf` and lab versions.
- **A fresh clone** needs each trial's record, scores and `kept/` committed; the built case is
  not committed but built again from the case folder and checked against the trial's `input`
  digest, so a case edited since is "run it again", as `score` does now. The size is measured on
  the mail and refund-desk records at step 2.

### Live checks

- Mail, `expect` only (task 2): 21 trials, median 9 s and an estimated $0.003 a trial; a known
  miss failed, was settled with the person as a wrong key, and the fixed run passed 7 of 7.
- Mail with the judge (task 3): 21 trials, every case passed, 36 criteria judged, none split;
  grading $3.53 against the trials' $0.06.
- `--against` (task 4): a worktree whose prompt drops dates failed `newsletter` and `trip-form`;
  your checkout passed all three; exit 0.
- refund-desk (tasks 3, 6, 8): a code grader, a tone grader workflow graded again by `score` after
  a minor bump, and a captured trial finished and run (time per stage `decide 6.2s`).
- Environment: `srt` is installed under Node 22.20.0 only while mise selects Node 24; live runs
  put Node 22's bin first on `PATH`.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, decisions, review
  findings and dispositions, verification results, deviations and remaining risks.
- [ ] Record the human's approval or requested changes here.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
