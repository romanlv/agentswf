# Prior art: evaluating and improving AI code review

Checked 2026-09-25 for [story 005](../stories/005-review-fixtures.md) and the todos that follow it.
We read the code and data of the open benchmarks and frameworks, not only their papers. Vendor
numbers are the vendors' own claims.

The short version: nobody has built the whole thing. The benchmarks have fixtures and judges but
no variants or loop. The eval frameworks have matrices and logs but know nothing about review. The
industry teams tune in production, against what developers do with the comments. Our design takes
a piece from each, and a few things we do aren't done anywhere yet: a key that grows, a holdout per
variant, and comparing variants beyond noise.

## Review benchmarks

**[Martian Code Review Bench](https://github.com/withmartian/code-review-benchmark)** (MIT). 50
PRs, 173 known problems, each with a severity (low to critical) and a category (bug, security,
concurrency, data, api, perf, test gap, doc defect, style, speculative). No locations and no
record of where each problem came from. The judge first splits a review into single points, then
removes duplicates: two points are one "if a single code change would fix both", and when in doubt
they stay separate. Then it matches each known problem against the points. Its own methodology
says the key "caps at human performance" and punishes real finds that aren't in it; the fix is
planned but not built. It also has an online half that uses what developers changed after a bot's
review as the key.

**[SWR-Bench](https://github.com/ZZR0/SWRench)** (MIT). 1,000 PRs, half of them clean. A known
problem must meet five conditions: the PR introduced it, a reviewer other than the author raised
it, the discussion confirmed it, a later commit in the same PR fixed it, and all of that happened
before merge. An LLM drafts these from the PR timeline, then code checks the claims: the
introducing commit exists and predates the first comment about it. One judge call per PR labels
every finding and every known problem at once, and each known problem can be hit only once. Clean
PRs get their own prompt, where any claimed problem is a false alarm.

**[SWE-PRBench](https://github.com/FoundryHQ-AI/swe-prbench)** (MIT, data CC BY 4.0). 350 PRs;
the key is human review comments filtered by rules (not a reply, not style only, not a bare
question). The reviewer gets text only, at three context sizes, and more context made every model
worse. Its judge labels findings confirmed, plausible or fabricated, and says plainly: "Not being
in ground truth is NOT sufficient for FABRICATED." It stores the judge's prompt version and model
with every result, and checked the judge against a second one (κ 0.75). Each problem is also tagged
by where the evidence is: in the diff, in nearby code, or hidden.

**[c-CRAB](https://github.com/c-CRAB-Benchmark/dataset)**. Turns each review comment into a test
that fails before the fix and passes after. The strictest key, but only 234 of 1,313 comments
survive, and design or docs problems can't be tested this way. It drops comments that hand over
the fix verbatim.

**[AACR-Bench](https://github.com/alibaba/aacr-bench)** (Alibaba, Apache-2.0). The closest to our
process: six LLMs propose problems on top of the human comments, and over 80 engineers approve
them in three rounds. It records which model proposed each problem, and keeps the rejected claims
as a separate set. Its categories are security, defect, maintainability and performance, and each
problem is tagged by whether the diff, the file or the whole repository is needed to see it.

**CR-Bench** ([arXiv 2603.11078](https://arxiv.org/abs/2603.11078), no public code). Starts from
SWE-bench bugs and traces them back to the PR that introduced them. Labels findings as bug hit,
valid suggestion or noise, and reports useful findings against noise.

**What they give the reviewer.** Every benchmark that runs agents gives a full clone, later history
included, and a prompt asking the agent not to look. Our restore, holding only `head` and its
ancestors, is stronger.

## How industry teams measure their reviewers

- **They trust production more than offline sets.** The main number is how many comments get
  acted on. Google checks whether the comment's issue is gone from the submitted code (50%, of
  which a hand check found 80% real fixes). Atlassian counts comments whose lines change in the
  next commit (39% for its bot, 44% for humans). Uber re-runs its reviewer five times on the final
  commit and sees whether the finding is gone. Cursor has an LLM decide at merge time whether each
  flagged bug was fixed, and checked that against authors.
- **Offline and online rankings disagree.** Martian found it, CodeRabbit says so, and Atlassian's
  offline matching against human comments found a match on only 7% of PRs.
- **Noise is the main complaint.** Greptile audited its own comments: 19% good, 2% wrong, 79% nits.
  What worked, across teams:
  - dropping whole categories developers ignored (Uber dropped readability nits, logging and
    style; Google suppressed rules that weren't actionable, and useful comments rose from 54% to
    66%);
  - confidence thresholds per category and language (Uber, Google);
  - blocking comments that resemble ones the team downvoted before (Greptile: acted on went from
    19% to 55%);
  - several specific checks instead of one "is this useful?" check (Sourcery: the single check did
    nothing, four specific ones took usefulness from about 43% to 60%);
  - a verifier that tries to disprove each finding (Anthropic, Uber).
- **LLM judges of quality can be close to random.** Greptile's 1–10 severity score was "nearly
  random"; Atlassian's LLM correctness filter did little, and a small trained classifier did more.
- **What moved quality.** Cursor ran 40 experiments; many regressed, and the biggest gain came from
  one agent with tools and aggressive prompts, more than from parallel passes and voting. Atlassian
  found review guidelines in the prompt helped most, and ticket context only 1–3%. Augment and
  GitHub credit repository context and letting the agent look around.
- **Misses teach the most.** Cursor learns rules from comments human reviewers left on bugs its
  bot missed. Rules start as candidates, are promoted when evidence builds, and are turned off
  after steady negative feedback.
- **Vendor benchmarks are weak on their own.** DeepSource points out that vendors write benchmarks
  they win, 50 PRs gives wide error bars, and the same five repositories gave 82% or 45% recall
  depending on who ran it.

## Eval and optimisation frameworks

- **[Harbor](https://github.com/laude-institute/harbor)** (Terminal-Bench 2). A task is a folder:
  `instruction.md`, `task.toml`, an environment, and `tests/` and `solution/`, which enter the
  sandbox only when grading. Every trial records a content hash of the task and of everything the
  agent was given, so a result is tied to exact inputs. A job is agents × tasks × attempts, and
  keeps errors apart from failed attempts. It ships two sanity agents: `oracle`, which runs the
  known solution, and `nop`, which does nothing.
- **[Inspect AI](https://github.com/UKGovernmentBEIS/inspect_ai)**. Sample, solver, scorer and a
  rich run log. Repeats with a standard error clustered by sample, and can re-score an old log
  without re-running the agent. It has no idea of a variant beyond task arguments and a git
  revision. METR is moving to it.
- **[SWE-bench](https://github.com/SWE-bench/SWE-bench)**. An instance is repository, base commit,
  request and a separate answer (patch and tests): the same split as our fixture. It sorts
  environment failures from wrong answers after the fact. A variant is a free-text name, which
  makes runs hard to compare later.
- **[promptfoo](https://github.com/promptfoo/promptfoo)**. A matrix of prompts × providers × tests
  with repeats; every result row separates "failed" from "errored", and assertions carry weights.
- **[DSPy and GEPA](https://github.com/gepa-ai/gepa)**. The metric returns a score with written
  feedback, and the optimiser reads the feedback to propose changes. The validation set picks the
  winners, so it's part of tuning, not a holdout; if none is given, GEPA reuses the training set.
- **[Karpathy's autoresearch](https://github.com/karpathy/autoresearch)**. The agent edits one
  file; the evaluation is read-only; each try is a commit; a TSV logs commit, score, keep or
  discard, and a description. Equal score with less code counts as a win. It has no repeats and no
  noise check.
- **[OpenEvolve](https://github.com/codelion/openevolve)**. Records each candidate's parent, so
  the history is a tree. Evaluates in stages, cheap ones first, and only promising candidates go
  further.

**Is there a standard to adopt?** Not for the whole thing. Harbor's task folder is the most used
format for sandboxed agent tasks, and Inspect's log is the richest run log, but both are Python and
built around a single model answering, not a workflow producing findings. Better to borrow their
ideas and names than to depend on them.

## What we take

For the fixture format (story 005):

- Keep everything the reviewer must never see in one folder, `key/`, like Harbor's `tests/`: one
  rule for the sandbox instead of a list of files.
- Put what the reviewer reads in its own file, `request.md`, like Harbor's `instruction.md`.
- Record a content hash of each fixture in the set, so every score is tied to exact inputs.
- Tag each known problem with where it can be seen: the diff, the file, or elsewhere in the
  repository (SWE-PRBench, AACR). It shows whether a variant that explores the repository earns
  its cost.
- Check drafted keys mechanically before a person sees them, as SWR-Bench does: the raising comment
  is on or after the frozen version, the fixing commit comes after it, and every location exists.
- Write `mechanism` as the problem, never the fix, even when the comment spelled out the fix
  (c-CRAB).

For the scorer:

- One judge call per fixture, labelling all findings at once, so each known problem is hit only
  once and duplicates are visible (SWR-Bench, SWE-PRBench).
- Martian's duplicate rule: two findings are one if a single change would fix both.
- "Not in the key" is never enough to call a finding wrong (SWE-PRBench).
- Location is evidence for the judge, not a gate. A correct finding on a nearby line still counts.
- Store the judge's model and prompt version with every score, keep raw findings apart from
  scores, and re-score without re-running the reviewer when the judge changes (Inspect, Harbor).
- Written feedback with every score: what was missed and why. The loop needs it (GEPA).
- An `oracle` variant that returns the key's own problems, and a `nop` variant that returns
  nothing, as sanity checks on the judge (Harbor).
- When several strong variants agree on something the key lacks, look at it first (Martian).

For the runner and the loop:

- Identify a variant by a hash of its workflow, arguments and prompts, not a free name (Harbor,
  against SWE-bench's habit).
- Keep "the reviewer failed" apart from "the environment broke" (promptfoo, Harbor, SWE-bench).
- Standard error clustered by fixture, and a paired comparison against the current best.
- Try a variant on a small subset first, and run the full set only if it looks promising
  (OpenEvolve).
- A single agent with tools is a real contender, not only a baseline (Cursor).
- Anything used to pick winners counts as tuning. A variant's holdout is only what never influenced
  it, including keep-or-discard decisions (GEPA).
- Log each try as parent, change, score difference, interval and decision (autoresearch,
  OpenEvolve).

Later, once a variant reviews live MRs: measure how many of its comments get acted on, the number
industry trusts most, and feed confirmed misses from human reviewers back into the key.

## What we don't take

- **Tests as the only proof** (c-CRAB). Too few problems survive, and design, docs and slop can't
  be tested.
- **Diff-only input** (SWE-PRBench). Their finding that more context hurt was for text without
  tools; our variants can explore the repository. Worth measuring, not assuming.
- **Matching by line first** (AACR's ±1 line). It punishes a correct finding pointed at a nearby
  line.
- **Developer action as the whole key** (Martian online). It counts fixes made to please the bot,
  and misses good comments that were ignored. A person approves our keys for that reason.
