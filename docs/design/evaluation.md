# Evaluation environments

Where an evaluated workflow runs, who builds that place, and how we know nothing in it can see the
answer. **Decided 2026-09-29: option A**, built by [[010-eval-isolation|story 010]]. The options and
the reasons are kept below.

Terms are the lab's ([`packages/lab`](../../packages/lab/README.md#The%20words)): a **dataset** of
**cases**, each with a **key**; a **variant** is the workflow evaluated; a **trial** is one variant
on one case; a **scorer** grades a trial against the key.

## The problem

Story 010's first design left the environment to the variant. Each review workflow took `--sandbox
srt|docker` and put its own agents in reader sandboxes, and awf-lab read every trial's record
afterwards and refused to score one whose agents could reach past the checkout and the request. It
worked: the live check scored the sandboxed variant and set the bare one aside. But it had the
ownership backwards:

- **Every workflow repeats it.** Each one needs a flag and the code to honour it, and a variant that
  forgets is only caught after it has spent money.
- **It is checked after every trial,** because nothing before the run guarantees it. A check that
  has to run every time is a sign the setup doesn't hold the property by itself.
- **The thing autoresearch should tune is the workflow, not its plumbing.** Isolation belongs to
  the suite, the same for every variant, so a variant is free to be anything.

The goal: the suite prepares one environment per trial, with the frozen repository and the request
in it and nothing else. The workflow runs in it without knowing, and the environment is proven
once, when the suite is set up, not after each run.

## What others do

Surveyed 2026-09-29. Every agent-eval system with an environment keeps it away from the solver:

| System | Environment declared in | Built and torn down by | Answer kept away by | Isolation verified by |
| --- | --- | --- | --- | --- |
| Inspect AI | the task, overridden per sample or on the command line | provider hooks: once per config, then per sample | `target` stays in Python; the scorer copies tests in afterwards | construction; `network_mode: none` by default |
| SWE-bench | per-instance spec, as layered images | the harness | tests exist only in a separate evaluation container | construction, plus git history sanitised after a leak |
| Harbor / Terminal-Bench | the task directory: Dockerfile, `task.toml` | the harness | `solution/` and `tests/` outside the build context, copied in afterwards or run in a separate verifier | construction |
| METR task standard | `TaskFamily`: `install`, `start`, `get_permissions` | the runner | task code in `/root`, the agent a non-root user, network limited to the LLM API | construction |
| OpenHands | the evaluation script | the evaluation script | scoring is a separate step | construction |
| Braintrust, promptfoo | suite config and hooks | the suite | `expected` is passed only to scorers | no sandbox |

Test runners solve the same shape without the secrecy. pytest's fixtures have scopes (session,
module, function), tear down after `yield` even when the test fails, are declared once in
`conftest.py`, and are *received* by a test, never built by it. Vitest's `globalSetup` and scoped
`test.extend` fixtures, bun's `preload` and Go's `TestMain` all follow the same pattern.

What carries over:

1. **The environment belongs to the suite and the case, never to the solver.** Nothing surveyed
   asks the thing under test to sandbox itself.
2. **By construction, not by inspection.** None of them checks runs for leaks. Where one leaked,
   they fixed the construction: TB1 moved `solution/` out of the build context, and SWE-bench
   stripped remotes, branches, tags and reflog from the checkout
   ([#465](https://github.com/SWE-bench/SWE-bench/issues/465): agents ran `git log --all` and found
   the fix).
3. **An allowlist of what goes in,** not "everything except the answer". TB1 leaked through
   `COPY . /app`.
4. **Grade elsewhere.** The key is never mounted where the solver runs; scoring has its own
   environment.
5. **Scoped lifecycle:** expensive things once per suite, the environment once per trial, teardown
   guaranteed and told whether the trial failed.
6. **Network restriction is the default, and no override silently drops it.** Inspect loses
   `network_mode: none` when an author supplies a compose file of their own.
7. **An environment that can't be provided fails loudly** rather than running unisolated
   ([inspect_harbor #188](https://github.com/meridianlabs-ai/inspect_harbor/issues/188) scored
   zeros silently).

awf-lab already does 2 for git (`restore` keeps only head's ancestry, with no remote and no
reflog: story 010, experiment 1) and does 4 (a scorer is a separate `awf run` in a fresh checkout).
Before story 010 it lacked 1, 5 and a setup-time proof.

## The lifecycle

The suite runs the same steps, with the same scopes as a test runner:

```text
suite  (once per awf-lab run)       check the workspace and the clone's default branch
trial  (once per variant × case)    prepare: {scratch}/checkout laid out as the reviewer's clone,
                                             {scratch}/request.md, {scratch}/sandbox.json
                                    run:     the variant's workflow, every agent in the sandbox
                                    collect: the record and the result
                                    dispose: always, even on failure
score  (once per trial × scorer)    a fresh checkout, no sandbox: a scorer reads the key
```

The design first had a **canary** here: before the first trial, a script run in one real
environment that must be denied the key, the dataset, other trials and every host but the models.
It was dropped (Decisions, 2); what proves the environment is the engine's and providers' own tests.

## What a review trial's environment holds

A sandbox spec lists what is allowed; the provider denies everything else and re-allows exactly
that. awf-lab writes the spec for each trial, `{ "read": ["{scratch}/request.md"], "srt": {} }`,
and passes it with `--cwd {scratch}/checkout`:

```text
{scratch}/                      a fresh temp directory per trial, by its real path
  checkout/                     the frozen repository: head on `review`, origin/main at base, .git
  request.md                    the merge request's request
  sandbox.json                  the spec, out of the sandbox's reach
```

As the run's record shows it, resolved:

```json
{ "cwd": "{scratch}/checkout", "read": ["{scratch}/request.md"], "write": [], "network": [], "srt": {} }
```

| | Allowed | Denied |
| --- | --- | --- |
| Read | the checkout with its `.git`; the request; system directories and the toolchain, so `git` and `rg` work | all of `~`: the dataset and its keys, the clone, harness state such as `~/.codex/sessions`, `glab`'s config; `/tmp` and `/private/var/folders` but this trial's scratch, so no other trial; every run directory |
| Write | the agent's own home, seeded with credentials only, and the sandbox's temp directory | the checkout, the request, everything else |
| Network | its harness's model API | everything else, GitLab included |

srt denies whole regions (home, temp directories, the run root) and re-allows the listed paths
inside them. docker mounts only the listed paths. Both, and the seeded homes, are story 004's,
verified by its conformance suite and `sandbox-*` evals. The checkout is read-only because a review
only reads; a variant whose agents build or run tests would need it writable, which is safe since
each trial's checkout is thrown away. That waits for a variant that needs it.

## Where the environment is declared

In two places: what a case needs, in code, and how it is provided, in the workspace's config.

- **The dataset kind** says what a case's environment holds. For reviews that is the checkout
  (read-only, laid out as a clone) and the request. This is code in `packages/lab`, because it is
  what a review case *is*.
- **`awf-lab.json`** says how it is provided: `"sandbox": { "srt": {} }`, the default, or
  `{ "docker": { "image": "…" } }`. Nothing else: a review needs no network beyond the models.
- **Not on the command line.** Inspect also takes `--sandbox` per run. Here the environment is
  part of what is measured, so every trial in a workspace shares it. A per-run flag would let two
  runs of one variant measure different things, and a report would mix them without saying so.
- **Variants say nothing.** A variant is `workflow + argv + read`, as today. Its agents open with
  no `sandbox` field, and the environment puts them in one.

That covers "configured once, not per workflow" without a published environment API.
`defineEnvironment`, with hooks for a new kind of case, waits for a second dataset kind:
[`foundation.md`](../foundation.md) §10's rule for not building ahead.

## Who holds the boundary: the options

### A. The run's sandbox: `awf run --sandbox {spec}`

awf-lab writes a sandbox spec for the trial (`read` the request, the configured provider) and
passes it to `awf run` with `--cwd` the checkout. The engine opens that one sandbox before the
workflow starts, so one that can't open fails the run before it counts as a trial, and every
`agents.open` puts its agent there. A workflow that asks for a sandbox of
its own is refused with a clear error, since a sandbox inside a sandbox isn't something the
providers do.

- **Reuses story 004 as it is:** providers, per-agent homes seeded with credentials only, the git
  protections, and the rule that a sandbox is either whole or doesn't open.
- **Small change:** one `awf run` flag, one place in the engine where an agent's sandbox is chosen,
  and one refusal.
- **A canary**, had one been kept, would need to run a command in the environment without a
  model: a new `awf sandbox exec`, or awf-lab driving the `srt` and `docker` CLIs with the same spec.
- **It covers agents, not the workflow's code,** which still runs on the host and could read the
  key itself (the `oracle` and `comments` controls do so on purpose). That's fine while people write
  variants, and not once autoresearch generates workflow code.
- **It reverses a story 004 decision.** Story 004 said "no operator ceiling … a ceiling can return
  later". This is that ceiling, for one run, and it becomes a published CLI surface. Nothing else
  in the design changes.

### B. The whole run in a container

awf-lab starts one container per trial, like SWE-bench and Harbor. The checkout is mounted
read-only, the request, the variant's file and the awf install are mounted, and the network is
limited to the model APIs through the docker provider's proxy. `awf run` runs inside it; so do its
agents, unsandboxed within the container.

- **Covers everything,** the workflow's own code included: the key isn't in the container at all.
  This is the only option that survives autoresearch writing workflows.
- **The canary is trivial:** `docker run` with the same mounts and the probe script.
- **Costs:**
  - an image holding bun, awf and every harness CLI, kept current;
  - credentials passed in: claude's token as an environment variable, codex's `auth.json` mounted
    read-only;
  - a container start per trial;
  - headless agents only, since panes need the host's terminal;
  - Docker Desktop on macOS.
  - The lab gets its first infrastructure to support.
- **Controls** that read the key (`oracle`, `comments`) need the dataset mounted: the environment
  would have a "control" form, which is a second thing to explain.
- **No engine change.** The boundary is entirely awf-lab's.

### C. The variant sandboxes itself and awf-lab checks every record (story 010 as built)

Rejected above: every workflow repeats it, and it's verified after the fact.

### D. The whole run under srt on the host

Rejected. awf-lab would have to rebuild the per-agent homes the sandbox package already builds.
Without them, `~/.codex/sessions` holds the operator's past work on these repositories, which is a
leak. Also, srt can't nest, so a workflow could never open a sandbox of its own.

## Comparison

| | A. run sandbox | B. run in a container | C. as built |
| --- | --- | --- | --- |
| Workflow changes | none | none | a flag in each |
| Checked | never per trial: the engine's and providers' tests | never per trial: a probe of the image | every trial |
| Covers the workflow's code | no | yes | no |
| New surface | `awf run --sandbox` (published) | none in awf; an image in the lab | `--sandbox` on each example |
| Reuses story 004 | all of it | the proxy only | all of it |
| Runs on | srt or docker | docker | srt or docker |
| Cost per trial | as today | plus a container start | as today |
| To support | a flag and a refusal | an image, credentials, mounts | a check and its record field |

## Recommendation

**A, with the lifecycle, declared in `awf-lab.json`; built.** It is the smallest change
that makes isolation a property of the setup. It reuses everything story 004 built and verified,
and it removed code rather than adding it: story 010's first per-trial check, the `leaks` field,
and both examples' `--sandbox` flags went. What stays from story 010 is the repository laid out as
the reviewer's clone, the real scratch paths, and the default-branch check.

**B when autoresearch starts generating workflow code.** That is the point at which the workflow is
no longer trusted, and only a container covers it. The lifecycle and the config above
don't change; a `container` setting beside `srt` and `docker` becomes another way to hold the same
environment. The trigger
is named so it isn't forgotten.

## Decisions

1. **A first** (the user, 2026-09-29).
2. **No per-run canary.** The run's sandbox is opened by the same engine and provider code as every
   sandbox, which the engine's tests, the providers' conformance suite and the `sandbox-*` evals
   already prove; a canary would need a new `awf sandbox exec` or a second translation of the spec
   in awf-lab, to re-prove the same thing. The setup-time check is `bun run eval
   sandbox-srt run-sandbox` on a new machine or a new srt. Story 010's live probe showed it end
   to end.
3. **A workflow's own sandbox is refused,** not narrowed to fit: no variant needs one.
4. **One environment per trial.** No variant's leftovers reach another.
5. **Config only, no command-line override.** The environment is part of what a trial measures.
