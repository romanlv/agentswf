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
works say what the toolset is for. "The design of tasks 9 to 13, as planned" is how they were
designed before they were built; where it and `cases.md` differ, `cases.md` is what runs. The
rules of what is built are in the lab's reference, [`packages/lab/docs/cases.md`](../../packages/lab/docs/cases.md);
this story no longer repeats them. [[workflow-cases]] is the earlier thinking.

## Where it stands

2026-11-18, on branch `workflow-cases`, not merged.

| | |
| --- | --- |
| **Built** | tasks 9 to 13: parameters and columns, one store per project, run ids, records, reuse, labels, tags and rates, `compare`, judges compared; the lab's box; air-1 on cases, `hide`; the loop; one kind, records at `/1`. Before them: cases, `env.ts` with strict mocks and `fetch` routes, given stages and `until`; `run`, `report`, `score`, `capture`, `case new`, `runs`; `expect`, code graders, grader workflows, the criteria judge; verdicts, history, exit codes; `--against`; time per stage |
| **Next** | tasks 1 and 5, both the person's; then 3's and 6's live checks |
| **Waiting on the person** | task 1, labels on the mail dataset (`awf-lab label`; the judges are ready to compare on them); task 5's web-to-cli dataset (Q15) |

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
   best, keeps it only when better, and checks the winner once on cases it never tuned on, for any
   workflow with cases.

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

In scope: everything under "The design of tasks 9 to 13, as planned", and what is built (the
reference). Out of scope:

- Any change to `engine` or `contract` but the small ones the person chose for task 10
  (`awf run --boxed`, `AWF_CONTROL_ROOT`, a start time where `ps` is forbidden). Given stages and
  `until` are the lab's own `wf`.
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
- `packages/lab/src/shared/`: the process seam, `awf-lab.json`, the plan-window wait, the checks,
  and `compare/`, the paired rule `better.paired` wraps.
- `scripts/check-boundaries.ts`: `cases/` imports only itself and `shared/`, names no domain word,
  and keeps `format/` pure.
- Outside: `examples/refund-desk/evals/`; the mail project's `evals/` (`mini-workflows`, branch
  `evals`); autoresearch's `evals/air-1/`, `lib/review/` and `scripts/collect/` (branch `main`).

## The design of tasks 9 to 13, as planned

Built since; where this and `cases.md` differ, `cases.md` is what runs.

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
unchanged: the code (a digest of what git would hold, less records and each dataset's
cases, keys and grading code), the parameters, the case's input, `env.ts`, the trial settings in
`dataset.json`, and the `awf` and lab versions. A key or grader change grades again and runs
nothing. Never an errored or leaked trial. Asking for more trials runs only the difference;
`--fresh` runs new ones. The plan and report count reused trials.

**The person's labels** (added 2026-11-17). A grade is only as good as its agreement with the
person, and that drifts as criteria, prompts and models change, so it is measured on every run.

- **`awf-lab label {run id} (--good | --needs-work "{note}" | --clear)`**: the person's verdict
  on one trial, found by its workflow run's id as `capture` finds it (`report --case` prints each
  trial's). It appends to the dataset's labels file (its workflow run id, the mark, the note, when); the newest
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
differences: two columns' intervals can overlap while the paired difference is clear. Whether
a difference is shown is a sign test on the cases that changed, since an interval from a few
cases' spread says too much; which is better is `compare`'s.

**`compare`** (Q14). A dataset says what "better" means by exporting `compare` from `graders.ts`:
`better.paired({ primary, guards?, tiebreak? })`, the review loop's sequential paired rule, which
stops as soon as it can tell; `better.mean(fn, { onFailure? })`; or its own `defineComparison`.
Per trial it gets `passed`, the graders' numbers, cost and time; a trial with no numbers scores
what `onFailure` says, so a failed review can count 0 recall. It gives each column a verdict
against the reference column, a reason and `stop`, which only a loop's try obeys. It runs in the
helper process.

**Also**: `run --budget`, `--dry-run`, `--json`; `report --md` for pasting.

**Judges compared**, last (the person chose, 2026-11-18). `awf-lab score --judge {harness}/{model}
[--voters n]` grades the kept trials' criteria with another judge too; its grades are kept with
its agent and voters, marked `beside`, and only `judgeAgent`'s decide. The report compares the
judges on the same trials, by agreement with labels and by cost. `judgeAgent` may give `voters`.

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
  and the files people write (`key.md`, `dataset.json`, `awf-lab.json`). `awf-lab.json` is `/1`
  since task 13, with no converter: a `/0` one is refused, named. The next incompatible change to
  `key.md` or `dataset.json` makes it `/1`.
- **Records** (run, trial, score, grade, label, the loop's) and `awf-lab.json` are `/1` since task 13;
  a `/0` one is refused or left out by name, with no converter (beta).
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

- **Live spend for tasks 11 and 12** (2026-11-18): $25 each, every run given `--budget`.
- **Judges compared beside the one that decides** (2026-11-18): `score --judge` keeps another
  judge's grades with its agent and voters, marked `beside`; only `judgeAgent` decides. Rejected:
  a grader per judge (its identity in names records pair by) and columns of grading (mixes what
  ran with what graded).
- **Labels by command for now** (2026-11-18): `awf-lab label`, a record per label; a queue or web
  interface later on the same record. `labels.md` dropped: it needed syncing and couldn't be blind.
- **Labels, rates with intervals, tags** (2026-11-17), after a review of the design against eval
  practice; labels are given with `awf-lab label` for now, a queue or web interface
  later on the same record. Then the judge becomes a parameter, compared on agreement and cost.
- **Reviews and the loop move onto cases on this branch** (2026-11-16): building them beside the
  design shows what it gets wrong while it can change.
- **Q10, one outer box, `"lab"`**: the whole trial in one sandbox from any provider, keys outside
  it, the workflow's own sandboxes set aside inside (srt doesn't nest on macOS). Building it took a
  small engine change, which the person chose: `awf run --boxed` (task 10's notes).
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
- [x] 9. Parameters, reuse, labels, rates and `compare` (the live labels are the person's)
- [x] 10. The `"lab"` box (srt; Docker later)
- [x] 11. The review datasets on cases
- [x] 12. The loop, for any dataset
- [x] 13. One kind: the review kind retired, records at `/1`

Order from here: tasks 1 and 5 wait on the person; 3's last check follows 1 (the judge on its
held-out third), and 6's follows 5 (a real run of each workflow captured).

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

M6 was answered in task 11: `git grep` over each of a 13,700-commit history's commits took 182 s
a search; reading every object once takes under a second, and also finds a commit no ref reaches.
The search never needs to skip the shared history.

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
- [x] Implement, step by step, each committed with its tests:
  1. [x] parameters and columns;
  2. [x] the store per project and `records`;
  3. [x] reuse, `--fresh`, `reuseDays`;
  4. [x] labels: `label`, a labels file per dataset, agreement, the judge's mark;
  5. [x] tags and rates: intervals, pass^k, pass@k, `--tags`;
  6. [x] `compare`, with `src/compare` moved into `src/shared/`;
  7. [x] `run --budget`, `--dry-run`, `--json`; `report --md`;
  8. [x] judges compared: `score --judge`, `voters`.
- [x] Review: architecture and scope; correctness and proof (steps 1–7; step 8 by its tests and the live check).
- [x] Resolve: disposition every finding.
- [x] Verify: the `Done when` items, but labels on the mail dataset, which are the person's.

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

- [x] Plan (Implementation notes, "Task 10's plan"), implement, verify; reviewed by its tests and
  the live check, the review of tasks 10 to 13 together after task 12.

Done when:

- A test: code and agents in the box can't read a key (file or git history), an ignored file, the
  records, a `hide` path, the store (but a try's copy mounted from it) or the home folder.
- A test: the box reaches only `agentReach`, the model domains, `realHosts` and the engine's
  hosts; a workflow that opens its own sandbox runs with it set aside.
- Live: refund-desk's `decide` under `"lab"`.

### 11. The review datasets on cases

- [x] Plan (Implementation notes, "Task 11's plan"; the grader's modules move with task 13),
  implement, verify; reviewed with tasks 10 to 13 together after task 12.

Done when:

- Every autoresearch dataset converts and verifies, holdout included.
- A test: no case folder holds a commit beyond its base or head, and no key's text is found in
  tracked files outside `evals/` that `hide` doesn't cover.
- A test: `run`, `score` and `report` leave holdout cases out.
- Live: a few tuning cases, two trials each, on both labs with the same grader; recall and
  precision agree within the review lab's own spread.

### 12. The loop

- [x] Plan (Implementation notes, "Task 12's plan"), implement, verify; reviewed with tasks 10
  to 13 together, resolved ("Review of tasks 10 to 13").

Done when:

- A test on scripted agents: a loop keeps a better try, drops a worse one, compares each try with
  the last kept one, stops at the cap with exit 3, and never shows the proposer a holdout case.
- A test: a try that changes anything under `evals/` is refused, and generated code reaches no key.
- A test: a loop stopped mid-try resumes.
- Live: a short loop on refund-desk, then one round on air-1 under the cap the person sets.

### 13. One kind

- [x] Plan (Implementation notes, "Task 13's plan"), implement, review (with tasks 10 to 12),
  resolve, verify.

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
- [x] Parameters, reuse, labels, rates and `compare` (task 9).
- [x] Nothing in the `"lab"` box reads a key (task 10).
- [x] Every autoresearch dataset converts and verifies (task 11).
- [x] A loop keeps a better try and never shows a holdout (task 12).
- [x] One kind, records at `/1` (task 13).
- [x] `bun test`, `bunx tsc --noEmit`, `bun run scripts/check-boundaries.ts`.

Live, still open: the builds dataset (task 5); the judge on task 1's held-out part (task 3); a
real run of each workflow captured (task 6).

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
  folder and each dataset's cases, keys, `dataset.json`, graders and
  `capture.ts`; `env.ts` and its helpers stay in it. Beside it: the parameters, the built case's
  digest, the trial settings of `dataset.json`, and the `awf` and lab versions.
- **A fresh clone** needs each trial's record, scores and `kept/` committed; the built case is
  not committed but built again from the case folder and checked against the trial's `input`
  digest, so a case edited since is "run it again", as `score` does now. Measured at step 2: about
  33 KB of records a mail run and 8 KB a refund-desk run.
- **Run ids** replace run numbers: the time and four random hex digits, a second later than the
  last run's when two fall in one second, so they sort in order; `report` and `score` take the id
  or its last four. Records copy both ways: each command reads the records folder into the store
  (a run it lacks whole; newer scores when they extend the store's), and `run` and `score` write
  their run back, so the rest of the lab reads the store alone.

### Task 9's review (steps 1–7)

Two subagent reviews, architecture and correctness. Fixed, each with a test:

- `--failed` reused the very trials that failed, so it learned nothing: it now always runs fresh.
- A reused trial was a full copy: grades drifted between copies, every rerun committed a copy, and
  history counted one workflow run in every run that reused it. It is now a pointer
  (`reused.json`); grades stay where it ran; a run that only reused adds nothing to history.
- Two columns that shape trials alike (an A/A check on a clone) shared one trial: each stored
  trial now serves one column.
- The plan didn't price, and `--budget` didn't cover, grading reused trials again: both do now.
- Records sync lost grades when two machines graded the same run, and read-only commands rewrote
  committed files: copies now go one way per command, scores and labels merge as unions, and in
  the records each grade and label is a file of its own, so branches never conflict.
- An errored trial labeled good counted twice in agreement; `compare` read numbers of graders that
  don't decide; a bare `report` took another worktree's newest run; a label stamped the system
  clock; the label record's `trial` field now reads `runId`, the workflow run's id.

Open nits: history is keyed by the checkout's path on this machine (said in the reference); the
code digest skips symlinked files and, for an `--against` folder, leaves out paths by your
checkout's layout; the lab's own share of the key covers `env/` and `format/`, not `shared/`;
pass^k is left out when cases asked different trial counts; two machines claiming one run id in
the same second would be read as one run; labels are filed by dataset name, so a rename orphans
them.

### Task 10's plan

- **Probed** (2026-11-18): srt inside srt fails on macOS (the inner srt can't bind its proxy
  socket, even with sockets and local binding allowed), and awf refuses srt inside Docker. So the
  workflow's agents can open no sandbox inside the box.
- **The engine change, the person's choice**: `awf run --boxed` (done, `5acfd591`) sets the
  workflow's sandboxes aside: `wf.sandboxes.open` opens none and every agent runs as a host agent,
  inside the caller's box. Refused with `--sandbox` and `--continue`; contract unchanged.
- **The box, srt first**: `"sandbox": { "lab": "srt" }` runs `srt -s {profile} -- bun … awf run
  --boxed …` per trial. Reads: the system, the toolchain (bun, git, each harness's executable and
  install tree, by realpath), the code folder and the realpaths its `node_modules` links lead
  to, the case and scratch folders. Denied inside them: `.git`, every case's `key.md` and `key/`,
  the records folder, the store and the home folder. Writes: the scratch folder, a run root and a
  fresh `HOME` in the trial's own folder, whose run records the lab moves into the store after.
- **Network**: `agentReach.network`, the harnesses' model domains, `realHosts` and the engine's
  hosts. The lab imports contract only, so it keeps its own table of model domains; a repo-level
  test fails when it drifts from harness's.
- **Credentials**: the fresh `HOME` holds none of the operator's harness state (it can hold
  transcripts of earlier judging, keys among them), so a box suits agents that log in with an
  API key, as metered headless ones do; one that needs a stored login is given that file alone.
- **The reach check** under the box: the box's own profile is the trial's reach, recorded as the
  trial's `reach`; agents with no sandbox of their own are expected.
- **Docker** after srt, with the review lab's `docker run` (`--cap-drop ALL`, the operator's uid,
  mounts only), its image holding bun, git and the harnesses.

### Task 11's plan

- **Where it lives**: everything of air-1 is autoresearch's, in `evals/air-1/`: the converter
  `scripts/to-cases.ts`, `checkout.ts`, `env.ts`, `graders.ts`, `graders/match.ts`, the cases.
  awf gains only what any dataset needs: `hide` and a faster key search.
- **The history** is a chain of bundles in the dataset's `files/history/`, not one cut: one cut
  at the common ancestor of every base left each case bundle carrying the history from there to
  its own base, 117 MB over 60 cases. In order of their bases, each case's cut is the common
  ancestor of its own base and every later case's, so a case reads the chain to its cut and
  nothing after its base: 28 bundles, 131 MB in the first, 8 MB of case bundles in all, committed
  (autoresearch has no remote, so no host's file limit applies).
- **`env.ts`** restores the checkout into the scratch folder: branch `review` at the head, the
  default branch and `origin/{branch}` at the base, as the review lab did. `--param
  variant={name}` loads `variants/{name}.variant.ts`, whose default export is the workflow with its
  argv and `read`; `observe` writes the findings to `findings.json`, kept for the grader.
- **In the box** claude agents run headless and metered: a terminal pane is started outside the
  box. `variants/runtime.ts` reads `AUTORESEARCH_PLACEMENT`, which `env.ts` sets.
- **The grader** reads `fixture.json` and `request.md` from the case and the findings from
  `kept/`, and restores the checkout into its own working folder only when voters are needed.
- **`hide`** in `awf-lab.json`: paths of the code folder the box hides as it hides keys.
  autoresearch's tracked `datasets/` and `results/` quote keys word for word; a test keeps that
  so.
- **The review lab's stored trials** stand in for its side of the live comparison: the same
  variant, the same grader, on the same cases.
- **The review modules the grader and `env.ts` import** (about 2,500 lines of `review/format`,
  `judge` and `metrics`) move into autoresearch with task 13, beside its 74 variant files, which
  import `defineReviewVariant`: one move when the review kind goes, not two copies meanwhile.
- autoresearch is worked on in its main checkout; its `node_modules` links point at this branch
  until it merges.

### Task 12's plan

- **The command**: `awf-lab loop {name} --budget {usd} [--dataset] [--program {file}]
  [--proposer {harness/model}] [--trials {n}] [--rounds {n}] [--allowance {pct}]`; the first run
  needs `--program`, the operator's steering, and starts from your checkout as it stands. `loop
  {name}` again resumes; `--final` checks the kept incumbent against the start on the holdout,
  once; `--patch` prints the incumbent as a patch against the start. Only a dataset under `"lab"`
  with a `compare` loops.
- **A try's code** is a copy in the store, `loops/{name}/tries/{n}/code`: the files git holds in
  the incumbent's folder, less each dataset's `cases/`, with `node_modules` linked to your
  checkout's. It runs as an `--against` folder does: its `env.ts` and code, the checkout's cases
  and graders. The start is copied once, `loops/{name}/start`.
- **The proposer** is the lab's own workflow, run in the lab's box: it reads the try's copy, which
  it may write but for `evals/`, and a bundle: the program, each tuning case's facts, grades and
  graders' reasons for the incumbent's trials, the history of tries, the rules (the comparison's
  version, the cases, the spend left). Never a holdout case, a key or a case's files.
- **The scope check**, in code, before anything runs the try: the files changed against the
  incumbent, none under `evals/` or `node_modules`; no changed file holds a tuning key's marker or
  forty characters of its text; at least one file changed.
- **The try runs** case by case in a seeded order of the tuning cases, the incumbent and the try
  as two columns, until `compare` says stop or the cases end; the incumbent's trials are reused
  across tries. It is kept on `better` only.
- **Stops**: the cap (`--budget`, the proposer's and the trials' estimates summed from the loop's
  records; exit 3), three tries in a row kept nothing, the rounds. `--allowance` waits while a
  plan window the agents draw on is that far used, as the review lab's did.
- **Records**: `loop.json` (the start, the program's digest, the holdout, the comparison, the
  trials, the cap, the proposer), `tries/{n}/try.json` (the hypothesis, the changed files, the
  decision and why, the runs, the spend), `finals/{k}.json`. A try cut short after its proposal
  resumes with it; before, it is proposed again. A loop resumed with another holdout, comparison
  or trials is refused.
- **Proven** on scripted agents first, then live on a refund-desk dataset whose workflow misses
  some cases, then one round on air-1.

### Task 13's plan

The person chose to retire the review tooling in autoresearch rather than freeze a copy
(2026-11-18).

- **Into autoresearch first**, in its main checkout:
  - `lib/review/`: the modules the match grader, `env.ts` and the converter use (the review
    formats, matching, voting, the judge's checks and prompt, the metrics, the fixtures' git and
    verify), their imports made relative.
  - `variants/variant.ts`: a plain `defineVariant` of the same shape, `{ workflow, argv, read }`
    under `review`, which the 89 variant files import in place of `defineReviewVariant`;
    `env.ts` is unchanged.
  - `scripts/collect/`: `collect`, `draft-key` and the fixtures workflow, writing fixtures as
    today; `scripts/to-cases.ts` turns them into cases.
  - Deleted: `scorers/`, the scripts that read the review lab's stored results, the review lab's
    `awf-lab.json` and `awf-lab.loop.json`. `results/`, `reports/` and `docs/` stay as data.
  - Its tests pass, and air-1 runs, on the case kind alone.
- **Then awf**:
  - `packages/lab/src/review/`, its docs (`docs/reference.md`) and its schema files are deleted;
    `src/cli.ts` runs the case kind alone.
  - A retired command, flag or `awf-lab.json` field is refused with what replaced it, as the
    story's list says; a review-kind `awf-lab.json` is refused by name.
  - The records, `grade.json` and `awf-lab.json` become `/1`; a `/0` one is refused by name, with
    no converter (beta). The `/0` records in autoresearch's `evals/records` are written again by
    a run, not converted.
  - `check-boundaries.ts` loses the review rules; the README, `docs/status.md`,
    `docs/testing.md` and `docs/foundation.md` name one kind.

### Task 13's notes

- autoresearch took `lib/review/` (formats, fixtures, matching, voting, metrics, the judge's
  checks), `scripts/collect/` (`collect`, `draft-key`, the fixtures workflow, `verify-set`) and
  `variants/variant.ts` (`defineVariant`); its scorers, the scripts that read the review lab's
  results, both review `awf-lab.json` files, and the oracle and comments variants, which read the
  key a trial may not, are gone. Its tests (84) pass and air-1 ran a trial on `/1`.
- awf: `src/review/`, its 18 schema files, `@agentswf/lab/review` and `@agentswf/lab/compare` are
  gone; `retired.ts` refuses each retired command and flag with what replaced it, and
  `config-file.ts` each retired `awf-lab.json` field; `/0` records are named and left out, `/0`
  labels stop the command. `run-sandbox`'s live check drives its probe with `awf run --sandbox`
  directly, passing live ($0.04); its stale check counted a JSON refusal as a record.
- The proposer's effort levels lacked `ultra`; the harness test found it once it pointed there.
- The mail project's `evals/awf-lab.json` (`mini-workflows`, branch `evals`) is still `/0`, so it
  is refused until its kind is `awf.lab-workspace/1`: the person's to change.

### Review of tasks 10 to 13

Two reviewers, architecture and correctness, on `8642a47e..21bca0e8`. Resolved:

- **A loop's boxes read the workspace's keys** (both, must-fix): a copy's awf resolves into your
  checkout, whose `examples/` the box was given whole, while the keys hidden were the copy's. Both
  boxes now hide the workspace checkout's keys, history, ignored files and `hide` paths as well as
  the code folder's; the box reads no awf `examples/` and never the home folder or above it. An
  srt test reads the workspace through a given path and must be refused its key.
- **The cap could be crossed, and a cut lost spend** (must-fix, should-fix): a try's spend is now
  summed from records kept as it goes (`runs.json`, the runs it started, priced from the store;
  `proposer.jsonl`), the cap is checked before the proposer and before the try's run, and a try
  the cap stops is left undecided. A run's last trial may still cross the cap, as `--budget` does
  everywhere.
- **A resume's `--budget` was ignored** (both): a different one sets the cap, kept in `cap.jsonl`.
- **`--final` spent uncapped** (both): it needs `--budget`, and runs under the loop's `--param`,
  now in `loop.json` and compared on resume. A loop refuses `--tags`, `--against`, `--vary`,
  `--failed`, `--fresh` and `--holdout`.
- **Code outside git escaped the scope check**: a try with anything git doesn't see but the
  linked installs is refused.
- **`/0` labels dropped silently**: they stop the command, named.
- **`awf-lab.json`'s retired fields** each name where they went; **`@agentswf/lab/compare`**, the
  retired comparison-file API, is no longer published; **`hide`** is in the reuse key; retired
  names are looked up as own keys, so a loop named `constructor` is no retired command; the loop's
  and the label's records have published schemas; the story, ADR 0003, two dead links,
  `testing.md` (the box's srt test) and the holdout schema's text are current.
- **The proposer's bundle quotes tuning keys**: kept, and said so in `cases.md`: the tuning
  cases are what it learns from, and the scope check refuses copying them; a holdout never
  reaches it. The paste check is sure from about fifty characters, as `cases.md` now says.

Settled with the person after the review:

- **A boxed run says so**: `run.json` and the run's record carry `boxed: true`, and `awf runs`
  shows "boxed by its caller", so its agents never read as the host's.
- **A loop runs from the project that uses awf**, as autoresearch does: with `records` set, the
  loop's own files (not its code) go to `{records}/loops/{name}/`, each try's change as
  `change.patch`, and a store that lacks them builds the code again from the start commit and the
  changes, so a clone goes on with the loop. A loop started from uncommitted changes goes on only
  where it started; one of the same name started elsewhere is refused.
- **A stall stops the command, not the loop**: three tries that kept nothing end that `loop`
  command; run again, it goes on.
- **A run that printed no record**, a trial's or the proposer's, is priced from its folder
  (`awf runs {id} --json`).
- autoresearch's `bun.lock` names the new bin; the mail project's `awf-lab.json` is `/1`.

Still open: `"network": "any"` from task 10's plan is neither built nor needed yet.

### Task 12's notes

- `run` takes what a loop asks of it (`RunGiven`): the code folders, the reference first, in
  place of your checkout; the case order; each case's trials in every column before the next; and
  a stop check after each case. A run the comparison stopped is `stopped: "compare"`, which exits
  as the report does, not 3.
- A try's run holds the incumbent's reused trials of every case from its start, so the loop gives
  `compare` only the cases both columns ran.
- A try is committed as soon as the proposer answers, so a resumed try reads its change from that
  commit; a run the lab broke during stops the loop undecided, and it resumes with the try.
- srt lets a denied folder win over a writable one inside it, so the proposer's box hides the
  store around the try's copy and bundle (`hiddenAround`) rather than whole.
- The allowance wait moved to `shared/`, for both kinds; a case loop waits on the proposer and on
  any `harness/model` parameter, as it cannot see a workflow's own agents before they start.
- A comparison reads the numbers of the graders that decide a case, so the loop counts the
  dataset's graders as `report` does, never running one; it had counted none, and a dataset graded
  by numbers alone compared nothing.
- A try's code is its own, so a trial of it a resumed run reuses ran in the try's earlier run and
  counts toward the cap; the incumbent's reused trials do not.
- A `tricky` dataset in refund-desk, ten tuning tickets and two held out, for the live check: Haiku
  5.5 and 4.5 pass all but one, `whole-set` (Haiku 4.5 refunds a share of a set).

### Task 10's notes

- Two more small engine changes, inside the person's: `AWF_CONTROL_ROOT` moves the engine's
  socket root off `/tmp`, which the box denies; and where `ps` is forbidden (srt refuses a setuid
  program, as macOS's `ps` is), a process takes its own start time from its uptime.
- claude makes `/tmp/claude-{uid}` unless `CLAUDE_CODE_TMPDIR` says otherwise: the box sets it.
- The lab's share of the reuse key now covers `trial.ts`, `box.ts`, `folders.ts` and the runner:
  a live run reused a failed trial across a change to how trials start.
- Open: Docker as the box's second provider; `agentReach.webSearch` is not enforced in the box;
  a stored-login harness needs its one file given to the box.

### Live checks

- Mail, `expect` only (task 2): 21 trials, median 9 s and an estimated $0.003 a trial; a known
  miss failed, was settled with the person as a wrong key, and the fixed run passed 7 of 7.
- Mail with the judge (task 3): 21 trials, every case passed, 36 criteria judged, none split;
  grading $3.53 against the trials' $0.06.
- `--against` (task 4): a worktree whose prompt drops dates failed `newsletter` and `trip-form`;
  your checkout passed all three; exit 0.
- refund-desk (tasks 3, 6, 8): a code grader, a tone grader workflow graded again by `score` after
  a minor bump, and a captured trial finished and run (time per stage `decide 6.2s`).
- `--vary` and reuse (task 9): refund-desk's `decide` over `model=claude-haiku-5-5,claude-sonnet-5-5`
  (the workflow gained `--model`): 6 trials, every case passed in both columns, Sonnet an
  estimated $0.03 a trial to Haiku's $0.002; the same command again reused 6 of 6 and ran nothing.
- Judges compared (task 9): the mail dataset, 7 trials, every case passed, the Sonnet judge an
  estimated $1.18 of grading; `score --judge claude/claude-haiku-5-5` judged the 4 trials with
  criteria for $0.08 and differed on none (12 of 12 parts alike). Which is right waits on the
  person's labels.
- The lab's box (task 10): refund-desk's `decide`, its three cases in srt, `awf run --boxed`, the
  workflow's inline srt set aside and its claude agent run inside the box with a fresh home and
  `CLAUDE_CODE_OAUTH_TOKEN`: every case passed.
- air-1 on both labs (task 11): Haiku 5.5 fork-high (`c-haiku55-fork-high`) on air-2119,
  air-2148 and air-2154, two trials each, in the lab's box: 6 trials, none errored or leaked, est.
  $1.39 for the trials and $1.48 for grading. Weighted recall 22/30 (0.73), precision 75/106
  (0.71). The review lab's stored trials of the same variant on those cases: 0.60 and 0.89 under
  its `match-sonnet`; the same stored findings under the case lab's `match`: 18/30 (0.60) and
  65/83 (0.78). Recall agrees on the same findings; precision moves 0.11 between the two
  graders on the same findings, the Sonnet voter's own spread, as far as it moves between the
  labs. The run predates `hide`, so it shows the labs agree, not that nothing leaked.
- The loop on refund-desk (task 12): `tricky` on Haiku 4.5, two trials, a $5 cap, two rounds of
  a Sonnet 5.5 proposer in the lab's box. Each try changed `workflow.ts` alone (an item counts as
  named when a group it belongs to is), ran against the start on all ten tuning cases with the
  start's trials reused, and was discarded as a tie: try 2 won `whole-set` once in two trials,
  one case of ten, which the paired rule can't show. Est. $1.85. Three earlier loops found the
  box's rules the proposer met (its folders under the hidden lab home, its starting folder, zsh's
  here-documents under `/tmp`), each fixed with a test.
- The loop on air-1 (task 12): Haiku 5.5 fork-high on eight tuning cases, one trial each, a $20
  cap. The Sonnet 5.5 proposer, in the box, ran the copy's own awf and changed one file: every
  lens traces a change's callers, writers and siblings before it reports. Against the start:
  weighted recall +0.09 [−0.08, +0.26], won 4, tied 3, lost 1; undecided at eight pairs, which
  the paired rule needs more of, and discarded. Est. $0.11 for the proposer and $9.47 for the
  trials and grading, the incumbent's $4.54 of it. Two earlier rounds found the box's reads of
  an install a copy links to, and the comparison counting no grader; each fixed with a test.
- The loop after the review (tasks 10 to 13): refund-desk's `tricky`, Haiku 4.5, two trials, a $3
  cap, `desk4`. Its first round's proposer could not load awf: the box no longer read awf's
  `examples/`, so not the install a copy under it links; it reads `examples/node_modules` now.
  The second: the proposer changed `workflow.ts`, the try tied the start on all ten cases and was
  discarded; its ledger counted $0.08 for the proposer and $1.10 for the trials, the incumbent's
  reused trials not again. Est. $1.71 for the loop.
- Environment: `srt` is installed under Node 22.20.0 only while mise selects Node 24; live runs
  put Node 22's bin first on `PATH`.

## Human review

- [ ] Every task is complete and story-level verification passes.
- [ ] Set the story status to `awaiting-human-review` and present the outcome, decisions, review
  findings and dispositions, verification results, deviations and remaining risks.
- [ ] Record the human's approval or requested changes here.
- [ ] Only after explicit approval, mark the story `done` and update `Stories at a glance`.
