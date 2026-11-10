---
title: Cases for a workflow
type: design
status: draft
---

# Cases for a workflow

How a person says what a good result is, before a workflow exists or after a run went wrong, and
how a changed workflow is tried against that. **Draft 2, 2026-11-09: nothing here is decided or
built.** Draft 1 was reviewed against the code, the repository's decisions and other eval tools;
what that removed is in Considered and dropped.

**Overtaken in part by [[044-cases-for-a-workflow|story 044]], which holds the current design.**
Where the two differ, the story is right. What it changed:

- The layout: variants and shared `files/` under their dataset, `key.md` beside `input.json`, no
  `recorded/` folder, no sealing.
- The world: no fixed kinds and no `defineEnvironment`. A variant file wires the workflow to a
  case, and an optional `setup.ts` prepares a trial.
- Holding the rest still: a dataset says `"sandbox": "lab"` or `"workflow"`; there is no list of
  allowed domains and no container.
- Hiding the key: the trial's folders are outside the repository and every key carries a marker
  the lab looks for. A sandbox reads the repository's `.git`, so a workspace the sandbox "can't
  read" was not enough.
- Scoring: a trial that errors is counted apart; a `check` in `setup.ts` runs what was built;
  the bar for the judge in step 1 of the plan is the story's, not κ ≥ 0.7.
- What is kept: every run under a label, nothing reused between runs, compared by setting one
  run beside another.
- What has to be built: the story's tasks replace both tables and the plan's steps 1 and 2.

What still stands here and is not in the story: the reasons a case binds to the task and not to
stage names, running from a stage and the test generator (plan steps 3 and 4), and Considered and
dropped.

The words are the lab's ([`packages/lab`](../../packages/lab/docs/reference.md#The%20words)):
**dataset**, **case**, **key**, **variant**, **trial**, **scorer**, **judge**, **score**,
**report**. This adds three. A key's items are **criteria**. A case is **written** by hand or
**captured** from a run. A trial's **scope** is how much of the workflow runs live in it.

"Eval" stays what it means here, a `*.eval.ts` check that a feature still works on live agents
([`foundation.md`](../foundation.md) §7). This is the comparison side: the lab's.

## Open questions

Each has the answer this draft assumes.

1. **Where do cases live?** Assumed: in a workspace folder in the project's own repository, and
   the key is hidden by where a trial runs, not by where the case is kept: a trial's scratch
   directory holds the case's `files/` and never its `key/`, and the agents' sandbox can't read
   the workspace. That departs from
   [[0003-autoresearch-tools-here-project-data-there|ADR 0003]] for a project's own cases. Two
   things it doesn't settle: whether a case's content (a real email, a captured prompt) belongs
   in git, which is the owner's and solved by ignoring `datasets/`; and a dataset whose world is
   the same repository, where the checkout must be restored without the history that holds the
   keys.
2. **Is a resource held as a file enough for the first version?** Assumed yes (Holding the rest
   still). A recorded answer played back per call, a mock in the usual sense, is dropped until a
   named workflow needs it.
3. **Is the first output a regression table, not a verdict?** Assumed yes: each case, each variant,
   how many of its trials met each criterion. A verdict comes from the lab's comparison once a
   dataset is large enough to give one.
4. **Who writes a key?** Assumed: a person writes the criteria, or says in a sentence what was
   wrong and approves what an agent drafts from it. No key is used unapproved.
5. **Workflows with events?** Assumed out of the first version.
6. **Which workflows first?** A mail triage and web-to-cli's build.
   [[044-cases-for-a-workflow|Story 044]] has the commands, files and reports for both, and the things
   they asked for that this draft lacks; the four that change it are in What has to be built.

## What this is for

The lab can say whether one review workflow is better than another, on cases built for the purpose
by a workflow of its own. Nothing serves the two everyday moments:

- **Before a workflow exists:** "here are six tickets and what a good plan for each must say."
- **After a run:** "this one missed something; the next version must not."

Both are a case: an input and a key. So a case is a spec first, and a run is one place a case can
come from.

```text
write      a person writes a case                   an input, and the criteria a good result meets
capture    awf-lab capture {run}                    or: a run's input becomes a case, its key still to write
run        awf-lab run {variant}                    trials on the cases, in a sandbox
score      a judge settles each criterion           per trial
report     awf-lab report                           case by case; later, a verdict
```

The first workflow written against a dataset is its first variant, and it fails most criteria.
That is the point of writing them first.

## The case

```text
datasets/{dataset}/
  dataset.json             the kind of world its cases have, and the network a trial may reach
  cases/{case}/
    input.json             the args, and the world: what restore needs
    files/                 resources the case carries: a ticket, a request, a log
    key/key.md             the criteria, and the person's words
    recorded/              a captured case only: the source run's result and stage values
```

- **A case binds to the task, not to a workflow.** It names args and judges the final result.
  It can't name a stage or an agent, since a case may be older than every workflow tried on it,
  and one refactor would otherwise empty the dataset. A variant says how its workflow is handed a
  case, as now: an argv with the case's fields filled in.
- **The key sits apart from the input,** in `key/`, as a review's does. Nothing under `key/` or
  `recorded/` is ever inside a trial's sandbox.
- **`input.json` and `files/` are sealed** when written; a different input is a different case. A
  retired case is archived, not deleted, so stored scores keep their meaning.
- **`recorded/` is not a reference.** A run kept for going badly returned an answer the person
  rejected. It is evidence for whoever writes the key, and never something a trial is scored
  against. A person's correction, when given, goes in the key.

### The world

What a trial's checkout holds is the dataset's kind, declared once
([[evaluation]]: "the dataset kind says what a case's environment holds"):

| Kind | A case's world | Restored by |
| --- | --- | --- |
| `none` | nothing but `files/` | — |
| `commit` | a repository at a commit, its history cut at that commit | the lab's restore, from a clone the workspace names |
| `review` | the frozen merge request the lab has today | as today |

A workflow whose input is a remote thing that keeps moving (a merge request, a ticket) has that
thing frozen into `files/` when the case is made, as the review kind freezes `request.md`. The
commit of the working directory is not such a workflow's input, and capture does not pretend it
is: it takes `--at {commit}` where the kind is `commit`, and asks for the files otherwise. The
engine records no git state, and by decision won't ([[runs-and-stages]]: "a stage's own values
are where that belongs").

### key.md

```markdown
---
source: plan-ticket/PROJ-1515
rating: bad
criteria:
  - id: k1
    kind: must
    text: the plan names the cache key change in src/fetch.ts as its own step
  - id: k2
    kind: must-not
    text: the plan proposes a new table (the ticket rules out a migration)
---

Planned around the wrong module and proposed a migration the ticket excluded.
```

- **A criterion** is one claim a judge settles against the result as `met`, `unmet` or
  `unsettled`. `must` is met by a good result; `must-not` describes something no good result
  does. An `id` is never reused.
- **`rating`** (`good`, `bad`, `mixed`) and `source` exist only on a captured case, and say why it
  was kept. Neither is scored.
- **The key's revision is a digest of its criteria,** not a number a person bumps. A score records
  it, so a revised key re-scores stored trials without running them.
- **`expect`,** beside the criteria, names fields of the result and the values they must equal.
  Code settles it, so it costs nothing and is never `unsettled`. A structured result (a route, a
  verdict, relevant or not) is keyed this way first, and criteria cover what is left in prose.

## Holding the rest still

What a trial may touch, and what holds each thing. Everything in the first table exists.

| The workflow reaches | Held by | Mocked | Refused | Allowed real |
| --- | --- | --- | --- | --- |
| files | the case's world, restored per trial, in the run's sandbox | the case carries them | everything outside the checkout | — |
| a service it reads (a ticket, a request) | the case's `files/`, handed by the variant's argv | the frozen copy | the network list is empty | a domain in `dataset.json` |
| a service an agent calls from its shell (`gh`, `curl`, MCP) | the sandbox's network list | no | by default | a domain in `dataset.json` |
| a service the workflow's own code or a tool's handler calls | a `container` sandbox, which holds `awf run` itself | no | by default, in a container | a domain in `dataset.json` |

So the control asked for holds at the granularity of a domain: a resource is frozen into the
case, or the call fails, or the dataset names it as real. The allowance is the dataset's, not a
flag on a run, so two runs of one variant can't measure different things
([[evaluation]], decision 5).

What does not exist is a mock per call: a tool's handler answered from a file, an agent answered
from a recording. The rule for authors until it does: a workflow meant to be tried takes what it
reads as an argument, and does what it writes (a post, a push) where a sandbox can refuse it.

## Scope: how much runs live

| Scope | Live | Uses | Answers |
| --- | --- | --- | --- |
| whole | every agent, the world held | `awf run`, as the lab runs it | did the workflow get better? |
| from a stage | the stages from a named one on; those before it take the source run's values | `--from-stage` and `--values`, as they are | did the back half get better, for less? |
| code only | nothing: every agent scripted from a captured run | a `testWorkflow` test, generated | does the code still drive this real case? |

All three need no engine change.

**From a stage** is the modularity available today, and it is narrower than "one stage alone":

- Only a captured case has values to give, and only for a workflow that still has those stages
  with schemas that accept them. A variant that doesn't is run whole.
- The trial is still judged on the final result, so the key needs nothing about stages.
- A stage's value holds what the workflow chose to carry, often an identifier: a branch, a
  worktree, an absolute path under the source run's directory
  ([[0011-a-run-continues-from-its-stages|ADR 0011]]). Given to a live stage in a trial, such a
  value points out of the scratch checkout at the person's real tree. Capture refuses a value
  that holds the source run's directory, and the scope is offered only where upstream values are
  content.
- Code before and between stages runs in every attempt, so it is live here too.

**Code only** is a workflow test nobody had to write: capture turns each agent's accepted answers,
each decision and each tool result into `agentswf/testing` scripts
([[0006-workflow-tests-run-on-a-second-composition-root|ADR 0006]]). Like any scripted test it
fails when the workflow asks its agents something else, and is then generated again from a newer
run. It gives no score.

**A part that scores better alone is not a better workflow.** This is a rule, not a measurement:
nothing surveyed measured it, and the argument is that components have to be tuned together. A
change found from a stage is confirmed whole before it is kept.

## Scoring

- **The criteria judge** is the lab's judge with a different question: voters settle each
  criterion against the result, reasoning before the label, votes kept. A split the tiebreak
  doesn't settle is `unsettled`. An `unsettled` `must-not`, or a judge that failed, never counts
  as met.
- **A case's numbers:** the share of `must` criteria met, and `must-not` criteria violated,
  reported apart as `wrong` is for reviews. Time, tokens and cost come from the run, as now, with
  the judge's counted separately.
- **Trials repeat.** One run of a case says little; the report gives each criterion as met in
  *n* of *k* trials.
- **The source run is never the baseline.** A run kept for going badly was partly unlucky, and the
  same workflow run again on its case usually does better. A variant is compared with the
  baseline's own trials on the same case.
- **A trial a refusal ended is a failed trial,** counted against its variant. Setting it aside
  would drop exactly the cases where the variant behaved differently. Only a trial whose world or
  sandbox never opened is not a trial.

**No verdict from a handful of cases.** The lab's own numbers: 16 review cases ended undecided,
and resolving a difference of 0.1 took about 18. A share of one or two criteria is coarser than
weighted recall. So the first report is the table, and `awf-lab check` says when a dataset can
carry a verdict. Before any comparison a dataset is sealed at a date, so a growing folder doesn't
change which cases `--cases 8` means.

**Tuned-on cases flatter.** Cases are picked for being bad and then tuned on. A dataset names its
holdout before tuning starts, as the lab does, by date: the cases added after a day. The loop's
scope check, which keeps a proposer from copying a key's wording, covers criteria and the
person's words too.

## What has to be built

All in `packages/lab`. Its case side is review's throughout: a case is a fixture and an answer
key, restore takes a bundle, a trial stores findings, a scorer is handed `--fixture` and
`--findings`, and the scratch checkout is deleted before scoring. So this is
[[second-case-kind]], with a captured or written case as the second kind instead of triage:

| Piece | What it is |
| --- | --- |
| the case kind | what a kind declares: its case format and checks, its restore, how a variant is handed a case, its trial record, its scorers. Review becomes one; `none` and `commit` the others |
| a trial record for a result | the workflow's result as read by the variant, where a review's holds findings |
| `key.md` | its format and checker, in `format/`, private to the lab and versioned |
| the criteria judge | a scorer workflow, on the existing voters |
| `capture` | reads a run through `contract`'s `readRun` and writes a case with no key; refuses values that hold the run's directory |
| the report's table | per case and criterion, *n* of *k* |
| the test generator | a captured run as `testWorkflow` options |

What the first two workflows added ([[044-cases-for-a-workflow|story 044]]):

| Piece | Why |
| --- | --- |
| `defineEnvironment`: a dataset's own `prepare` and `capture` | neither workflow's argv is its input: one reads an inbox, the other a ledger. This replaces the fixed `none`, `commit` and `review` kinds with a function, and a generic `capture` |
| `expect` in a key | result fields settled by equality, in code; most of a triage's key |
| `keep`, `files` and `measures` | paths copied out of the scratch directory for the judge; a variant's configuration laid over the world; numbers read off the run |
| a trial of a workflow that opens its own sandboxes | `awf run --sandbox` refuses one. The dataset's environment says which fence a trial runs under: the lab's (the default) or the workflow's own ([[044-cases-for-a-workflow|story 044]]) |

Nothing in `contract` or `engine` changes, and no published format is added.

## The plan

Each step is a gate, and the first can end the whole thing.

1. **By hand, before any code.** One workflow. About ten cases, some written from nothing and some
   from past runs, about thirty criteria in all. Run each case three times and settle every
   criterion by reading; have a judge prompt settle the same ones. *Proves, or stops here:* the
   judge agrees with the person (κ of 0.7 or more, with its misses each way counted); the same
   case's reruns differ by less than the change worth acting on; a past run's input can be
   recovered at all.
2. **The second case kind,** whole scope only: the pieces above but capture's stage values and the
   test generator. *Proves:* the lab's case side generalises; a case written before its workflow
   survives that workflow's first three rewrites untouched.
3. **From a stage.** *Proves:* a change that helps from a stage helps whole, on the cases where
   both were run.
4. **The test generator.** *Proves:* a captured run replays to its own result with no agent
   started.
5. **The loop** ([[013-autoresearch-loop|story 013]]) proposes against these cases.

## Considered and dropped

Each comes back only with the named trigger, and with its own decision.

| Dropped | Why | Comes back when |
| --- | --- | --- |
| `awf run --provide`: agents, tools and decisions answered per call from a recorded run, the rest refused | Whatever is live changes what every later agent is asked, so a recording is usable only upstream of the change, which `--from-stage` and `--values` already cover. A delivered prompt is not stable between runs (launcher paths, call ids, scratch paths), and an agent's instructions aren't recorded, so a match by what was asked either always fails or replays a stale answer silently, which is E6. A tool is called by a live agent with an input the model wrote, so a recorded input rarely matches | a named workflow needs one agent of a parallel group measured with its siblings held. Then: a recorded host installed by `operator-runtime`, matched on `op.json`'s `question` and `schema`, with its own ADR against E6 |
| providing a stage that isn't before the start point | It reverses ADR 0011's "from the start point on, every stage runs", and gives a later stage a value computed from an upstream that no longer exists. Its one use, not posting a comment, is the sandbox's | — |
| one stage scored alone | Needs [[runs-and-stages]]' planned `--to-stage` and its `paused` ending, the lab reading `stopped` runs and stage values from `run.jsonl`, and criteria bound to stage names | step 3 shows the back half is too coarse to tune on |
| the commit and a clean flag in `run.json` | A new record format every reader must know, for a fact [[runs-and-stages]] gives to the workflow; and the commit isn't the input of a workflow that reads a ticket | — |
| the tree written at each stage's end | Only needed to run a stage after one that wrote files | a workflow that writes is the one being tuned |
| cases in the project's repository by default | open question 1 | the owner decides |
| a verdict in the first version | too few cases, too coarse a number | `awf-lab check` says the dataset resolves one |

## Later

- Events and participants: what came in and what a person answered, as part of a case's input.
- A criterion that runs a command against what a trial built.
- Criteria grown from what trials find, as [[key-growth-from-runs]] grows a key.
- Rating a run as it ends, straight into a case with no key.
- An `awf` command over this, once the case format has held for two workflows.
