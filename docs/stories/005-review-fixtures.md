---
id: "005"
title: Replay old MRs as review tests with an answer key
summary: Define the format for a review test — an old merge request frozen at the moment review started, plus the real problems found in it, graded — and the tools that build them; the data itself lives outside this repository.
type: story
status: done
discovered_in: "autoresearch planning, 2026-09-23 (was todo/historical-review-fixtures)"
depends_on: []
---

# Replay old MRs as review tests with an answer key

## Outcome

We want to know whether one way of reviewing code finds more real problems than another, with less
noise and at lower cost. For that we need examples where we already know the answers.

A **fixture** is one such example: an old merge request (MR; a pull request on GitHub) frozen at the
moment review started, plus an **answer key** of the real problems found in it, each graded by how
serious it is and what kind it is. We run a review on the frozen code, then check what it caught,
what it got wrong, and what it added.

This story defines the format and the tools that build fixtures from any GitLab project. The first
collector is for GitLab; the format names its forge, so a GitHub collector can follow. Fixtures live
outside this repository, because a project's code and review comments are usually private.

Why now: we record what a run costs (story 002), but not whether the review was any good. Three
planned pieces read this format, so it comes first:

- the scorer ([story 008](008-review-scorer.md));
- the sandboxing that hides the answers from the reviewer ([`eval-isolation`](todo/eval-isolation.md));
- the runner that tries review variants across many fixtures
  ([`variant-matrix-runner`](todo/variant-matrix-runner.md)).

## Scope

In: the format, its checker, `collect` for GitLab, `draft-key`, and a first set built and checked.

Out: scoring, handing a fixture to a reviewer safely, a GitHub collector, and bugs nobody raised
during review (they join the key later, see [[#From an MR to a score|From an MR to a score]]).

## What we learned

We built five fixtures by hand from one private GitLab project. Counts and details are in
[`research/review-fixtures.md`](../research/review-fixtures.md); the fixtures are in that
project's autoresearch repository. How other benchmarks, eval frameworks and industry teams
do this, and what we borrowed, is in
[`research/review-eval-prior-art.md`](../research/review-eval-prior-art.md).

1. **The final MR description gives answers away.** Authors add notes about the fixes, and bots
   paste review summaries in. So we use the description as it was when review started, with the
   bot text removed.
2. **GitLab forgets things.** It deletes old diffs after a merge, and it moves comments to the
   newest version. Old commits can still be fetched, but nothing promises they'll stay. So each
   fixture keeps its own copy of the code.
3. **A later fix doesn't prove the problem was there at the start.** Some problems were raised on
   later versions, and we had to check that they also existed in the frozen code.
4. **One comment often makes several points,** and each can end differently.
5. **Most known problems came from an earlier AI review.** That's fine: a real problem is real
   whoever raised it. But a key built this way misses what that review never looked for, so the
   key has to grow when a new reviewer finds something real.
6. **Building a key takes judgement.** A fixture took 70–90 minutes by hand, and most of that was
   deciding things, not fetching them.

## How it works

### A fixture

An MR is a branch that gets pushed several times. Review starts on one of those pushes, and the
author keeps pushing as comments come in:

```text
main ──●──●──●── base
                  ╲
                   c1──c2──c3 = head        ← the last push before the first review comment
                                  ╲
                                   v2 ── v3 ── … ── vN   ← later pushes, answering the review
```

A fixture freezes the MR at `head` and splits what it knows into two halves:

- **What the reviewer gets:** the code at `head` with its real history (`snapshot.bundle`), and
  the title and description as they read when review started (`request.md`). The change under
  review is the whole diff `base..head`, however many commits it took. The history lets
  `git log` and `git blame` work, as they did for the human reviewer. The bundle holds only what
  `main` lacks, so a clone of `main` plus the bundle restores it, even after the branch was
  rebased or deleted.
- **What only the key sees:** the later pushes (`key/fixes.bundle`), the raw comments, and the
  answer key itself. The later pushes are how we know a comment was right: the author changed the
  code it pointed at. They also show fixes nobody commented on.

A problem that only exists in a later push can't be found by reviewing `head`, so it isn't in the
key. It is recorded as excluded (`not-in-snapshot`), and a reviewer is neither credited nor
penalised for it. To test a later round of review, freeze the MR at that push as a fixture of its
own.

### From an MR to a score

```mermaid
flowchart TD
  MR[Old MR on GitLab] -->|collect| F[Fixture: frozen code + request]
  F -->|draft-key: an agent drafts, code checks, agents grade| K[Answer key]
  F --> R[Run a variant in a sandbox]
  V[Variant: a review workflow + its settings] --> R
  R --> FN[Findings]
  FN --> J[Judge labels each finding]
  K --> J
  J --> S[Scores: recall, wrong claims, noise, cost]
  J -->|an agent confirms new ones| K
```

1. **Build.** `collect` fetches an MR and freezes it at the version review started on. `draft-key`
   drafts the answer key from the MR's comments and fixes, code checks it, and blind agent graders
   settle each severity.
2. **Run.** A **variant** is one way of reviewing: any workflow, plus the arguments that configure
   it (models, prompts, checklists, how many agents). A single agent with a short prompt is a
   variant; a fan-out over many checklists with a verifier per finding is another. The runner
   restores the fixture in a sandbox, runs the variant, and turns its output into a common list of
   findings.
3. **Score.** A judge matches each finding to the key by what goes wrong, not by wording or line,
   and labels it. The labels are defined in [story 008](008-review-scorer.md).
4. **Grow the key.** A finding that's real but not in the key is labelled `new`. An agent
   confirms it, and it joins the key with the run as its source. Older runs are then re-scored
   against the new revision, so a variant that finds what the old review missed isn't penalised.
5. **Compare.** The matrix runner repeats this across variants and fixtures. Each variant records
   what it was tuned on. The fixtures it was never tuned on are its **holdout**: the fair test.

## Code map

- `packages/autoresearch/src/review/`, by purpose since story 008:
  - `format/`, pure: `format.ts` (the TypeBox schemas, the single definition of every file;
    `schema/` is generated from it by `src/write-schemas.ts`), `validate.ts` (the checks, including
    a key against its fixture and a key against its votes), `grading.ts` (the rubric and the vote
    rules), `schema-files.ts`;
  - `fixtures/`, reading and checking a fixture and a set: pure `set.ts` (the digest's input, and
    which fixtures a set keeps), `review-start.ts` (which push review started on), `threads.ts`
    (the comments as the drafter reads them), `gitlab-types.ts`; I/O `git.ts` (bundling, and the
    `restore` eval-isolation will reuse), `verify.ts` (checks a fixture folder end to end),
    `seal.ts` (writes and checks `set.json`);
  - `build/`, making fixtures from a forge: pure `description.ts` (the description as it read
    then, bot text removed); I/O `gitlab.ts` (`glab api`, read-only), `collect.ts`, `draft-key.ts`
    (the drafter and the graders' vote), and `fixtures.workflow.ts`, which runs collect and
    draft-key over a list of MRs, then seals the set.
- `packages/autoresearch/AGENTS.md`: the package's rules.
- `scripts/check-boundaries.ts`: rules for the new package; every file in `src/review/` is pure
  unless named as I/O, and each folder imports only those below it.
- `examples/catalogue-review/schema.ts` and `examples/minimum-review/workflow.ts`: two review
  workflows with different finding shapes; the first variants to read into `ReviewFinding`.
- `docs/foundation.md` §7, `AGENTS.md`, and
  [ADR 0003](../adr/0003-autoresearch-tools-here-project-data-there.md): where the package and the
  split are recorded.

## The design

### Where it lives

**Two places.** The general tools go in a new package in this repository. Everything about one
project goes in that project's own repositories: its variants in its workflows repository, its
fixture sets in its autoresearch repository.

- **`packages/autoresearch`** (this repository): the fixture format and checker, `collect`,
  `draft-key`, and later the scorer and runner. It's a package, not a folder, because a project's
  autoresearch repository has to import it to build and score its own fixtures. That's the trigger
  [ADR 0002](../adr/0002-autoresearch-lives-here.md) set for a package.
- **Why not all of it here:** a project's review workflow, its checklists and its data are that
  project's, and often private. They already live in its own repository, which imports awf's
  example workflows. Tuning them there keeps this repository free of any one project.
  ADR 0002 assumed the workflows being tuned would live here;
  [ADR 0003](../adr/0003-autoresearch-tools-here-project-data-there.md) records the split.
- **Not `contract`.** The engine never reads fixtures, and the format is specific to code review
  and will change a few times before it settles. It shouldn't be in the package every other
  package depends on.
- **A project's workflows repository**: its variants (its own review workflow and checklists).
- **A project's autoresearch repository**: its fixture sets (under `fixtures/{set}/`, versioned, so
  key changes have history), which fixtures each variant was tuned on, and any script that reads
  that project's own review notes into a fixture's evidence. It's apart from the workflows
  repository because a set is large, with each fixture's code in a git bundle, and is built and
  checked by its own agent sessions.

It starts optimised for code review. Two pieces are general from the start, because they don't
depend on what's being tested: a set of fixtures (`FixtureSet`) and a variant (`Variant`).

### Files

```text
<root>/<set>/
  set.json              which fixtures are in the set, their hashes, and which MRs were left out and why
  <fixture-id>/
    request.md          the title and description: all the reviewer reads
    snapshot.bundle     the frozen code (git bundle)
    fixture.json        where the MR came from and the frozen version
    key/                never enters the reviewer's sandbox
      key.json          the answer key
      fixes.bundle      the commits that fixed the problems, for checking later
      evidence/         the raw GitLab data the key came from (gitlab/), what collect decided
                        (collect.json), and votes.json: every vote behind the key
```

**The reviewer gets only `request.md` and the frozen code.** `fixture.json` names the MR, which a
reviewer could look up, so it stays out too, and so does everything under `key/`. The layout
follows Harbor's task folder, where the tests and solution enter the sandbox only for grading.

**The reviewer gets real history, up to `head` and no further.** It sees the project's history up
to where the MR branched off, and the MR's own commits up to `head`, with their real messages. That
is what a human reviewer saw at the time, and history helps: `git log` and `git blame` explain why
code is the way it is. Nothing after `head` is included, so later fixes can't leak. To restore it,
`snapshot.bundle` and a clone of the main branch are enough: build a fresh repository that fetches
only `head`, which brings `head`'s ancestors and nothing newer. When the MR's base isn't on the main
branch, the bundle carries the base's history back to where it joins.

### Grading

Every known problem gets a **severity** and a **category**. The scales follow what review research
and review benchmarks use (details in the [research note](../research/review-fixtures.md#grading)).

Severity says what should happen to the MR, not how bad the problem sounds:

- `must-fix`: merging it would do harm now: wrong behaviour users hit, a security hole, lost data,
  a broken build;
- `should-fix`: nothing breaks yet, but it will cost later: a poor design, missing tests, slop that
  others will copy. Fix it in this MR;
- `could-fix`: real but small. Fine as a follow-up;
- `nit`: taste or polish, like a name or a typo.

Review comments come in other shapes too: suggestions, questions, observations, praise. The key
doesn't record the shape, only whether the comment pointed at something that should change:

- **A suggestion** ("extract this into a helper") that the author took, or should have, is a
  problem, usually `design` or `maintainability`. One the author rightly turned down is a refuted
  claim; one that's just taste is excluded as `preference`.
- **A question** that exposed a problem ("what happens when this is empty?") is that problem. A
  question that only asked for an explanation is excluded as `not-a-claim`.
- **Observations and praise** are excluded as `not-a-claim`.

Category:

- `correctness`: logic, edge cases, concurrency, data, API contracts, resources;
- `security`;
- `performance`;
- `tests`: missing or wrong tests;
- `design`: the wrong abstraction, coupling, or a poor fit with the rest of the code;
- `maintainability`: code that is needed but harder to change than it should be: complexity,
  duplication;
- `docs-style`: naming, formatting, comments, docs;
- `slop`: code or text that shouldn't exist at all — dead or unneeded code, abstractions nobody asked for,
  comments that restate the code, defensive checks for things that can't happen.

`slop` is kept apart from `maintainability` on purpose. It's the kind we most want to track, and no
published review benchmark counts it.

The key keeps every real problem, nits too. The scorer decides what counts. For example, one
score might count only `correctness` and `security`, and another everything. Pure preferences
("I'd name this differently") aren't problems and go in `excluded` as `preference`.

### Types

```ts
/**
 * Where the MR came from, and the version review started on. The title and description are in
 * `request.md`, as they read when review started; this records how they were got.
 */
export type Fixture = {
  format: "awf.review-fixture/1";
  id: string; // "<project>-<number>"
  source: {
    forge: "gitlab" | "github";
    project: string;
    number: number;
    url: string;
    state: "merged" | "open" | "closed"; // a draft MR is an open one; sets use merged ones
  };
  snapshot: {
    version: number; // which push: 1 for the first, 2 for the second, and so on
    base: string; // where the MR branched off; the change under review is base..head
    head: string;
    at: string; // when that version was pushed
    start?: string; // GitLab's start commit, needed only to place comments back on GitLab
  };
  request: {
    asOf: string; // when review started (the first code comment), or later if the history couldn't be read
    removed: { by: string; what: string }[]; // bot text taken out of the description
  };
};

export type AnswerKey = {
  format: "awf.review-key/1";
  fixture: string;
  revision: number; // goes up whenever the key changes
  draftedBy: string; // "<harness>/<model>"
  procedure: string; // a hash of the drafting and voting instructions; an old one marks the key stale
  issues: KnownIssue[];
  refuted: RefutedClaim[]; // claims that turned out wrong; a reviewer repeating one is wrong too
  excluded: Exclusion[]; // comments left out, and why
};

export type KnownIssue = {
  id: string; // "K1"
  /**
   * What goes wrong, when, and what it causes. The judge matches on this. It describes the
   * problem, never the fix, even when the comment spelled the fix out.
   */
  mechanism: string;
  /** What a reviewer has to read to see it: the diff, the rest of a changed file, or other files. */
  visibleIn: "diff" | "file" | "repo";
  severity: "must-fix" | "should-fix" | "could-fix" | "nit";
  category:
    | "correctness"
    | "security"
    | "performance"
    | "tests"
    | "design"
    | "maintainability"
    | "docs-style"
    | "slop";
  scope: "change" | "context"; // did the MR cause it, or was it already in nearby code?
  /**
   * Lines in the frozen code (head), counted from 1, both ends included. Empty only when the
   * problem is something missing, like a test, and no line points at it.
   */
  locations: { path: string; start: number; end: number }[];
  /** How we know it's a real problem. */
  confirmation:
    | { basis: "fixed"; version: number; commit: string } // a later push fixed it; commit is on top of head
    | { basis: "accepted"; note: CommentRef } // the author agreed, but didn't fix it here
    | { basis: "verified"; how: string }; // traced in the frozen code by the drafter
  sources: Source[]; // every comment that raised it; at least one
};

export type RefutedClaim = {
  id: string; // "R1"
  claim: string;
  reason: "false-premise" | "not-a-defect"; // not-a-defect: what it describes is intended
  why: string;
  sources: Source[];
};

export type Exclusion = {
  sources: Source[];
  claim: string; // what the comment asserted, so a finding repeating it is recognised
  reason:
    | "not-in-snapshot" // only appeared in a later version
    | "unconfirmed" // couldn't be settled, or most voters didn't agree with the drafter
    | "preference" // a matter of taste, not a problem
    | "not-a-claim"; // praise, summaries, status updates, CI noise, questions that only asked
  detail?: string;
};

/** Where a problem came to light: a review comment, a later fix nobody asked for, or a run. */
type CommentRef = { discussion: string; note: number }; // ids in key/evidence/gitlab/discussions.json
type Source = CommentRef | { commit: string } | { run: string; finding: number };

export type FixtureSet = {
  format: "awf.fixture-set/1";
  name: string;
  builtAt: string;
  builder: string;
  /**
   * at: when review started (the fixture's request.asOf).
   * digest: "sha256:{hex}" over fixture.json and request.md; stored with every score.
   */
  fixtures: { id: string; at: string; digest: string }[];
  excluded: { project: string; number: number; reason: string }[];
};
```

`format.ts` defines all four as schemas, plus `collect.json` and `votes.json`.

**What the digest pins.** A score is comparable with another only if both ran on the same test.
The digest is a SHA-256 over `fixture.json` and `request.md`, as canonical JSON: the MR, its frozen
head and the request, exactly as the reviewer reads it. The frozen code is pinned by its head sha,
which fixes the tree and all its history, and the checker proves the bundle restores to it; so
re-bundling the same commits keeps the digest. The key is left out on purpose: it grows as runs
find new problems, and each score records the key's `revision` and `procedure` instead. Changing
what the digest covers needs a new set format.

**Sealing.** The builder ends every run by sealing the set folder: every fixture that passes its
checks and the set's rules (below) is listed with its digest, and every MR left out is listed with
why, including ones that never became a folder. A broken fixture stops the seal until it's fixed or
removed. `verifySet` checks a sealed set before anything scores against it: every folder is in the
set or excluded, and every fixture in it still passes, with the digest it was sealed with.

The variant and the finding are code, not files: a project writes its variants in TypeScript. They
are not built: the first readers are the scorer and the matrix runner, so they arrive with those.

```ts
/** One way of doing the task: any workflow, its arguments, and how to read what it returns. */
export type Variant<Args, Result> = {
  id: string;
  workflow: string; // path to the workflow file
  args: Args;
  read(output: unknown): Result;
  /**
   * Every fixture that influenced it: written from, tuned on, or used to pick it over another
   * variant. Given as fixtures from before a date, or named ones. The rest is its holdout.
   */
  tunedOn?: { before?: string; fixtures?: string[] };
};

/** A review variant: any workflow whose output can be read as findings. */
export type ReviewVariant<Args = unknown> = Variant<Args, ReviewFinding[]>;

/** The common shape every variant's findings are read into, so different workflows compare. */
export type ReviewFinding = { path?: string; line?: number; text: string; severity?: string };
```

### Why it looks like this

- **The reviewer sees only the title, the description and the code.** The answers, and anything
  that names the MR, stay out of reach.
- **`mechanism` is written fresh, not copied.** People describe the same bug differently, and
  often describe the fix instead. The judge matches on what goes wrong. The original words stay in
  the raw comments the sources point to.
- **A true comment is never marked wrong.** A correct comment about old code is a real problem with
  `scope: "context"`. The scorer decides whether those count.
- **The key keeps everything.** The scorer chooses what to count, without rebuilding the fixtures.
- **The key can grow.** A `run` source lets real problems a new reviewer finds join the key.
- **Holdout belongs to the variant, not the set.** Different variants are tuned on different
  things; one checklist may have been written from last year's MRs, another from none.
- **Every variant's output is read into one finding shape.** That's what lets a single agent be
  compared with a fan-out of twenty.

### The builder

- **`collect`** is plain code. It fetches the MR, its versions, its comments and its description
  history, picks the version review started on (the last push before the first code comment by
  anyone but the author; bots count), bundles the code, saves the raw data, and checks the folder
  before moving it into place. If a push landed just before the first comment, the later push is
  frozen: the key drafter then checks every problem is in that code.
- **`draft-key`** is where an agent does the work. It gets the frozen code with the later pushes
  beside it, the request, and every discussion with the push each note was written on. It checks
  each claim in the code, walks the later pushes for fixes nobody commented on, and answers with a
  key. One issue is what a single fix resolves, the same rule the scorer uses for duplicates. Code
  then checks the key against the fixture: every comment and commit it cites exists, every
  discussion with a non-author note is accounted for, every location is a file and lines in the
  frozen code, and every fixing commit is one the MR itself added in that push, not main's and not
  a rebased copy. A key that fails goes back to the agent with the problems.
- **Voting settles what code can't check.** No person is in the loop, and the drafter doesn't vote:
  it finds its own issues real. Three graders from two model families (by default codex
  `gpt-6-sol`, Claude `claude-sonnet-5` and codex `gpt-6-luna`), each in a fresh session in a
  directory holding only the code and the request, judge every issue (real? how severe?) and every
  refuted claim (wrong?). A "not real" or "wrong" vote must name the code fact, file and line. An
  issue stays only if most graders find it real, with their median severity; a refuted claim stays
  only if most find it wrong; the rest become `unconfirmed`, which counts neither way. A grader that
  skips, repeats or invents an item is asked once more, then fails the key. Every vote is kept in
  `key/evidence/votes.json`: how often graders agree is how we know the key holds.
- **Severity is a decision procedure, not a feeling.** `must-fix`: harm after merge with today's
  code and data that the base didn't have, with a named trigger. `should-fix`: a concrete, likely
  next trigger (a caller due to move onto the code, a value users can enter today, a pattern others
  will copy), or a changed behaviour no test exercises. `could-fix`: the trigger needs data
  validation already rejects, misuse, or contrived settings. `nit`: no effect on behaviour. A
  problem the MR neither causes nor worsens is `could-fix` at most.
- **`fixtures.workflow.ts`** runs both over a list of MRs. It never changes an existing fixture; it
  checks it and fills in what is missing. A key drafted under older instructions is reported
  `stale`; `--keys redraft` redrafts stale or failing keys.

Which MRs go in a set:

- merged MRs; open ones are allowed by the format, but not built for the first set;
- not closed MRs, whose problems were often never settled (`collect` still freezes one if asked;
  building the set leaves it out);
- not MRs where we can't tell which version review started on;
- not MRs whose key has fewer than two `must-fix` or `should-fix` problems the MR itself
  caused; this is checked after the key is drafted;
- not MRs still in draft, since nobody has reviewed them yet.

Every MR left out is recorded in `set.json`'s `excluded`, with why.

That last rule favours MRs that had a lot wrong. It also means there are no clean MRs, and the set can't count false alarms on code with nothing wrong. An MR
with no comments here usually means nobody looked, not that nothing was wrong. The format allows an
empty key, so clean MRs can be added once we have a way to know they're clean.

Rejected:

- **The format in `contract`.** The engine never reads fixtures, and the format will change.
- **One general format for any task.** Nothing but review needs one yet. The set and the variant
  are general; the rest waits for a second kind of task.
- **All of it in the project's repository.** The tools work for any GitLab project, and the scorer
  and runner need the same format.
- **The earlier review tool's notes as the main source.** They cover one reviewer and are edited
  after the fact. The MR's comments have everyone's.
- **Recording who raised each problem.** A real problem is real whoever raised it, and accounts
  often don't tell you anyway.
- **A fully automatic builder.** Each kind of judgement had an exception in at least one of the five,
  so an agent drafts and code checks what can be checked. For now no person is in the loop: where
  a judgement can't be checked in code, like severity, independent agents vote.
- **Agent judges inside `collect`.** It had two: which push a reviewer read when two landed
  close together, and which description text a bot wrote. On the five real MRs neither changed
  anything: no close calls, and every bot block was marked. Removed.
- **Adopting Harbor's or Inspect's format.** Both are built around one model answering a task, not
  a workflow producing findings, and both are Python. We borrow their layout and ideas instead.
- **Tests as the proof that a problem is real** (c-CRAB). Only a sixth of comments survive it, and
  design, docs and slop can't be tested.

## Tasks at a glance

- [x] 1. Build five fixtures by hand, and fix the draft format from what we learned
- [x] 2. Lock the format: the package, `format.ts` and its schemas, the checker, `set.json`, and
  ADR 0003; rebuild the five in it
- [x] 3. `collect`
- [x] 4. `draft-key`, compared with the five hand-built keys
- [x] 5. Build and count the first set

## Decisions

For the record; the design above is the current state.

- **Where it lives:** `packages/autoresearch` for the general tools; a project's variants in its
  workflows repository and its sets in its own autoresearch repository ([ADR 0003](../adr/0003-autoresearch-tools-here-project-data-there.md)).
  No separate design doc: `format.ts` is the single definition and this story holds the reasoning.
- **Grading:** the four severities and eight categories in [[#Grading|Grading]]. They're in the key
  format, so changing them means re-grading every key.
- **No person checks keys.** Code checks what it can; three graders from two model families vote
  on the rest, and every vote is kept. The drafter doesn't vote.
- **Severity is a decision procedure.** The first drafts graded 17 of 38 issues `must-fix`; a
  sharper rubric and the graders' median brought it to 6 of 37 on the five.
- **When review started:** the last push before the first code comment by anyone but the author;
  bots count, as later pushes answer them too. `asOf` is when review started, since that's the
  text the reviewer read. Comments are dated by timestamp only: GitLab rewrites their positions.
- **`collect` is plain code.** It had two agent judges; on the five real MRs neither changed
  anything, so they were removed.
- **Keys cover fixes nobody commented on,** found by walking the later pushes. A fix counts only if
  it's one of the MR's own commits that push added, not main's or a rebased copy.
- **The key carries a `procedure` hash,** so a changed prompt marks old keys stale, and a redraft
  takes the old key's revision plus one.
- **The set's digest** covers `fixture.json` and `request.md`, not the key; see
  [[#Types|What the digest pins]]. Pinning the key in `set.json` was rejected: the key is meant to
  grow without resealing, and every score records its revision.
- **The first set:** the 60 most recent merged MRs with at least five comments, !2091 to !2238,
  not counting dependency-bot MRs. About half are newer than anything the project's review
  checklists were written from.

Left for later, in the todos that need them: the `Variant` and `ReviewFinding` types (the scorer
and the matrix runner); clean MRs, which need a way to know an MR is clean; issue ids that stay
stable across key revisions, run-sourced findings copied into the key's evidence, and recall split
by who raised each problem (the scorer). A set holds one version per MR, since a fixture's folder is
named by its MR; testing a later review round would need that changed.

## The first set

Built on 2026-09-26 in the project's autoresearch repository. 61 MRs were considered: 60 merged
ones in a row, plus the draft set's closed one.

- **In the set:** 33 fixtures, with 264 issues, 37 refuted claims and 320 comments left out.
  - Severity: 28 must-fix, 82 should-fix, 118 could-fix, 36 nit. 227 were caused by the MR, 37
    were already in the code around it.
  - Must-fix or should-fix and caused by the MR, of which a set needs two: 110 in all, 2 to 9 per
    fixture, median 3.
  - Category: 166 correctness, 27 docs-style, 23 tests, 13 performance, 11 slop, 8 each of
    security, design and maintainability.
  - Visible in: 129 the diff, 42 the changed file, 93 only the wider repository.
  - Confirmed by: 237 a later fix, 18 the author accepting it, 9 traced in the code.
- **Left out:** 28. 26 had fewer than two serious problems the MR caused (15 none, 11 one), one
  was closed without merging, and one had no review from anyone but its author.
- **Agreement:** of 296 drafted issues, the three graders split on whether it was real for 74 and
  on its severity for 195. The majority voted 32 out; the median set the severity of the rest.
  Every vote is kept.
- **Cost:** two runs, the first stopped by awf's 30-minute default deadline and resumed with a
  longer one: 56 minutes, 226 agents, $41.99 at list prices. $13.26 was charged, all of it the
  Claude grader, which bills per token when headless.
- One draft failed its checks (every source cited a note that didn't exist) and passed on its
  second attempt.

## Verification

- `bun run check` (Biome, `tsc`, the boundaries) and `bun test` pass, 2026-09-26; the package has
  53 tests, each review fix among them.
- `draft-key` on the five, against the hand-built keys: every hand issue a comment raised was found,
  except one the drafter judged, twice, to be only in a later push.
- The first set: `verifySet` passes on it, 2026-09-26.

## Human review

Approved by the user, 2026-09-26.
