# Foundation

What this repository is, where it is going, what shape it has, and why — argued against the
repositories that already solved a version of this problem.

This is the argument, and it changes slowly. What exists right now, which stage is open and what
comes next is in [`status.md`](status.md). Decisions taken against this document since are in
[`adr/`](adr/README.md). The migration narrative this document once carried is in git.

> **Naming.** The project and the operator command are `awf` (`awf run`, `~/.awf/runs`). The
> command an agent runs inside its session is `wf` (`wf result`), and it stays short because every
> prompt carries it. The package scope `@wf/*` is still a placeholder; npm scope availability is
> unchecked.

## 1. What this is

An engine that runs **workflows made of coding agents**. A workflow is ordinary TypeScript: it
opens agents, gives them work, waits for structured answers, and composes the results. The agents
are real terminal coding agents — claude, codex, pi, cursor — driven through a configured session
host. Herdr is the first run host; provider-specific launch and continuation stay behind that host.
The workflow interface selects agent behavior and whether an agent runs in a pane or headless, not
which terminal or process topology provides it.

The distinguishing constraint is that the workers are **non-deterministic processes that bill money
and sometimes fail to answer**. That is not a normal task queue, and it drives most of what follows.

**The scarce resource here is design, not code.** A coding agent writes any of this competently and
fast. What it does not do reliably is pick the seams — notice that a result's authority has to ride
on the agent's connection rather than on a token the harness must deliver, that a checkpoint is not
a signal, that publishing `ReplayPolicy` commits the author surface to a durability model the
experiments rejected. Those three cost minutes to fix in a document and months to fix in a shipped
interface.

So completeness is not a goal of this repository, and feature count is not a measure of it. The
expensive artifacts are the ones that are hard to change once something depends on them: this
document, the author surface, the record formats, and the stage gates. The implementation behind
them is the cheap part. Two sections carry more weight than the rest because of that — section 10,
what is deliberately unbuilt and what would have to happen before it is, and section 12, where every
stage gate is phrased as something to *prove* rather than something to ship. `AGENTS.md` carries
this rule into the repository itself, so an agent working here optimizes for the same thing.

### Vision

**First, a runner people trust with real work.** The review workflows that run today by hand — a
two-reviewer feedback loop, a catalogue review fanned out over lenses, plan-implement-review
delivery — become workflow files someone writes once. The engine owns what those scripts learn one
failure at a time: confirmed delivery, one accepted answer per question, deadlines on every wait,
cleanup, and an honest record of what happened.

**Every run is measured.** Outcome, attempts, nudges, time, tokens and cost are recorded by the
engine, not by workflow code, so any two runs can be compared.

**Then, runs that improve runs.** An autoresearch loop in this repository searches over workflow
variants — prompts, models, harnesses, verifier limits — for better, faster and cheaper ones, and
scores them from the run record ([ADR 0002](adr/0002-autoresearch-lives-here.md)). It is a consumer
of the runner, not a part of it. Past that, the ideas in [`design/ideas.md`](design/ideas.md) point
at messaging between agents, human checkpoints, and eventually awf maintaining awf.

The order matters. Every later step leans on the one before being trustworthy, and a runner
shaped for an optimizer before it is shaped for people would optimize the wrong thing.

## 2. The evidence

The design is not speculative because of seven experiments, E1–E3 and E5–E7 (E4 is unrun), run
before any of the code here existed. Their raw rows are in `experiments/_archive/*/results/`, and
[`findings/README.md`](findings/README.md) keeps what is still live. Load-bearing conclusions:

- All three result channels work across the tested matrix — 480 trials, with a negative control
  that fails correctly. The measured conditions were narrow: short JSON, a trivial task, sequential
  execution, no blocked agents, pre-granted permissions. 4 of 480 needed a nudge to land; E3, which
  sends none, lost 4 of 80. **Delivery is feasible and needs a nudge policy — it is not "solved".**
- A pane on a subscription is charged to nobody *on the measured account*; `claude -p` bills
  metered even with no API key in the environment. E3 says the mechanism is undocumented and
  account-specific. Per sequential call that is $0 against ~$0.117 for claude. **The $0-vs-$1.64
  fourteen-way figure is fourteen times one sequential call, not a fan-out measurement**. Cost is
  still a first-class domain concern.
- Branching a session (fork, `/fork`, `/clear`) re-pays the context almost everywhere. Continuing
  it keeps the cache. Cold agents plus prefix caching beat forking in a pane by ~11x.
- Schema constraints must be in the prompt, not just in the validator: 0/160 first-attempt validity
  without, 80/80 with — headless, one schema. Field-level error text costs 2.00 attempts against
  2.90–4.95 for a bare refusal, worst case 11. The runner has sent the schema itself since
  2026-09-24, with the value in a quoted heredoc: 20/20 valid first answers on headless codex
  (story 002).
- A tool call returning success is not evidence the model received anything. Confirm from the
  transcript.

There is also working code **outside** this repository: `braintrust/agent/loops/review-loop/`,
with `agents/{herdr,liveness,queue,runtime,profile}.ts`, and the usage accounting it shares with
its sibling loops in `loops/shared/usage/{claude,price,recorder,records,store}.ts`. It is an
independent implementation of roughly half of what the harness package provides. Nothing here ports
it, but it is the best available reference for whether the seams are in the right place: code that
solved the same problem without knowing about them. Story 002 lifted its usage reader and price
table.

## 3. Survey

Six repositories were read — four for structure, two for a specific idea each: `earendil-works/pi`,
`openclaw/openclaw`, `sst/opencode`, `temporalio/sdk-typescript`, `inngest/inngest-js` and
`openai/openai-agents-js`.

They have their own file: **[`reference.md`](reference.md)**. One entry each, recording what was
taken, what was rejected and why, and what is still unmined — plus the local clone paths, so they
can be read rather than remembered. It is a standing input, not a one-time justification for a
layout: everything in it was originally read for **layout**, which is the easy question, and its
unmined list is what remains.

Section 4 is what changed *here* because of them.

## 4. What the survey changes

**Four of six repos put a `protocol` or `*-contract` package at the bottom of the graph.** The
poc1 code had an accidental version of this, mis-drawn: `cli.ts` imported `result-layer.ts`, which
imported `run-dir.ts`, so the agent-side binary reached into the run directory directly. What is genuinely shared there is a *format*, and that is the contract. The acceptance
gate and the directory I/O are engine implementation — see section 7.

**`src/` versus `packages/` is the anti-overbuild lever.** openclaw runs a 100-folder application
without making it a package. Extract to `packages/` what something outside will import; keep the
rest as folders.

**Evals do not need an application.** pi's evals are `.eval.ts` files, a reporter, and a summary.
That removes a whole package from the day-one plan; `trial.ts` and `runner.ts` become a reporter
plus a test config rather than an engine.

**Conformance tests belong with the contract — but only the pure ones.** E1 ran four harnesses
times two backends times two prompt sizes, three repetitions each: 48 runs, all successful
(`e1/results/e1.jsonl` has 48 rows; the report's "24/24" counts one prompt-size arm). Split that
inheritance in two. Pure adapter-contract assertions run against the fake backend and live in
`harness/testing` — no credentials, no cost, always on. The live matrix depends on installed CLIs,
Herdr, credentials and machine state, and it spends money: that is an opt-in `*.eval.ts`, not a
contract test, and it must not sit beside a zero-dependency package.

**Compiling a monorepo costs real ergonomics.** pi pays for it with a hand-ordered build chain.
bun runs TypeScript directly, so packages can export `src/index.ts` and skip the build entirely.
This is the single biggest velocity decision available and it costs nothing until something needs
to ship outside the repo.

**Cost accounting is a domain, not a metric.** No surveyed repo needed this, because none of them
pay per worker in two different currencies depending on how the worker was launched. E3's finding
means usage and pricing need a real home, not a `console.log`.

## 5. Decisions taken

- **`contract` is one package.** Subpath exports, not four packages. Revisit only if the boundary
  blurs in practice.
- **review-loop is out of scope for now.** It works, it stays where it is, and nothing in this
  repository ports it. The order is design, prototype, experiment, and only then consider replacing
  it. The seam should not foreclose that last step, but it is neither a gate nor scheduled.
- **No `telemetry` package yet.** Reasoning in section 7.
- **No `workflows/` directory yet.** Reasoning in section 8.
- Plain copy with a fresh initial commit; poc1 experiment scripts frozen in `experiments/_archive/`.

## 6. Proposal

### Layout

```
awf/
  package.json              # bun workspaces: packages/*, examples, experiments/*
  tsconfig.base.json        # + a root tsconfig.json that includes every workspace
  bunfig.toml
  AGENTS.md                 # and one per package directory
  README.md

  docs/
    foundation.md           # this file
    design/                 # the interface design notes — messaging, composition, the map
    findings/               # what the measurements settled; raw data in experiments/_archive/
    research/               # background reading behind a design note — input, not evidence
    reference.md            # surveyed repos: taken, rejected, still unmined, clone paths
    adr/                    # decisions taken later
    stories/                # complete deliverables, each decomposed into reviewed tasks

  packages/
    contract/               # pure: types, schema, record formats, the author surface. no I/O
    harness/                # drive a coding agent. adapters, liveness, usage extraction
    engine/                 # the workflow runtime, run-directory I/O, and local control plane
    cli-agent/              # the in-session `wf` binary; contract plus wire client only
    sandbox/                # sandboxes a workflow opens: the provider seam and the providers
    autoresearch/           # evaluating workflows against known answers; a consumer of the engine

  examples/                 # scenario workflows written against the author surface
  experiments/
    _archive/               # e1 e2 e3 e5 e6 scripts + raw results, frozen but runnable
    e4-concurrency/         # the one open measurement
  scripts/                  # check-boundaries.ts, and ad-hoc dev commands
```

`packages/cli-agent` is the fourth package. It was created only when the versioned wire boundary
and engine-owned local endpoint existed, as required below. `packages/sandbox` came with
[[004-sandboxed-agents|story 004]], so that neither harness nor engine holds a provider's code.

The justification for each package is that something outside it must import it.

### The packages

**`contract`** — **pure: types and pure functions, no I/O, no runtime-specific APIs.** That is a
sharper rule than "zero dependencies" and it is mechanically checkable. Formats live here; the code
that reads and writes them does not.

```
@wf/contract            core types
@wf/contract/schema     validate, describe, formatErrors — pure
@wf/contract/records    run-record formats (attempts, output.json, settled usage) and their version — not the file I/O
@wf/contract/wire       control-plane messages, with runtime-decodable schemas
@wf/contract/workflow   WorkflowContext, AgentRef, Messaging — what a workflow author imports
```

The JSON-schema subset, its validator, `describe()`, and the per-field error text (E5: 2.00 attempts
against 2.90–4.95 for a bare refusal). The author-facing workflow types. The control-plane messages
— and these need runtime-decodable schemas, not TypeScript types alone, because `cli-agent` is an
untrusted process boundary and a version-skewed or malformed request has to be rejected predictably.

**One production return channel, not three.** E2 measured all three and all three work, but the
accepted result now settles through the control plane, and write-a-file has the agent writing into
the call directory itself (`return-method.ts:35-43`, read back at `97-103`) — which contradicts the
engine being the only writer of the run record. `wf result < file` already covers the case
write-a-file existed for. The other two stay in `experiments/_archive/` as E2 evidence.

Two things that were in earlier drafts of this plan have moved out. **Run-directory I/O** —
`createRunDir`, `writeAccepted`, `recordAttempt` — is implementation and belongs to the engine,
which is the only writer; only the *format* stays here. **The conformance kit** moves to
`harness/testing`, for the reason in section 10.

**`harness`** — open one run-owned agent host, then open logical agents and operations inside it;
prompt them; inspect their normalized state; know when native work settled; read raw outcome and
usage evidence. Herdr is the initial host. Provider-specific Claude, Codex, pi, and cursor launch,
continuation, transcript, authentication, and usage behavior is composed inside the host rather
than selected as a per-agent terminal backend. Contains the provider-neutral launch table,
`command.ts`, host/provider adapters, liveness (from `agent_status`, per E1), `testing/` (the pure
conformance kit, run against the fake), and `usage/` — **extraction only**. Pricing and aggregation
are policy and live elsewhere; see section 8.

Placement is the agent's: `ExecutionConfig.placement` is `pane`, the default, or `headless`, and it
is part of the resolved agent identity and every usage record. A workflow chooses it because it
changes what an agent costs and how it can be continued: a headless claude is billed per token even
on a subscription (E3), so it also needs `metered: true`. Runtime aliases name a harness and model
only. This reverses an earlier rule that kept placement out of the author surface, so that two
logical peers could not use different lifecycle and observability models; the human asked for
per-agent placement in story 002. What remains of that rule: operator configuration still installs
one run host, and every logical agent crosses the same host interface. That host sends each agent to
the provider for its placement, and inspection, authority, deadlines, cancellation, cleanup, and
evidence stay symmetric. Swapping Herdr for another pane provider must not change workflow
definitions or runtime aliases.

One run host owns one terminal group and its final cleanup. Logical-agent handles own continuity;
each distinct operation receives fresh result authority and an operation pane. An initial prompt
and its one nudge are delivery attempts for the same operation, slot, schema, and pane.
A later operation may resume native context only when the host has measured continuation support
and terminal evidence; native session references never cross into workflow or engine-owned state
as resume authority. They cross only as accounting evidence, so the engine can read what an agent
spent from the harness's own files, and nothing resumes from them
([story 002](stories/002-cost-and-time-accounting.md)).
Durable result acceptance, client acknowledgement, and native release are distinct facts. An
accepted result may determine the author-visible answer, but the next operation is not admitted
until the prior pane is released or continuation is explicitly severed and failed closed.

A socket per agent provides routing for cooperative-but-fallible agents. The engine installs a
launcher that holds the socket and names its path in the prompt, so the connection says who is
answering and nothing secret has to survive the trip into a pane. It is not a security boundary
against mutually hostile same-UID processes: anything running as the engine's own user can run that
launcher, and access to process state or the Herdr control socket can cross panes. The connection
remains useful against stale commands and accidental cross-wiring, but adversarial confinement
requires agents in separate sandboxes: within one docker box, agents share a uid and can reach each
other's doors ([[permissions]]). Prompts that forbid delegation are spending guidance, not proof of
confinement.

Stage 0's concrete factory names still satisfy the smaller `AgentSessionDriver` interface used by
the frozen experiments. That compatibility seam stays out of production run hosting. Herdr and a
fake host satisfy the run-host interface; provider variation is internal composition, not another
choice exposed to workflows or the engine.

**`cli-agent`** — the command the in-session agent is told to run, through a launcher the engine
installs per agent. `wf result`, and later `wf peers` / `wf send`. It *compiles* against `contract`
alone, and at runtime it talks to the engine over the local control plane described in section 7.
It never links the engine and never touches the run directory itself.

It was deliberately absent through Stage 0. Stage 2 created it together with
`@wf/contract/wire` and the engine-owned endpoint, then removed the engine-linked binary. The
package now has a real boundary to uphold: it submits over the local socket and cannot reach the
run directory or engine implementation.

**`engine`** — logical-agent identity, alias resolution, queueing, idempotency, `parallel`, `steps`,
`signals`, usage collection, spend-pool admission, **all run-directory I/O, and the local
control-plane server**. Everything the interface map says the engine owns and the adapter does not.
Also carries the operator CLI as a `bin` until that grows enough to move to `apps/`.

**`sandbox`** — the sandboxes a workflow opens ([[004-sandboxed-agents|story 004]],
[[permissions]]). `@wf/sandbox` is the seam and path resolution; `@wf/sandbox/srt` and
`@wf/sandbox/docker` are the providers; `@wf/sandbox/testing` is the conformance suite and a fake.
It imports `contract` only. harness launches through the seam's types, the engine opens sandboxes
through it, and only the composition root, `engine/src/operator-runtime.ts`, imports a provider.
Tests in harness and engine may use `@wf/sandbox/testing`.

### Dependency graph

```
sandbox       → contract
harness       → contract, sandbox
engine        → contract, sandbox, harness    (a provider: operator-runtime.ts only)
cli-agent     → contract
autoresearch  → contract, engine
examples/     → contract/workflow
scripts/*     → any
```

Six rules. TypeScript will not catch any of them on its own — workspace packages are
symlinked into one `node_modules`, so anything can import anything and still typecheck — so they
are checked by `scripts/check-boundaries.ts`, which `bun run check` runs:

1. `contract` imports nothing, performs no I/O, and uses no runtime-specific API. If a file in it
   needs `Bun.*` or `node:fs`, it is in the wrong package.
2. `engine/src/accounting` imports `contract` only, performs no I/O, and uses no runtime-specific
   API, so it can be lifted out whole (section 8).
3. `cli-agent` imports `contract` only, and reaches the engine over the wire, never by linking.
4. `sandbox` imports `contract` only. harness and engine import its seam, `@wf/sandbox`, and their
   tests `@wf/sandbox/testing`; only `engine/src/operator-runtime.ts` imports a provider, and no
   provider imports another.
5. `autoresearch` imports `contract` and the engine's public entry only, never a harness; its
   review format stays pure outside the files that do I/O.
6. `examples/` and any future workflow import `@wf/contract/workflow` plus approved pure schema
   authoring libraries — never the engine or a harness.

A seventh rule falls out of the same check: a cross-package import has to be a declared dependency
in that package's `package.json`, not merely a symlink that happens to resolve.

### Mechanics

- **No build step.** Each package's `exports` points at `src/index.ts`; bun runs it. `tsc --noEmit`
  for typechecking, `bun test` at the root for everything. Add a bundler when something publishes.
- Inter-package deps as `workspace:*`; `typescript` and `@types/bun` pinned once in the root
  `workspaces.catalog` and referenced as `catalog:`.
- Everything `private: true` until there is a reason otherwise.
- `*.eval.ts` for anything that spends money, excluded from the default `bun test` run.

## 7. Where the roadmap lands

`ideas.md` says where this is going, so every item on it gets a decided home now even though
almost none get built now. A folder in the right package costs nothing; a feature arriving with
nowhere to go does.

| From `ideas.md` | Lands in | Decided now |
| --- | --- | --- |
| forking / compact without destroying the original | native primitive in `harness`; logical branch creation in `engine` | no fork in any interface until E7's cost split is settled — see [`findings/`](findings/README.md) |
| team of agents / messaging | cross-cutting all four, over a local control plane | the control plane exists from Stage 2, not "when remote execution arrives" |
| unified `skill:name` / `tool:name` | request and report shapes in `contract`; resolution in `harness`; downgrade policy in `engine` | model request-vs-granted; do not standardise the grammar yet |
| workflows calling workflows | `engine` | `contract/workflow` already has `call` |
| checkpoints and human approval | an `engine` admission barrier, not a signal | a signal suspends one branch; a checkpoint must stop dispatch |
| evals | `*.eval.ts` + a reporter | regression checks, not a system |
| autoresearch / self-improvement loop | `packages/autoresearch`, as a consumer of the engine — see below | the general tools here, a project's variants and fixtures in its own repository ([ADR 0003](adr/0003-autoresearch-tools-here-project-data-there.md)) |
| observability | shapes in `contract`, extraction in `harness` | see below |
| context usage / "dump zone" detection | `harness`, beside liveness and usage | per-harness reading, same shape as usage |

Three of these need more than a table row.

### Messaging cannot be one package

`ideas.md` says messaging can be its own package. Reading `messaging.md`, it cannot — not cleanly.
The feature spans every layer:

- route, envelope and obligation **types** — needed by everything
- `HarnessTurn.deliver`, presenting a message at the next safe model continuation — **harness**
- `wf peers`, `wf send --expect-response` — **cli-agent**
- the obligation state machine: atomic send ordering, crossing sends satisfying earlier
  obligations, refusing `wf result` while a response is owed — **engine**

The types go in `contract` and the enforcement in `engine`, the way openclaw names
`gateway-protocol` separately from the gateway.

**But a dependency rule is not a communication channel, and this plan was missing one.** `cli-agent`
is a separate operating-system process. `wf send --expect-response` has to block until the engine
says an obligation is satisfied; `wf result` has to be refused while a reply is owed; a crossing send
has to be ordered atomically against another process's send. None of that can be done by two
processes writing to a shared directory.

The POC gets away with it because one call means one session and the CLI reads and writes the run
directory directly through `WF_RUN` and `WF_CALL`. That does not survive concurrency, and the
current storage cannot substitute for a server: `writeAccepted` is an existence check followed by a
write (`packages/engine/src/run-dir.ts:54-62`), so two delayed invocations can both pass it.

So: **the engine owns a local control plane from Stage 2**, an authenticated local endpoint it
serves and `cli-agent` calls. Wire messages go in `@wf/contract/wire`, the
client is `cli-agent`'s internals, the state and transactions are the engine's. Remote execution
later replaces the transport without having to invent the boundary — which is why "client/server
split when remote execution arrives" was the wrong trigger.

The run directory does not go away. It stays the durable record an optimiser reads. The
socket is the control plane; the directory is the record; the engine is the only writer of either.

Messaging remains the most demanding test of whether the split is right. If it lands cleanly, the
seams hold for everything else on the list.

### Six defects in the author surface that the migration had to fix

These were faults in the designed interface, not in the packaging, which is why they were worth
finding here: the harness seam made adapters manufacture engine-owned identity; fork was on the
roadmap and nowhere in the interface; resume was shelved while its public types were not; a
checkpoint was modelled as a signal, which suspends one branch and lets every other branch, queued
turn, retained agent and spend continue; the acceptance gate checked existence and then wrote, so
"first accepted value wins" was not enforced against two delayed invocations; and nothing that
waited took a bound. Moving the files without fixing them would have set them in concrete, so all
six were corrected in place first; §12's Stage D entry records what each correction was, and
`docs/adr/` records any decision taken against it since.

### The consumers are the review workflows, and they exist already

The scenarios in `examples/` are called examples, but each describes something that runs today,
by hand, in `braintrust/agent`. Two of them now also run on the engine: `minimum-review` under
Story 001, and `catalogue-review` from an entry point beside its lens catalogue. `feature-delivery`
has not run.

| Scenario | Runs today as | Shape |
| --- | --- | --- |
| `minimum-review/` | `loops/review-loop/` | MR review, findings ledger, publication to GitLab |
| `catalogue-review/` | `air-code-review` under `mr-review` | fan-out over domain lenses, per-finding verification |
| `feature-delivery/` | `ticket-doc` → implement → `review-feedback` | plan, implement, review, revise until clean |

So the first consumer is one of the review workflows, and the ad-hoc one is the one to build first.
`review-feedback` is the smallest of the three, needs no GitLab, runs against the working tree, and
is already run several times a day.

This does not reopen section 5's decision, and the order matters. `loops/review-loop/` works; it
stays where it is and nothing ports it. What Stage 3 builds is a *prototype* of the same loop on the
engine — something to shape the tool against, experiment with, and find the design faults in while
they are still cheap. Replacing a working tool is the last step, taken only after that prototype has
earned it, and it is not on this plan's schedule. Building the prototype as a port target would skip
every step that makes it worth having.

### `review-feedback` is this engine's requirements document, written by hand

`.agents/skills/review-feedback/` is 349 lines of bash that opens two reviewer agents in herdr
panes, carries dispositions between them and the implementer for as many rounds as it takes, and
pings back when a round lands. It works. It also keeps `failure-cases.md`, a log of what went wrong
while running it — and that file independently rediscovered most of what this engine exists to
provide, from the other direction and without knowing about it.

That puts it on the same footing as the experiments rather than making it an anecdote. E1–E7
measured what a harness can be made to do; this measured what a real multi-agent loop needs and has
to hand-roll.

| Observed without an engine | What it is in this design |
| --- | --- |
| `herdr agent prompt` exits 0 having delivered nothing; two pings vanished and both printed `notified` | E7's finding, reached independently. Delivery is confirmed from the transcript, never from a return value |
| Herdr reports `idle` mid-turn, so the findings doc is the only signal `wait` can trust | Turn completion and result submission are separate signals — the result gate, not lifecycle state |
| The shell ate a round: a backtick inside a disposition was substituted away, silently | `wf result` takes argument **or** stdin, exactly one, with no shell in the path |
| Both sides idle looks identical to work in progress; a stalled loop surfaces only when a human opens the tab | The engine holds queue and admission state, so "waiting on nobody" is a state it can report |
| One reviewer pinging hides the other's silence indefinitely | `parallel` with a per-branch outcome, where `unanswered` is terminal rather than quiet |
| Derived agent names changed under running reviewers, stranding two of them | A stable `AgentKey`, owned by the engine |
| A round nobody receives, retried for 30s, residual left to the implementer | Durable queueing and an explicit nudge, with the attempt recorded |
| Convergence needs one place to look; with two docs, "both clean" is the implementer's bookkeeping | The run record |
| Reviewer-to-reviewer messaging stays out — no arbiter, no natural stop | Routes are granted by the workflow (`Messaging.allow`), never ambient |
| Only the implementer's adjudication ended a seven-round disagreement | The checkpoint `ideas.md` asks for, which section 7 argues is not a signal |
| A reviewer that ran out of context sits idle with its round lost | The context-percentage idea in `ideas.md`, and the reason it is there |

Two of those rows carry more than the others. The delivery row is a second independent observation
of the same failure, which is what moves it from a quirk to a property of the substrate. And the
messaging row is a *negative* requirement found by running the loop: the skill deliberately refuses
reviewer-to-reviewer routes because there is no arbiter and no stopping rule. An ambient message bus
would make that refusal inexpressible; granted routes make it a design choice.

The engine does not have to beat this script to be worth building. It has to make the same loop
something a workflow author writes once, instead of something a 349-line script learns the hard way
one failure at a time.

### Autoresearch is a consumer of the engine

Evals and autoresearch are two different things, and section 10's table used to collapse them.

**Evals** answer "does this still work". They stay here, in pi's shape: `*.eval.ts` files, a
reporter, a summary. No package, no application.

**Autoresearch** answers "which combination is better, faster or cheaper" — searching over workflow
design, models, harnesses, tools and skills for an optimum. Its general tools live in this
repository, in `packages/autoresearch`, and a project's variants and fixtures in that project's own
([ADR 0002](adr/0002-autoresearch-lives-here.md),
[ADR 0003](adr/0003-autoresearch-tools-here-project-data-there.md)). It is a *user* of the engine
rather than a part of it: it has a different lifecycle and a different failure mode, and it reaches the engine
only through the same programmatic entry point and run record any outside caller would use.

It is also the most demanding consumer on the list, which makes it the useful one to design
against. Four things follow, all cheap now and expensive later.

**Everything it varies must be injectable, with workload and provisioning kept distinct.** An
optimizer supplies runtime aliases and run policy programmatically. Harness, model, placement
(pane or headless), settings, skills, and tools are workload parameters. Terminal host/topology,
authentication route, funding pool, and admission are operator provisioning and accounting policy.
A workflow's `metered: true` only consents to the funding consequence of a placement; the route and
the pool stay the operator's. Both may vary per run without letting workflow code choose
infrastructure. The alias table and run policy are arguments to the
engine, not files it silently loads.

**The engine needs a programmatic entry point.** Run a workflow with injected configuration, get a
structured result. The operator CLI is a wrapper over that, never the only way in.

**The run record is a public format with an external reader.** An optimizer scores runs it did not
observe live: outcomes, attempts, nudges, timings, tokens, and both dollar columns, serialized and
stable. This is the strongest reason the run directory and its records live in `contract` — stronger
than the engine's own need for them — and it means changing that format is a breaking change, not
an implementation detail.

**Cross-repository consumption has to actually work when it comes, and no-build survives it.**
The loop itself no longer needs it, but `harness` and `contract` are meant to be importable by
tools outside this repository, review-loop included. Bun supports a
`bun` export condition for publishing untranspiled TypeScript, and `bun publish` packages `.ts`
sources — so compiled JavaScript is not required, *provided the supported public runtime is bun*.
That has to be a decision rather than something that becomes policy by accident.

Purity in `contract` does not prove distributability, and it was wrong to imply otherwise. It does
not catch a git dependency resolving the repository root instead of one workspace package, a wrong
`files` or `exports` map, an unresolved `workspace:*` in the installed artifact, an import that only
resolved because of the monorepo, or a file missing from the pack. And `contract` is not the whole
surface: an external consumer wants `harness` too.

The cheap test, run before the first outside consumer and not before: `bun pm pack` each
consumable workspace, install the tarballs into a throwaway bun project that is *not* part of this
workspace, and import them. If git dependencies are chosen instead, test that exact form. Compiled
JavaScript gets added only if a non-bun consumer becomes supported.

**On `trial.ts` and `runner.ts`.** poc1's README files them under throwaway measurement scaffolding.
They are not throwaway — a trial matrix over a variable space, jsonl results and report generation
is a first sketch of the autoresearch loop. They stay in `experiments/_archive/` as working prior
art to lift from, not as evidence to discard once read.

## 8. Telemetry and cost — a package, but not yet

The question is whether usage and cost deserve their own package, given that E3 made cost a
first-class concern rather than a metric.

Splitting the problem into three parts settles it:

**Extraction is harness-specific, as specific as the flags table.** claude writes usage into a
transcript JSONL where one API response appears as several rows sharing a `message.id` — E3 found
`e2/pane-cost.ts` double-counting because of it. codex and pi record per-turn usage on disk in
their own formats. cursor records none anywhere, and Herdr reports no session reference for a
cursor pane either, so there is nothing to look up even if it did. Whatever reads those files
belongs next to the adapter that knows which harness it is talking to — `harness/src/usage/`.

**The record shape is not harness-specific, and it is the expensive thing to change.**
`SettledOperation` lives in `contract` and records only what was observed: times, native sessions,
billing mode, tokens by model and token class, and a charge only where one was billed per token. If telemetry is
extracted later, the shape does not move and nothing downstream breaks.

**Pricing and aggregation are policy, not observation, and they do not belong beside the
adapters or in the record.** A rate card changes independently of any harness — the braintrust
loops already embed dated rates with an explicit basis (`loops/shared/usage/price.ts`). Prices are
applied when a run is summarised, so a run can be re-priced later with a different table, and the
summary names the table it used. Spend-pool admission is the engine's. Only extraction sits beside
the adapter.

**One cost field could not say which cost it was.** The earlier `TurnCost` was an amount plus
`charged | list | estimated`, which cannot tell a metered charge from an imputed list-price value or
name the price card behind it — and E3's whole finding is that those are different things. Story 002
replaced it: `charged` is what an API billed, the list-price `estimate` exists only in the run's
summary, and `billing` says whether the agent drew on a subscription or was metered.

What a package boundary actually buys is control over who may import something. Nothing here needs
that: the engine and ad-hoc scripts should both be able to ask what a run cost. A boundary would
not have prevented E3's double-count either — tests did that, and tests do not need a package.

**Where it sits meanwhile.** Session-file readers and billing in `harness/src/usage/`, handed to the
engine by the run host (`AgentRunHostFactory.accounting`), because how an agent is launched decides
who pays. Reading at run end and splitting spend between operations in `engine/src/run-usage.ts`.
Prices and the summary in `engine/src/accounting/` — pure, importing only the contract, and
exported so a finished run can be priced again; positioned to be lifted out whole. Spend-pool admission and budget enforcement are the
engine's proper. Nothing about pricing lives beside an adapter.

**When it fires.** Two producers — the engine will emit records the harness knows nothing about
(step start/end, agent open/close, admission waits) — and two consumers, the operator asking what a
run cost and the autoresearch loop learning from it. Story 002 brings the first consumer and the
second is next, so this is the trigger to watch.

One thing to carry regardless of packaging: the two dollar columns are not the same number, and the
difference is not currency — both are USD. A pane draws on a subscription and, on the measured
account, is charged to nobody; `claude -p` bills metered even with no API key in the environment.
The dimensions a cost record has to carry are **charge basis, funding pool, estimation basis and
rate-card version**. Without them it will silently report one as the other.

## 9. Explicit workflow files, not a catalogue

The scenarios in `examples/` compile against `@wf/contract/workflow`, may use a pure JSON Schema
authoring library, and never import the engine or a harness. TypeBox is the first such authoring
dependency: its inferred types and schema objects stay in the workflow package while contract owns
the supported subset, prompting, and validation. `minimum-review/workflow.ts` is the reusable
one-round definition, and `minimum-review/review-loop.ts` is its executable operator wrapper.
`catalogue-review/` exports `defineCatalogueReview`, and the executable entry point lives beside
the lens catalogue it reads, outside this package, because reading one is I/O. `feature-delivery/`
remains a typechecked design. An executable workflow default-exports the small author-side descriptor consumed
by `awf run`. The workflow may constrain an operator alias to an exact model when that choice is
part of its behavior; alias definitions, adapters, authentication, run-directory I/O, loading, and
cleanup stay in the operator and engine. The engine supplies the invocation working directory and
one enforced absolute run deadline through `WorkflowContext`; they are not domain arguments. The
operator derives that bound from `awf run --timeout` (thirty minutes by default). Expiry cancels active
agent work; shutdown has a separate fixed five-second grace so an uncooperative adapter cannot keep
the operator open. A configuration source for the run timeout remains a future operator concern,
not an author-surface addition.

Agent activation, turns, parallel collection, steps, signals, and child calls inherit that deadline
when the workflow omits one. A turn may instead give `timeoutMs`, which the engine resolves against
the current scope. This is author-side shorthand only: no engine or harness wait is unbounded.

`awf run <local-file>` is explicit loading of trusted code, not discovery. The named module runs
with the operator's filesystem and process authority before its export can be validated. There is
no registry, installed workflow catalogue, package-specifier loading, or `workflows/` deployment
surface. Add one only when multiple distributed workflows create evidence for its ownership and
lifecycle; executability alone is no longer the trigger.

Keep the top-level `examples/` package private and inside the typecheck and import-boundary gates.
Runnable examples also receive focused engine integration tests, while live agent execution stays
opt-in.

## 10. Deliberately not built yet

Each of these has a decided home (section 7) and stays a folder inside an existing package until a
named trigger fires.

| Not yet | Lives in for now | Extract when |
| --- | --- | --- |
| `telemetry` / accounting package | readers and billing in `harness/src/usage/`; run-end reading in `engine/src/run-usage.ts`; prices and summary in `engine/src/accounting/`; the record in `contract` | two producers and two consumers — the autoresearch loop is the second consumer |
| `messaging` state machine | `engine/src/messaging/`, types in `contract` | never as one package — see section 7 |
| skill/tool capability resolution | request and report *shapes* in `contract`, resolution in `harness/src/capabilities/`, fail-vs-downgrade policy in `engine` | two adapters demonstrate what is actually portable |
| context-usage reading | `harness/src/context/` | — |
| per-adapter packages | `harness/src/adapters/` | an adapter needs its own dependencies |
| journal / resume | shelved, **and its public types removed** | after deciding effect boundaries, persistence and versioning (E6) |
| fork | not built, **no capability flag** — [ADR 0001](adr/0001-unbuilt-interface-leaves-the-surface.md) | E7's cost split is settled |
| model settings | not built, **public types removed** — ADR 0001 | an implementation and a workflow that needs it land together |
| agent retention and crash recovery | not built, **public types removed** — ADR 0001 | pane release is measured (Story 001), then as for model settings |
| remote execution | not built — [[workflow-in-sandbox]] | the engine runs where the agents are, so the local control plane never crosses a network |
| TUI | not built | — |

The point of the table is that none of these need building now, and none of them get quietly built
because the directory existed.

**The tripwire on `contract`.** It holds schema, record formats, wire messages, the usage
record, messaging types and the author surface. Subpaths keep that navigable. The
original criterion — "two subpaths never imported by the same consumer" — was useless, because it is
already true: examples import `workflow`, the CLI imports `wire`, the optimiser reads `records`.
That is what subpaths are *for*. The real signals to split are a subpath needing a dependency the
others do not, a runtime constraint the others do not share, or a release cadence that has to differ
because something outside consumes it independently.

## 11. Integration story

The requirement is that pieces drop into existing work — the ad-hoc review and dev commands in
`braintrust/agent/.agents/skills/` today, `loops/review-loop/` some day — without adopting the whole
engine.

**Every package is independently useful, within a stated limit.** `harness` with no engine is "run
claude through a configured adapter, know when it settled, read the transcript and what it cost" — a raw session
outcome. It cannot on its own promise the engine's *accepted structured result*, because that
settles through the control plane; a standalone caller either takes the raw outcome or supplies its
own result sink. Saying otherwise would be promising the engine while claiming not to need it.
`contract/schema` with nothing else is "validate a model's JSON and tell it what is wrong in words
that work". An ad-hoc dev command is a file in `scripts/` that imports one package and runs under
`bun`.

`harness` has to be importable by something that knows nothing about workflows — an ad-hoc command
drives one harness, autoresearch drives many, review-loop eventually drives several — and none of
them should boot an engine to do it. Stage 1 tests that import deliberately rather than waiting to
find out it is awkward.

Cross-repository consumption adds one requirement the in-repo cases do not: what `harness` and
`contract` export has to be usable without this repository's workspace. See section 7.

**review-loop stays the eventual proof, and nothing should foreclose it.** It independently built
`agents/{herdr,liveness,queue,runtime,profile}.ts`, and with its sibling loops
`shared/usage/{claude,price,recorder,records,store}.ts` — the same job as `harness`, written
without knowledge of it. When it is ported, deleting both directories is the pass condition. Until
then it is a reference to check the seam against, not work to do.

## 12. Stages

Design comes before the move. The six defects in section 7 are interface faults, and an interface
fault is cheapest to fix while it is still a `.ts` file nobody imports — which is exactly what the
author surface is. Fixing them by writing the replacement implementation would be the expensive
order.

Each stage is a gate phrased as something to prove. Which are open is in [`status.md`](status.md).

- **Stage D — fix the interface, in place, as design.** The six defects were corrected in
  `packages/contract/src/workflow/`: `HarnessTurn.result` became a harness-local outcome;
  `ReplayPolicy`'s journal arm came out; checkpoints left signal semantics until an
  admission-barrier primitive is designed; fork got no public API; the acceptance gate's contract
  states atomicity; every waiting primitive resolves an inherited or explicit deadline, and a
  terminal operation keeps a distinct timed-out outcome. Unbuilt types have since come out too —
  [ADR 0001](adr/0001-unbuilt-interface-leaves-the-surface.md).
- **Stage 0 — skeleton and move.** poc1's tests pass unchanged in the new layout, and the boundaries
  hold. What the move decided that this plan had left open, and still stands:
  - `CallIdentity` survives only in the frozen experiments' compatibility surface. Result
    authority rides on a socket per agent, because a bearer token has to be delivered and no
    harness will promise to deliver one.
  - The record format carries `callId`, `question` and `schema`; `Attempt.source` is a string,
    because which channel carried a value is not something the format should enumerate.
  - The shelved journal is in `experiments/_archive/`, frozen but runnable. Stage 4 takes it out.
  - `AgentBackend` is deleted; `harness/adapter.ts` is the one seam for that job.
  - One shim is deliberate: `experiments/_archive/deps.ts`. The experiments are evidence, a package
    move should not mean editing evidence, and the shim imports public entrypoints only.
- **Stage 1 — prove the harness stands alone.** The adapter contract, the shared fake, the
  direct-process and pane adapters and the Herdr run host are tested without the engine. The gate
  is a small general-purpose command that drives one harness through `harness` alone.
- **Stage 2 — minimum engine and the control plane.** `agents.open/run`, `parallel`, result slots,
  `cli-agent`, the local endpoint and the workflow loader, proven against a fake and then live. An
  ambiguous Herdr `idle` decides nothing author-visible and authorizes no continuation: it reads as
  `unanswered` and arms the one measured nudge. Proving native pane release, and the continuation
  that would depend on it, is deferred measurement, not a claim this stage makes.
- **Stage 3 — measure and run something real.** Evals from E2/E5, a real workflow on the engine,
  accounting for every run, then **E4** — the one question never answered, and the only remaining
  measurement that changes the engine rather than confirming it.
- **Stage 4 onward** — messaging, composition, checkpoints, and only then the shelved journal.

Messaging in Stage 4 is the structural test: it is the one feature that touches every package,
and if it lands without moving a boundary, the split was right.

## 13. Open questions

1. **Names.** Answered for the project and both commands: `awf`, and `wf` inside a session (see
   the note at the top). The package scope `@wf/*` is still open.
2. **Author surface as a subpath or a package?** Temporal makes it a package because the constraint
   is enforced by a sandbox. Here it is enforced by discipline, so a subpath is proposed — revisit
   if a workflow ever reaches past it.
3. **What is the first real workflow?** Answered: the ad-hoc review loop that `review-feedback`
   runs today. It is small, already useful, and fans out far enough to exercise `parallel`, the
   result gate and multi-round messaging. What stays open is its stopping rule — the existing skill
   ends a reviewer disagreement with the implementer's adjudication, which is a checkpoint, and
   checkpoints are Stage 4.
4. **Is bun the supported public runtime?** Answered for the current stage: yes. External consumers
   may be required to run Bun, and the repository does not promise compiled JavaScript or Node.js
   compatibility yet. Revisit that decision before publishing for non-Bun consumers; purity in
   `contract` alone does not settle pack contents, export maps, unresolved `workspace:*`, or the
   runtime requirements of `harness`.
5. **What must a run record carry so an optimiser can score it?** Cost and wall clock are
   already measurable. Quality is not — and whatever stands in for it has to be *emitted here*, or
   the optimiser will happily find the cheapest way to be wrong.
