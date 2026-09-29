---
id: "010"
title: Count a review trial only when its reviewer could not see the answer
summary: awf-lab runs every trial with awf run --sandbox, one sandbox the workspace names that holds the checkout and the request and nothing else, so no variant sandboxes itself and nothing is checked afterwards; the reviewer's repository is laid out as its clone was.
type: story
status: done
discovered_in: "eval-isolation todo, 2026-09-23"
depends_on: ["004", "005", "008"]
---

# Count a review trial only when its reviewer could not see the answer

## Outcome

A score means something only if the reviewer couldn't look the answer up. After this story, every
agent of every trial runs in one sandbox that awf-lab gives the run. That sandbox works in the
frozen checkout, reads the request, writes nothing, and reaches only the models. The variant says
nothing about it and cannot widen it. Isolation is a property of the setup, not something checked
after each trial.

It matters now because [`variant-matrix-runner`](todo/variant-matrix-runner.md) and the
autoresearch loop compare variants by these scores, and story 008's first experiment ran every
variant unsandboxed ([008, issues](008-review-scorer.md#Issues%20we%20ran%20into)).

## How it works

```text
awf-lab run {variant}, per case
  1. {scratch} = a fresh temp directory, by its real path
     restore  {scratch}/checkout   head on `review`, origin/main at base, head's history only
     copy     {scratch}/request.md
     write    {scratch}/sandbox.json   { "read": ["{scratch}/request.md"], ...awf-lab.json's sandbox }
  2. awf run --cwd {scratch}/checkout --sandbox {scratch}/sandbox.json {variant} -- …
        the engine opens that sandbox before the workflow starts; every agent joins it;
        a workflow that opens a sandbox of its own is refused
  3. findings.json, recording the sandbox it ran in; scored as before; the scorer runs without a
     sandbox, as it reads the key
```

**The run's sandbox is the operator's** (`awf run --sandbox {file}`). The file is an inline sandbox
spec (`read`, `write`, `network`, and `srt` or `docker`); its `cwd` is the run's `--cwd`, so it may
name no `cwd` or `key`. The engine opens it before the workflow starts: one that can't open fails
the run before it starts, leaving no record, which awf-lab already treats as a trial never started
and tries again. It opens through the same code as any sandbox, so it holds its whole spec or doesn't open, with
per-agent homes seeded with credentials only (story 004). The workflow's `sandboxes.open`, and an
agent's `sandbox`, are refused: a sandbox inside a sandbox is not something the providers do, and
narrowing one isn't needed by any variant.

**The environment is the workspace's.** `awf-lab.json`'s `sandbox` names the provider: `{ "srt": {}
}` by default, or `{ "docker": { "image": "…" } }`. What goes in it is fixed by the case kind: the
checkout and the request. It is config, not a flag, because it's part of what a trial measures.
Each trial records the setting awf-lab gave its run (`sandbox`, optional in the trial format), and
only a trial under the workspace's current one counts: a trial from before this story, which may
have read past its input, or from another provider, is run again, and `report` says so. It records
the setting, not what it resolved to: a new default docker image, or a change to awf-lab's fixed
`read: [request]`, goes unnoticed; a workspace that must pin its image names it.
The field is added to `awf.review-findings/2` without a new format: awf-lab writes and reads it in
one package, and a trial without it is still read. An awf-lab from before it rejects a trial with it.

**The repository is the reviewer's clone, as it was.** `restore` builds a fresh repository holding
the snapshot's head and its ancestors, with no remote and no reflog; experiment 1 confirmed nothing
newer is in it. It also has the clone's default branch at `base`, locally and as `origin/{branch}`
with `origin/HEAD`, with the frozen head checked out on `review`. So `git diff origin/main...HEAD`,
the review workflows' own default, is the change under review. When main moved on after the MR
branched, `base` is no ancestor of head, and `restore` fetches it from the clone. The branch's name
is the clone's `origin/HEAD`, checked once before anything runs.

**What proves it, and when.** Nothing is checked per trial. The engine's tests show every agent of
a run given `--sandbox` lands in that one sandbox and a workflow's own is refused; awf-lab's show
every trial is given the spec; the providers' conformance suite and `sandbox-*` evals show what a
sandbox denies. `bun run eval sandbox-srt run-sandbox` (or their docker twins) is the check when a
machine is set up or srt changes. The live probe below is the evidence it holds end to end.

**What isn't covered: the workflow's own code.** It runs on the host, so a variant could read the
key itself, as the `oracle` and `comments` controls do on purpose. That is fine while people write
variants; [`design/evaluation.md`](../design/evaluation.md) names the trigger (autoresearch writing
workflow code) for running the whole run in a container.

## Scope

In scope:

- `awf run --sandbox {file}`: the run's sandbox, every agent in it, the workflow's own refused.
- awf-lab: `sandbox` in `awf-lab.json`, a spec per trial, `--sandbox` on every trial's run.
- The restored repository laid out as a clone, for trials, scorers and the key's graders.
- Scratch directories at real paths, so docker can mount what it is given.
- Running other, non-review workflows under a run sandbox, to see what breaks.

Out of scope:

- A ceiling a workflow's own sandboxes fit under ([`permissions.md`](../design/permissions.md)
  open question 7).
- The whole run in a container. See [`design/evaluation.md`](../design/evaluation.md).
- Scorers in a sandbox: a scorer reads the key by design.
- A per-run canary. See alternatives.

## Context and evidence

- Fact: `restore` already leaves only head's ancestry. Experiment 1.
- Fact: docker mounts a path by its real name only. Experiment 3.
- Fact: every workflow tried under a run sandbox ran unchanged, except those that open their own
  sandbox. Experiment 5.
- Constraint: `lab` imports contract only and talks to the engine through `awf run` and its record.
- Constraint: story 004 left the workflow restricting itself with no operator ceiling. This adds
  one form of it, for a whole run, and records it in `permissions.md`.

## Code map

- `packages/engine/src/operator-cli.ts`: `--sandbox {file}`: a JSON object naming no `cwd`, `key`
  or `provider`, given once, handed on as `sandboxes.run`.
- `packages/engine/src/sandboxes.ts`: `RunSandboxOptions.run`, `hasRunSandbox`, the run's sandbox
  opened once as key `run` by `openRunSandbox`; `open` refused under it; `RUN_SANDBOX_ONLY`.
- `packages/engine/src/workflow-runner.ts`: `startWorkflow` opens the run's sandbox before the
  workflow; `openAgent` refuses an agent's own sandbox under it and seats every agent in the run's.
- `packages/lab/src/review/format/workspace.ts`, `lab/workspace.ts`: `sandbox`, default srt.
- `packages/lab/src/review/lab/runner.ts`: `RunRequest.sandbox` becomes `--sandbox`.
- `packages/lab/src/review/lab/execute.ts`: `runTrial` writes the spec and records it on the trial;
  real scratch paths; `checkout` passes `base`.
- `packages/lab/src/review/format/records.ts`: `Trial.sandbox`, optional.
- `packages/lab/src/review/lab/plan.ts`: `currentTrial` counts only a trial in the workspace's
  sandbox; `whyNoTrial`, which `report.ts` gives for a case with only other trials.
- `packages/lab/src/review/fixtures/git.ts`: `restore({ base })`, `defaultBranch(clone)`,
  `scratchDir`.
- `packages/lab/src/review/build/draft-key.ts`: the graders' repository gets `base` too.
- `packages/lab/src/review/lab/cli.ts`: the default branch checked once before a run restores.
- `packages/lab/schema/awf-lab.schema.json`, `review-findings.schema.json`: regenerated.
- `tests/run-sandbox.ts`, `tests/run-sandbox.eval.ts`, `tests/run-sandbox-docker.eval.ts`,
  `tests/run-sandbox.test.ts`, `tests/fixtures/run-sandbox/probe.workflow.ts`: the live evals.
- `tests/lab-workspace.ts`: the synthetic lab workspace, shared by `tests/review-lab.test.ts` and
  the evals.

## Alternatives rejected

- **Each workflow sandboxes itself, and awf-lab checks every run record afterwards.** Built first,
  and replaced on the user's review: every workflow repeats a flag, and a check that has to run
  after every trial means the setup doesn't hold the property by itself.
- **The whole run in a container.** Also covers the workflow's code, but needs an image with awf
  and every harness, credentials passed in, headless agents only. Kept for when variants are
  generated ([`design/evaluation.md`](../design/evaluation.md)).
- **The whole run under srt on the host.** awf-lab would rebuild the seeded homes the sandbox
  package already builds, and srt doesn't nest.
- **A canary run before every awf-lab run.** Running a command in the sandbox without a model needs
  either a new `awf sandbox exec` or awf-lab driving the provider CLIs, a second translation of the
  spec. The run's sandbox is opened by the same code as every sandbox, which its tests and evals
  cover, so a per-run canary would re-prove what they prove.
- **Narrowing a workflow's own sandbox to fit the run's.** No variant needs it; refusing is simpler.
- **A command-line override of the provider.** Two runs of one variant could then measure different
  things, and a report would mix them.

## Tasks at a glance

- [x] 1. The reviewer's repository laid out as its clone was
- [x] 2. `awf run --sandbox`
- [x] 3. awf-lab runs every trial in the workspace's sandbox
- [x] 4. Live: other workflows under a run sandbox, and awf-lab on real cases

## Task details

### 1. The reviewer's repository laid out as its clone was

Asked for by the user during the first design: "for the review agent, it should be given a git repo
(same as it works for real)". `restore({ base })`, the default branch checked once, real scratch
paths. Tested in `collect.test.ts` ("lays the repository out as the reviewer's clone was") and
`tests/review-lab.test.ts` ("a clone that names no default branch fails before anything runs").

### 2. `awf run --sandbox`

Done when the engine's tests show: agents that name no sandbox share the run's, at the run's `cwd`,
opened once even when they open at once, closed last; `sandboxes.open` and an agent's inline sandbox
are refused; a spec that can't open fails the run before the workflow starts, as no
`WorkflowRunError`. The CLI's tests show a missing file, one that isn't an object, one naming `cwd`
and a repeated flag are usage errors, and a sandbox that can't open leaves no `output.json`.

### 3. awf-lab runs every trial in the workspace's sandbox

Done when `tests/review-lab.test.ts` shows each trial's run is given `{ read: [its request], srt: {}
}`, a workspace's `docker` setting reaches it, and a scorer's run has none; and that trials in the
first formats, which ran in no sandbox, still read but are run again, `report` saying why. The
first design's leak check, the trial's `leaks`, its report and show paths, and the examples'
`--sandbox` flags are gone.

### 4. Live

Done when non-review workflows run under a run sandbox, a probe in it is denied everything but the
checkout and the request, and awf-lab scores real cases with codex and claude variants.

## Verification

Automated:

- [x] `bun test`: 837 pass, 2 skip, 0 fail
- [x] `bun run check`: clean

Live, repeatable: `bun run eval run-sandbox run-sandbox-docker` (`tests/run-sandbox.ts`, its
checks unit-tested in `tests/run-sandbox.test.ts`): both passed, 2026-09-29, ~$0.05–0.17 and ~$0.12–0.16 over four runs.
One run after round 2 failed on its own checks: codex records `wf result` as a command, and its
JSON quotes every other; each command is now matched from its start.
Experiments: see Implementation notes.

## Review record

### First design (2026-09-29)

The per-trial leak check and the examples' flags were reviewed by subagents and then replaced; what
their review changed that survives: the default branch checked once before anything runs, a stale
`origin/HEAD` refused, a clone lacking `base` told what to update, and `draft-key`'s scratch paths
made real. Not fixed: an MR aimed at a branch other than the default is laid out under the default
branch's name; the diff is right, and the fixture records no target branch.

### This design (2026-09-29)

Architecture and scope (a subagent read the diff against the story, the design, `permissions.md`
and AGENTS.md; code minimal, no leftovers of the first design, boundaries ok):

- `design/evaluation.md` still described the replaced config shape, an eager open, and the canary
  as a plan. Fixed.
- The lab README's diagram read as if `--sandbox` took the workflow. Fixed.
- Story 004's "no operator ceiling" not annotated. Fixed.
- The default-branch check was guarded by a predicate over the plan to save one `git` call. Fixed:
  always checked.
- Kept then, renamed in the next round: the engine's `encloses`/`ENCLOSED`.

Correctness and proof (a subagent traced the engine, ran the tests, 412 pass, and wrote probes: one
open for three agents at once, a failed open reaching every agent with no unhandled rejection, the
record listing a sandbox that landed as the run ended, `abandon` never closing the shared one):

- High: the run's sandbox opened lazily, so a missing srt, a docker daemon down or a bad image
  failed a run that had started. awf-lab would store that as the variant's failed trial and reuse
  it. Fixed: opened before the workflow starts; no record, run again. Live: a missing image ends
  the run before it starts, with no `output.json`.
- Medium: trials didn't record their sandbox, so stored unsandboxed trials, and trials under
  another provider, were reused. Fixed: `Trial.sandbox`, and only the workspace's counts.
- Low: an operator spec naming `cwd` got the inline-spec message about sharing a sandbox; a
  non-object spec or a repeated flag failed late or silently. Fixed at parse time.
- Low: no test of agents opening at once. Added.

### Round 2 (2026-09-29)

Two subagents: design and slop over the whole diff, and the tests and evals.

- The setup-time check named `bun test tests/sandbox-srt.eval.ts`, which runs nothing under
  `bun test`. Fixed: `bun run eval sandbox-srt run-sandbox`.
- `Trial.sandbox` added to `/2` without a new format, and recording the setting, not what it
  resolved to. Kept, and said so under How it works.
- The eval judged each command by the prober's own report, by position: a skipped or reordered
  command passed, and an agent could invent a refusal. Fixed: every command is read from codex's
  transcript, found by a mark, missing ones reported; home's refusal checked like the key's; the
  key checked to be on the host, so docker's "No such file" can't be a wrong path; a printed record
  counts as one left behind.
- No test of a trial under one provider not counting under another. Added, back and forth.
- Settings compared by `JSON.stringify`; now structurally. `report.ts` repeated `currentTrial`'s
  filter; now `whyNoTrial` in `plan.ts`. `scratchDir` duplicated in `draft-key.ts`; now one, in
  `fixtures/git.ts`.
- The engine's `encloses`/`ENCLOSED`/`openEnclosure` a second vocabulary; renamed to the run's
  sandbox. The CLI refuses `provider` too, each field with its own reason.
- Stale: `provider: "container"` in the design, `CANARY` in the eval, cost figures that disagreed.
  Fixed.
- Rejected: naming Braintrust in the design's table, flagged as a private name; it is the public
  eval product, named across the research notes.

### Round 3 (2026-09-29)

One subagent over the whole branch; nothing blocking.

- Ctrl-C or the deadline while the run's sandbox opened was rewrapped as a plain failure, so `awf`
  said "run failed". Fixed: cancellation and the deadline pass through; tested with a slow open.
  A provider's open takes no signal, so a stop waits for a slow one, a docker pull, to end.
- `score` said "no trial on file" and `show` "none on file" when trials existed under another
  sandbox. Fixed: `score` gives `whyNoTrial`, `show` says "none counted". A test that asserted old
  records through `show` passed on the key's text; dropped, the report's reasons prove it.
- Nits: the probe fixture's two result types, the docker eval's own cost in `testing.md`, the
  design doc's tense and its trial layout without `sandbox.json`. Fixed.

## Implementation notes

### Experiments (2026-09-29)

1. **What a restored checkout holds.** Two cases restored with `restore`, as `awf-lab` does:
   every object reachable from head (`cat-file --batch-all-objects` equals `rev-list --objects
   --all`, 109,699 and 111,997), one ref, `refs/heads/review`, no remote, no reflog, a plain local
   config, and nothing in `.git` naming the case or the data repository. The newest commit
   predates the snapshot. 2.7 s each.
2. **A reader sandbox in a checkout under `$TMPDIR`, srt.** One codex agent in `{ read: [request],
   srt: {} }`, working in a restored checkout, ran fixed commands: it read the checkout, its full
   history and the request, and was denied a sibling trial's scratch, `$TMPDIR` itself, the case's
   key, the clone, harness state and `https://gitlab.com` (proxy 403); no variable named GitLab.
   Git works, with Apple's shim complaining it can't write its cache in the denied temp directory,
   as `srt.local.test.ts` already notes. The record held every path real: `/private/var/…`. $0.08.
3. **The same under docker.** Everything denied as under srt, but the request, handed as
   `/var/folders/…`, was not found: docker mounts the real path only. $0.12.
4. **The repository laid out as a clone,** on three real cases, two of them with a base main had
   moved to after the MR branched (2 of the dataset's 33): `origin/main...HEAD` gives the same
   diff as `{base}...HEAD`, four refs (`main`, `review`, `origin/main`, `origin/HEAD`), no
   unreachable object, and the newest commit still older than the moment review started.

5. **Other workflows under a run sandbox** (`--sandbox` with `{ "srt": {} }`, cheap models):
   - `quick-check -- codex pi`: both right, $0.02.
   - `minimum-review/review-loop.ts` on its fixture: codex and claude reviewers, both completed,
     both in sandbox `run`, $0.11. The claude one needs `CLAUDE_CODE_OAUTH_TOKEN`, as any sandboxed
     claude does (story 004); without it the run fails at once, saying so.
   - `triage` (no agents, decisions only): ran as before.
   - `sandboxes`: refused at its first `sandboxes.open`, "every agent in this run runs in the
     sandbox awf run --sandbox gave it; a workflow cannot open its own".
6. **A probe in a trial-like run sandbox**: a restored-style checkout and request under `$TMPDIR`, a
   decoy trial beside it holding a key, spec `{ read: [request], srt: {} }`. One codex agent that
   named no sandbox ran fixed commands: it read the request, `git log` and `git diff
   origin/main...HEAD` worked; it was denied `~`, `~/dev`, `~/.awf/runs`, `~/.codex/sessions`, the
   decoy's key, `https://gitlab.com` (proxy 403) and writing the checkout; it could write its
   temp directory. The record lists one sandbox, `run`, with that spec. $0.25.
7. **awf-lab on real cases**, a scratch workspace over the data repository's datasets and clone,
   two variants of `single-agent-review` (codex `gpt-6-luna` and claude `claude-haiku-4-5`) on two
   cases, `--jobs 4`, scored by the panel: every trial's record lists one sandbox, `run`, holding
   its reviewer; the scorer's lists none. luna: 1 and 0 findings. haiku: 0 findings, and one trial
   failed "agent settled without an accepted result": its transcript shows haiku wrote the `wf
   result` command out as text instead of running it, a model failure, not the sandbox's. $1.36.
8. **The probe of 6 under docker**: the same denials (the decoy's key doesn't exist in the box; `~`
   is the agent's own seeded home), the checkout read-only, GitLab 403. $0.11.
9. **After the open moved to startup**: `quick-check` and `triage` ran as before; `{ "docker": {
   "image": "no-such-image:1" } }` ended the run before it started ("the run's sandbox did not
   open: docker: the image … is not here; pull it first"), with no record.

Known: git inside srt prints Apple's shim complaining it can't write its cache in the denied temp
directory (story 004 notes it); git works, but the noise is in every git command's output an agent
reads.
