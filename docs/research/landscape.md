# Landscape: other engines for workflows of coding agents

Checked 2026-10-08. This covers projects attempting what awf attempts: a programmable or declared
workflow whose steps are coding agents, preferably real CLI agents. It leaves out session managers
and kanban boards that run agents side by side with no workflow over them, such as Claude Squad,
Emdash, vibe-kanban, Conductor.build and Composio's Agent Orchestrator. For those, see
[`reading.md`](../reading.md#parallel-coding-agent-tools).

Archon, Smithers, Conductor, pi-crew, Bernstein, Symphony and the dynamic-workflow ports were read
from source: shallow clones in `~/dev/ref-repos`, read but not run. Star counts are from the GitHub
API on the same day. Dahrk could not be read.

## The short version

Archon, Microsoft Conductor and Bernstein each declare a graph in YAML. pi-crew and the ports of
Claude Code's workflow tool write it as a script. Smithers builds a static plan in Effect-TS. awf is
the only one where all of these hold together:

- The workflow is ordinary TypeScript and runs with its own control flow, not as a declared graph
  or a plan. pi-crew and the dynamic-workflow ports come closest.
- The workers are the vendors' own terminal agents at full strength, in a pane or headless. Archon
  and Conductor use vendor SDKs. Smithers' flagship agent is its own loop over model APIs.
- An agent returns a typed result through a command in its session, `wf result`. Every other
  project parses the agent's final text against a schema or relies on an SDK's structured output.
- A workflow's tests run on fakes. The others offer dry runs and stubbed routing checks.
- Workflows are evaluated against cases with known answers: `lab`. Only Smithers has anything
  close, as evals of its own product rather than a facility for workflow authors.

None of the five is a moat on its own. They are the seams this project chose, and the field has
mostly chosen the other way on each.

## Side by side

| | Authoring | Agents | Result to workflow | Resume | Gates | Budget | Tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **awf** | TS, ordinary control flow | claude, codex, pi, cursor CLIs in a pane or headless | `wf result` over the agent's connection | `--continue`: rerun from the top, stages matched by name | designed, not built (Stage 4 checkpoints) | accounting after the run, no ceiling | fakes via `workflow-testing`; `lab` |
| **Archon** | YAML DAG + expression language | Claude Agent SDK, `codex app-server`, Pi SDK | text splice `$node.output.x`; JSON Schema, SDK-enforced | `--resume` skips completed node ids | approval node with typed decision + rework | per-node USD, Claude only | `--dry-run --stubs` fixtures |
| **Smithers** | Effect-TS static plan (`Node.*`) | own API agent loop; Claude via SDK; CLIs as tool-less build targets | final text parsed and decoded; correction re-prompts | journal; step key = scope + ordinal + schema; rewind/fork/replay | typed human tasks, deadline | run ceilings, rebuilt from journal, fail closed | three levels on an in-memory engine; seeded-bug evals |
| **MS Conductor** | YAML + Jinja2 routes | Copilot SDK, Anthropic API, Claude Agent SDK | `output:` schema, recovery prompts | checkpoint on failure, `conductor resume` | `human_gate`, `questions` | `budget_usd` audit or enforce | `--dry-run`, event-log replay |
| **pi-crew** | `.dwf.ts`, ordinary control flow | `pi` child processes only | final text regex + TypeBox; `ok:false` on mismatch | reruns the script, restores only `ctx.vars` | mailbox, steering | token budget | prompt-only dry run |
| **Bernstein** | YAML phases and nodes | 50+ CLI adapters | janitor "completion signals" + phase artifact JSON | resume at first unfinished node; refuses a changed manifest | approval gates, role fences | budget halts in a hash-chained log | mock agents |

## Projects that meet the criterion

### Archon ([coleam00/Archon](https://github.com/coleam00/Archon))

23.6k★, MIT, TypeScript on Bun, very active. Pitched as "Dockerfiles for AI coding". Workflows
live in the repo at `.archon/workflows/*.yaml`.

- **Authoring.** Node kinds are agent (`prompt:` or `command:` to a markdown file), `bash`,
  `script`, `loop`, `loop_group`, `approval`, `halt`, `wait`, a child `workflow` with `fan_out`,
  and `include:` (`packages/workflows/src/schemas/dag-node.ts`). Edges are `depends_on` with
  `trigger_rule`. `when:` has its own expression grammar
  (`packages/workflows/src/condition-evaluator.ts`). Loops end on a sentinel string, a bash exit or
  a field. The authoring guide runs to about 3,400 lines: YAML has become a programming language.
- **Agents.** All run headless and in-process: the Claude Agent SDK `query()`, Codex as
  `codex app-server` over JSON-RPC, and Pi through its SDK.
- **Results.** `$node.output.field` is spliced into later prompts and shell commands as text.
  `output_format` is JSON Schema, enforced natively on Claude and Codex and re-asked up to three
  times elsewhere. Field paths are checked statically by `archon validate`.
- **Resume.** Explicit `--resume` skips nodes with a `node_completed` event and replays their
  outputs. `always_run: true` opts a node out.
- **Gates.** An approval pauses the run and asks on whatever platform started it (CLI, web,
  Slack). `decisions:` gives the gate a `{decision, text}` output later nodes branch on. On
  rejection, a rework prompt receives `$REJECTION_REASON`, and the run pauses at the same gate
  again.
- **Isolation.** A git worktree per run. Non-git folders run in Docker with a writable overlay,
  whose diff becomes an approval before it is written back. Agents run with `bypassPermissions`.
- **Cost.** Only what the provider reports, with no price table. Codex reports none.
- **Also.** A web console with a visual builder, Slack, Telegram and Discord adapters, GitHub
  webhooks, and macOS schedules with an overlap policy.

### Smithers ([smithersai/smithers](https://github.com/smithersai/smithers))

430★, MIT, TypeScript with Rust and Go, about 19k commits since 2026-01, most of them
agent-written. A 1.0 release candidate, not on npm, Linux and Node 26.4 only, with a hosted
product. The README undersells how different the code is.

- **Authoring.** `Flow.make` and `Action.make` in Effect-TS. A body is a pure function building a
  static plan from `Node.*` combinators. Results are `Planned` proxies, and computing on one throws.
  `Node.branch` stores both arms. Fan-out width is fixed when the plan is built. A list found at run
  time needs a new round, which the docs call a "trampoline".
- **Agents.** The flagship agent is Smithers' own loop over model APIs. The model writes JavaScript
  cells that run in QuickJS, and their only authority is `ctx.call(flow, input)`. Claude Code is
  also driven through the Agent SDK (`src/internal/ClaudeCode.ts`). In build targets, claude and
  codex run headless with no tools, the files pasted into the prompt
  (`build/build-cli/src/AgentSession.ts`).
- **Results.** The final text is parsed (whole-text JSON, then the last balanced block) and decoded
  against the schema. A mismatch spends a bounded correction re-prompt.
- **Resume.** A journal in SQLite or Postgres. A step's key is its allocation scope, ordinal and
  tier, with the schema folded in. The docs admit a change to codec behaviour does not re-key a
  step. Time travel covers rewind (compensate, restore the workspace), fork at a frame, and replay,
  with effects tiered as sealed, compensable or irreversible.
- **Isolation.** One sandbox seam with about 12 providers, from directory to Kubernetes, Daytona
  and Bubblewrap, each checked by `SandboxConformance` suites. Version control is jj, not git
  worktrees.
- **Budget.** Token, USD and latency ceilings per run, rebuilt from the journal so a restart gets
  no fresh allowance. A model with no price fails closed. Reaching the ceiling parks the run to ask
  for more.
- **Tests.** Topology, interpretation and execution levels on an in-memory engine, with scripted
  agents and judges. `evals/review-seeded-bugs` has 16 fixtures: 12 with one planted bug, 4 clean.

### Microsoft Conductor ([microsoft/conductor](https://github.com/microsoft/conductor))

469★, MIT, Python. "The orchestration layer consumes zero tokens."

- YAML agents with `routes` (Jinja2 conditions, first match wins), parallel and for-each groups,
  sub-workflows, and `script`, `set`, `mcp` and `terminate` steps.
- Agents are SDK or API calls: Copilot SDK, the Anthropic API, and the Claude Agent SDK
  (experimental). They are not CLI processes.
- Each agent declares an `output:` schema with recovery prompts. Context modes `accumulate`,
  `last_only` and `explicit` control what each agent sees. A parallel group fails as `fail_fast`,
  `continue_on_error` or `all_or_nothing`.
- Checkpoint on failure, then `conductor resume`. `human_gate` and `questions` steps. `budget_usd`
  in `audit` or `enforce` mode.

### pi-crew ([baphuongna/pi-crew](https://github.com/baphuongna/pi-crew))

55★, MIT, TypeScript, one maintainer, "developed almost entirely by AI". The closest in shape to
awf, but pi only.

- `.dwf.ts` exports `async (ctx)` with ordinary control flow: `ctx.agent`, `fanOut`, `pipeline`,
  `review`, `retry`, `phase`, `args<T>()`, `setResult`.
- Each agent is a child `pi` process, with an opt-in git worktree.
- Results are regex-extracted from the final text and checked with TypeBox. A mismatch returns
  `ok:false`.
- Resume reruns the script from the top and restores only `ctx.vars`. Completed agent calls are not
  matched, so skipping work is the author's job. It rejects `Date.now()` and `Math.random()` by
  checking the script's syntax tree.

### Bernstein ([sipyourdrink-ltd/bernstein](https://github.com/sipyourdrink-ltd/bernstein))

1.4k★, Apache-2.0, Python, one maintainer, beta. "Kubernetes for coding agents."

- A YAML DAG of phases and nodes (role, conditional `depends_on`, `retry.until`), or a goal mode
  where one LLM call decomposes the work and plain Python runs it.
- 50+ CLI agent adapters, each task in its own worktree behind a merge gate.
- A "janitor" checks completion signals (tests pass, files exist, lint) before anything merges.
  Failures go back on the queue.
- Resume starts at the first unfinished node and refuses if the manifest digest changed.
- Its README claims runs "replay byte-identically", which cannot hold for non-deterministic agents.

### Claude Code workflows

The `Workflow` tool built into Claude Code, a research preview since 2026-05. A JavaScript script
with `agent`, `parallel`, `pipeline` and `phase` runs in the background of a session. Subagents are
Claude only. The script itself has no I/O and runs only inside a Claude Code session. Resume reuses
calls whose prompt and options are unchanged. It is the most visible reference for the
script-as-orchestrator shape, and several projects port it to other agents:

- [xz1220/open-dynamic-workflows](https://github.com/xz1220/open-dynamic-workflows) (105★) spawns
  Codex, Claude Code, Gemini, OpenCode and Cursor CLIs, validates outputs against JSON Schema, and
  creates worktrees. Its README admits completed calls are not journaled, so a rerun starts over.
- [scasella/claude-dynamic-workflows-codex](https://github.com/scasella/claude-dynamic-workflows-codex)
  (325★) and [six-ddc/codex-dynamic-workflows](https://github.com/six-ddc/codex-dynamic-workflows)
  (23★) are ports to Codex, Gemini and Pi.

### acpus ([kelvinschen/acpus](https://github.com/kelvinschen/acpus))

40★, MIT, TypeScript. An orchestrator agent writes a TypeScript workflow of `step.agent` calls, and
the agents run over ACP (Claude Code, Codex, OpenCode, Pi, Kimi). Node state persists.
`retry --target {node}` reruns one node, and the run can pause for human input. Worth a closer read
if awf ever considers ACP as a harness transport.

### Dahrk

Not read. Search indexes describe `dahrkai/dahrk-node`: a hosted hub dispatches a deterministic
multi-stage workflow per Linear issue, over WebSocket, to a node on your machine. The node runs
Claude Code, Codex or Pi per stage, each in its own worktree, sequenced by plain TypeScript. Both
the repo and dahrk.ai return 404. Workflows live in the hub, not in your repo.

## Borderline and out

- **[OpenAI Symphony](https://github.com/openai/symphony)** (27.6k★, Elixir). A tracker
  dispatcher: one Codex session per Linear issue, configured by `WORKFLOW.md`. Its spec lists
  "general-purpose workflow engine" as a non-goal. Two ideas in it are worth keeping: a spec with
  a reference implementation, and a "proof of work" each run must produce. Baton and sortie are
  clones of it.
- **[Suraj1235/open-dynamic-workflows](https://github.com/Suraj1235/open-dynamic-workflows)**. A
  script orchestrator, but each `agent()` is one model API request, not a coding agent. Node
  identity is `sha1(workflow|phase|role|prompt)`. Budgets warn at 80% and stop at 100%.
- **[catlog22/Claude-Code-Workflow](https://github.com/catlog22/claude-code-workflow)**, archived
  and continued as maestro-flow. Its workflows are skills a host agent follows, so the orchestrator
  is an LLM.
- **Composio Agent Orchestrator**, now
  [OrchestratorInc/agent-orchestrator](https://github.com/OrchestratorInc/agent-orchestrator). A
  session manager whose "reactions" (CI failed → send to the agent) are lifecycle rules, not a
  workflow. The reactions themselves are worth noting for messaging.

## Worth borrowing

None of these is built, and each should be checked against [`foundation.md`](../foundation.md)
§10 first.

1. **Key a stage by its result schema** (Smithers). Fold a hash of the schema into stage matching,
   so `--continue` reruns a stage whose return type changed instead of reusing a stale result.
2. **An opt-out from reuse on `--continue`** (Archon's `always_run`). It is for stages that work by
   side effect, such as a download or a file write, whose stored result says nothing about whether
   the effect still holds.
3. **Budgets rebuilt from the run record** (Smithers). A continued run gets no fresh allowance. A
   model with no price fails closed rather than counting as free. Reaching the ceiling pauses the
   run to ask for more instead of killing it. Builds on `engine/src/accounting`.
4. **Conformance suites for the sandbox seam** (Smithers). Behavioural checks that every provider
   must pass: a file written reaches the process, a kill really stops the work, stdin is bounded.
   This finishes what [`reference.md`](../reference.md#unmined-work) already lists as half-applied.
5. **Gates that return a typed decision** (Archon `decisions:`, Smithers human tasks). An approval
   returns `{decision, text}` and a rejection's text feeds a rework step. Typed question kinds
   (confirm, select, json) with a deadline.
6. **A name for how a parallel group fails** (Conductor): `fail_fast`, `continue_on_error`,
   `all_or_nothing`, so authors stop reinventing it with `Promise.allSettled`.
7. **Lockdown flags for read-only agent calls** (Smithers): `--strict-mcp-config`,
   `--setting-sources ""`, `--no-session-persistence`, `codex exec --ephemeral
   --ignore-user-config`, and API credentials stripped from the environment.
8. **Seeded-bug fixtures with clean controls** (Smithers `evals/review-seeded-bugs`), and a scorer
   that matches a finding by line with a tolerance and reports severity calibration. Compare with
   [`review-fixtures.md`](review-fixtures.md).
9. **Overlay diff as a write-back gate** (Archon). Run a sandbox over a read-only mount with a
   writable overlay, and approve its diff before anything is written back.

## Rejected

- **A declared graph in YAML** (Archon, Conductor, Bernstein). Each one grew an expression language,
  composition forms and quoting traps to get the control flow TypeScript already has.
- **A static plan with proxy values** (Smithers). It needs fixed-width fan-out, stores both branch
  arms and needs trampolines for a list found at run time. That is the replay discipline
  `foundation.md` turned down, at a higher price.
- **Syntax-tree bans on `Date.now()` and `Math.random()`** (pi-crew). They only matter under
  deterministic replay, which awf does not do.
- **Parsing the agent's final text for its result** (everyone). `wf result` makes the result an act
  of the agent's session, not a guess about its prose.
- **Sentinel strings that end a loop** (Archon `until: COMPLETE`). Archon's own docs warn that a
  model which emits the sentinel while reasoning ends the loop early.
