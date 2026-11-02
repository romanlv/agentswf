# Examples

Workflows to run from a clone of this repository, each with the page of the
[site](../site/) that explains what it shows. They import `@agentswf/contract/workflow`, the
workspace's name for what a workflow outside this repository imports as `agentswf/workflow`, and
never the engine or a harness: `bun run scripts/check-boundaries.ts` enforces it.

## Running one

From the repository's root, after `bun install`:

```sh
bun awf run examples/messaging/workflow.ts                  # a workflow, with its defaults
bun awf run examples/messaging/workflow.ts -- claude-pane   # its own arguments go after --
bun awf logs                                                # what the newest run did
```

`bun awf` is the repository's `awf`, so an example runs against the code beside it. Its options,
deadlines, nudges, where the records go and what the exit codes mean are on the site:
[Runs](../site/guide/runs.md), [Timeouts and nudges](../site/guide/timeouts.md) and
[Following runs](../site/guide/following-runs.md); [Harnesses](../site/guide/harnesses.md) says
which login each agent needs. A workflow file is trusted code: it runs with your filesystem and
process authority.

Most workflows are tested beside their file, every agent's answers scripted, through the real
engine, for free. `quick-check/`, `keep-alive/` and `sandbox-probe/` have no test, as they exist
to watch real agents, and `event-sketches/`' tests are placeholders until the sketches run. Run them
with `bun test examples`, or one folder's, `bun test examples/feature-delivery`.
Outside this repository `awf test` does the same; [Testing](../site/guide/testing.md) says how to
write one.

## The examples

### Patterns: one problem, one workflow

| Example | What it shows | Explained in |
| --- | --- | --- |
| `messaging/` | an implementer writes `slugify()`; a reviewer that knows a house style runs it, asks for each fix by message and checks again; `-- codex` (the default), `pi`, `claude` or `claude-pane` | [Review loop](../site/patterns/review-loop.md), [Messaging](../site/guide/messaging.md) |
| `feature-delivery/` | a ticket from plan to approved change, each step a stage: `-- {ticket}`, `--revisions {n}`, `--reviewer {name}={runtime}`; give it a `--run-root` outside the repository | [Plan, implement, review](../site/patterns/plan-implement.md) |
| `event-sketches/` | a run per merge request (`mr-review.ts`) and per Datadog case (`dd-case.ts`), each with the poller that sends it events; type-checked sketches, not runnable | [Review on event](../site/patterns/review-on-event.md), [Events](../site/guide/events.md) |

### Reviews

| Example | What it shows | Explained in |
| --- | --- | --- |
| `minimum-review/` | two reviewers at once, a correctness and a maintainability lens on claude and codex; `review-loop.ts` runs it on a path, `-- packages/engine/src`, the current directory by default, and `fixtures/` holds a target with a known defect | [Parallel and loops](../site/guide/parallel-and-loops.md) |
| `catalogue-review/` | a diff fanned out over a catalogue of lenses, each finding verified; a lens runs only when the diff touches its `paths` | [Parallel and loops](../site/guide/parallel-and-loops.md) |
| `single-agent-review/` | one agent reviews `--range` in one turn, with a pinned public review skill (`--skill owner/repo/skill@ref`) or none: the baseline richer reviews are compared with | [Parallel and loops](../site/guide/parallel-and-loops.md) |

### Agents and harnesses

| Example | What it shows | Explained in |
| --- | --- | --- |
| `quick-check/` | one agent per runtime named (`-- codex pi`) answers questions with known answers: a harness smoke test for a few cents | [Harnesses](../site/guide/harnesses.md) |
| `output-schema/` | the TypeBox-to-output-schema helper the examples share, with its type tests | [Agents](../site/guide/agents.md) |
| `compaction/` | one agent per harness compacted with a focus, then asked what it kept (`-- claude pi`) | [Agents](../site/guide/agents.md) |
| `fork/` | a worker forked per harness, compacted or not, and each asked what it knows | [Agents](../site/guide/agents.md) |
| `effort/` | one agent per harness switched to another effort, then another model | [Agents](../site/guide/agents.md) |
| `pane-layout/` | a lead in a tab of your workspace and two forked reviewers stacked beside it; run it from a Herdr pane | [Harnesses](../site/guide/harnesses.md) |
| `calling-session/` | the run takes over the agent session it was started from: `awf run --here`, from claude, codex, pi or cursor in a Herdr pane | [Calling session](../site/guide/calling-session.md) |
| `fork-caller/` | forks the session that started the run and asks the fork what it was working on | [Calling session](../site/guide/calling-session.md) |
| `tools/` | an agent closes backlog items through the workflow's own tools | [Tools](../site/guide/tools.md) |
| `sandboxes/` | a team of codex agents in one docker container, and a pi under srt that can read but not write; run it with `--cwd "$(mktemp -d)"` | [Sandboxes](../site/guide/sandboxes.md) |
| `triage/` | support tickets routed by a decision model, every answer with its probability; needs `OPENROUTER_API_KEY`, opens no agent | [Decisions](../site/guide/decisions.md) |

### People, time and events

| Example | What it shows | Explained in |
| --- | --- | --- |
| `approval-reminders/` | a doc waits for approval, with a reminder an agent drafts on a timer, until it is approved or expires | [People](../site/guide/people.md), [Events](../site/guide/events.md) |
| `nudges/` | a question for a person, nudging on a schedule kept in a file, until it is answered | [Timers](../site/guide/timers.md) |
| `keep-alive/` | a claude kept alive between events, compacted when its window passes, woken by the next | [People](../site/guide/people.md) |

### For awf's own checks

- `sandbox-probe/` and `skills-probe/` are what the sandbox and skills evals drive; they take
  their plan from the eval, not by hand.
- `log-color-check.workflow.ts` logs two lines and opens no agent.
- `site/` holds the site's own samples, each at its page's path, tested as the examples are.

A file `awf run` takes default-exports its workflow. `minimum-review/workflow.ts` and
`catalogue-review/workflow.ts` export the function that makes one instead, for an entry point that
names its own models or catalogue.
