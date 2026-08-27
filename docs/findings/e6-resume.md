# E6 — resume

The plan (abstraction 6) says a journal keyed on `(prompt, profile, call index)` is "weaker than a
pure-function script, and enough". The journal now exists — `../../experiments/_archive/journal.ts` — and the six replay
properties hold. "Enough" depends entirely on what the workflow is. For the workload this engine
was designed around, it is not.

Everything below is offline: fake backend, real `wf result`, real result layer, no agents started.

## What the journal cannot replay correctly

**1. A step whose real input is the working tree.** The key covers the prompt. It does not cover
what the agent reads once it is running. "Review the working tree" is a constant prompt, so a
resume after the code changed replays yesterday's review of yesterday's code and reports a cache
hit. Nothing in the result says it is stale and nothing a user can see distinguishes it from a
fresh one. This is exactly the 14-lens review fan-out — the workload the engine exists to carry —
and it is the worst case: silent, wrong, and on the main path.

**2. The script's own side effects run again.** A resume re-runs the script from the top; the
journal only skips agent calls. Every `git commit`, file write, MR comment and Slack post the
script performs happens a second time, on a run that replayed 100% of its calls. The sandbox made
this impossible by construction — no filesystem, no network, no clock in the script — and that is
the restriction being given up. Also silent.

**3. An agent's side effects are not replayed with its value.** A step that edits code returns
`"applied"` from cache while the edit is absent, which is precisely the situation a resume in a
fresh worktree creates. The script is told the work is done.

**4. Anything with a clock, a counter or a random value in the prompt caches nothing.** Every key
differs, every call re-runs, and the journal silently does no work at all. This one is at least
detectable: `runWorkflow` returns `{hits, misses}`, so a 0% hit rate is visible to anyone who looks
at it. Nothing currently looks.

**5. A fan-out whose admission order is not stable replays none of itself.** Keys chain, so the
position of a call is part of its key, and a slot pool that admits whichever call a freed slot
reaches first gives the same set of calls different positions on the next run. The answers are all
on disk and none of them are found. Wasteful rather than wrong — but abstraction 5 is a global slot
pool, so this is the default shape, not an edge case.

**6. Not in the key and arguably should be:** the harness version, an unpinned model (`harness:
"claude"` with no `model` replays across a model upgrade), MCP or tool configuration, and anything
in the pane environment.

### What it does handle

The obvious worry — a script whose control flow branches on a cached result — is fine, and tested.
The replayed value is identical to the live one, so the branch is identical, and if a branch does
produce a different prompt the key changes and that call runs live. The general rule: **a
dependency that travels through the prompt is covered; a dependency that reaches the agent any
other way is invisible.**

### The one cheap repair

Failure 1 is fixable without a durability layer: give `Step` a caller-computed digest of its
out-of-band inputs (`git rev-parse HEAD` plus a dirty-tree hash, a content hash of the files the
step reads) and put it in the fingerprint. That turns a silent wrong replay into a correct miss.
Failures 2 and 3 are not journal problems — they need an effect log and idempotent steps, which is
the durability layer the plan explicitly is not building. Until then the honest scope is: **resume
is for read-only fan-outs over inputs that are pinned in the prompt.**

## The six properties, and the mutation that breaks each

All in `../../experiments/_archive/journal.test.ts` unless noted. Every assertion was mutation-tested: the invariant was
broken and the named test watched to fail.

| | property | result | mutation that fails it |
|---|---|---|---|
| 1 | same script, same args, second run | 3 hits, 0 misses, 0 backend opens | never consult the cache |
| 2 | edit one step of four in the middle | 1 hit, 3 misses; backend sees exactly `b-edited`, `c`, `d` | drop the chain from the key (then `c` and `d` wrongly replay) |
| 3 | killed mid-call, then resumed | 2 entries on disk, 2 hits, backend sees `c`, `d` | write the entry before the call returns |
| 4 | a failed call is not cached | entries `[0, 2]`, the failure re-runs on resume | cache every outcome, not only `answered` |
| 5 | two identical calls in one run | two distinct keys, answers stay in order across the resume | key on the fingerprint alone, with no position |
| 6 | 12 concurrent calls, interleaved | 12 entries, 12 distinct keys, 12 hits next run | restore `run-dir.ts`'s read-modify-write append |

Property 6's mutation is defect 4 from [`code-review-1.md`](code-review-1.md), and it does drop
entries: the atomic append is load-bearing for the journal, not only for E4.

`../../experiments/_archive/journal-limits.test.ts` holds the six failures above as executable evidence — each is a
workflow that resumes cleanly and is wrong, or resumes correctly and saves nothing.

## How it works

`openJournal(runDir, run)` loads `journal.jsonl` from the run directory — the same directory the
calls, attempts and results already live in — and hands back a `call(step)` that either replays or
runs. `runWorkflow` wraps it so a script sees a plain `agent(step)` and cannot tell which happened.

The key is `sha256(previous key, position, fingerprint)`, where the fingerprint is the prompt,
harness, model, backend, schema and cwd, canonically serialised. Two consequences worth stating:

- **It chains.** The plan says "replay until the first hash that differs", and a per-call hash
  cannot do that — an unchanged step after an edited one would still match. Chaining makes the
  prefix boundary fall exactly where the change is, which is property 2.
- **It covers what goes in, not what comes out.** A call's key does not include the previous call's
  *value*. It does not need to: a value that matters to a later call reaches it through that call's
  prompt. That is also why failure 1 exists — a value that reaches the agent some other way never
  enters a key.

Position and chain are taken before the first `await`, so concurrent callers get distinct keys
rather than racing for one, and only `answered` is written: caching a `failed` would make a
transient Herdr error permanent for the life of the run directory.

The entry keeps the call id, so a replayed call still points at the `calls/<id>/` directory holding
the original turn — a replay costs nothing and still has a transcript behind it.

## Numbers

16 new tests, `bun test` reports 111 passing across 10 files, 0 failures. Nine mutations were run;
each was caught, and each of the six properties has a mutation that breaks it alone.
