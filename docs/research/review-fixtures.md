# Review fixtures: what the sources give us

Checked 2026-09-25 for [story 005](../stories/005-review-fixtures.md). The data is private, so this
page has counts only: no code, comment text or names.

## GitLab and git

All counts come from one private GitLab project. We looked closely at six MRs, and at the version
list of all 72 MRs that an earlier AI review kept notes on.

- **Old commits can still be fetched,** including ones that were force-pushed away. All 78 missing
  ones came back in one `git fetch` taking 2.3 s. But GitLab keeps no ref to them, so they may
  disappear.
- **Most MRs were rebased.** In at least 48 of 72, an earlier version's commits aren't in the final
  history.
- **GitLab deletes old diffs after a merge.** 589 of 651 versions of merged MRs no longer have their
  diffs. Git is the only reliable source for the code.
- **Comments move.** GitLab shows a comment on the newest version where its line still exists, and
  doesn't keep the original line. You can work out which version a comment was written on only from
  its timestamp, or from a marker in its text.
- **The description as it was at any point can be recovered,** but only through GraphQL
  (`notes { systemNoteMetadata { descriptionVersion { description diff } } }`). The REST endpoint
  returns 404.
- **GitLab notes when a later push changes a commented line** ("changed this line in version N").
  That's useful but not reliable. It misses fixes made in another file, and once it named the wrong
  version.
- **"Resolved" means nothing.** Every thread we sampled was resolved.
- **Accounts don't tell you who wrote a comment.** The AI review posted from a human account, and
  one deleted account posted for three different bots.
- **Source branches are deleted,** and squash merges leave the final commits off `main`.
- **Fetching is cheap:** three API calls per MR, each under two seconds.

## The earlier AI review's notes

The project's earlier AI review kept a markdown file of findings per MR. The counts come from a
script, so treat them as approximate.

- There are 96 files with 1,296 findings, covering 76 MRs.
- **88% of findings were raised by the AI review itself.** People raised 88 findings and bots 43.
  Only 10 files have two or more findings raised by people.
- Most findings give a file and line (79%) and, when fixed, the fixing commit (80%). Only 40% link
  to the GitLab comment.
- The files get edited after the fact. The SHAs at the top are overwritten on each pass, and 9% of
  findings no longer say what went wrong.
- 31 findings were rejected, and only about 15–20 of them were actually wrong.
- **The checklists that review works from were written by studying older MRs.** The 36 usable MRs
  after those are ones that review never learned from, so they can test it fairly.

## Five fixtures built by hand

Stored in that project's own workflows repository. Four were merged and one was closed.

- 33 problems, 8 wrong claims, 54 comments left out. These are counts under the draft format, and
  will change when the fixtures are converted.
- Only 6 problems were raised by a person, and 2 of those by the MR's author. On one MR, every
  comment from a human account was AI text.
- The final description gave answers away in 3 of 5. Bot summaries were already in the description
  when review started in 4 of 5.
- Each fixture took 70–90 minutes by hand. Most of that went on judgement:
  - splitting comments into their separate points;
  - checking whether a problem raised later was already in the frozen code;
  - working out who wrote what.

## Other review benchmarks

- **SWR-Bench** freezes each PR just before its first review, and half its PRs have no problems.
  Its judge matches on a written summary of each problem, not the reviewer's words.
- **SWE-PRBench** keeps the answers in a separate folder from what the reviewer sees. Its judge
  labels each finding confirmed, plausible or made up.
- **Harbor** (Terminal-Bench) shows the answers only to the grader, never to the agent.

What we took from them: freeze the code at first review, keep the answers separate, match on a
description of the problem, and record why anything was left out.

## Grading

Checked 2026-09-25, for how serious a problem is, what kind it is, and how good a review's output is.

**Kinds of problem.** Studies of real reviews agree that most of what reviews find isn't bugs.
About three quarters are maintainability problems: structure, naming, docs
([Mäntylä & Lassenius 2009](https://aaltodoc.aalto.fi/server/api/core/bitstreams/cab054e8-0c06-47ab-8754-54bb09a0a6d3/content);
[Beller et al. 2014](http://sback.it/publications/msr2014.pdf)). At Microsoft, bugs were only 14%
of review comments ([Bacchelli & Bird 2013](https://sback.it/publications/icse2013.pdf)). Google's
review guide checks design, functionality, complexity, tests, naming, comments, style and docs, and
counts over-engineering as complexity
([eng-practices](https://google.github.io/eng-practices/review/reviewer/looking-for.html)). Review
benchmarks use similar lists: [Martian](https://github.com/withmartian/code-review-benchmark) has
bug, security, concurrency, data, api, perf, test gap, doc defect, style and speculative.
Our eight categories fold these together, and add `slop`.

**Severity.** Tools use three to five levels: CodeRabbit has critical, major, minor, trivial and
info; Martian low to critical; CR-Bench ([arXiv 2603.11078](https://arxiv.org/abs/2603.11078)) low,
medium and high. [Conventional Comments](https://conventionalcomments.org/) and Google separate
blocking from non-blocking, and mark optional points "Nit:". Conventional Comments also keeps the
kind of comment (suggestion, question, nitpick, praise) apart from whether it blocks. Our four
levels are named for what should happen to the MR, and map onto all of these.

**Scoring a review's output.** Everyone reports recall and precision. What differs is how they
treat findings that are true but not in the key:

- CR-Bench labels each finding a hit, a valid suggestion (true, but not in the key) or noise
  (wrong, irrelevant or trivial), and reports useful findings against noise.
- Martian scores only the categories a profile selects: Strict (bugs, security and the like), Core
  and All. A true finding outside the profile is neither rewarded nor penalised. It removes
  duplicates first, so the same point made inline and in a summary isn't counted as a false alarm.
- Google's static analysis keeps a check only if developers act on at least 90% of what it flags
  ([Tricorder](https://research.google.com/pubs/archive/43322.pdf)). That's a useful bar for wrong
  claims.
- Verbosity and nitpicking have no standard measure. Where they're measured at all, it's by rating
  (CRScore, [arXiv 2409.19801](https://arxiv.org/abs/2409.19801)).

**Slop.** [SlopCodeBench](https://arxiv.org/abs/2603.24755) measures how verbose and eroded code is,
and found agent code 2.3 times as verbose as code in 473 open-source Python repositories. It measures code, not reviews. We found
no benchmark that scores a reviewer on catching slop.

Vendor benchmarks (Greptile, Qodo) weren't checked independently.
