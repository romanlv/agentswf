# Foundation

What this repository is, where it is going, what shape it has, and why — argued against the
repositories that already solved a version of this problem.

This is the argument, and it changes slowly. What exists right now and what comes next is in
[`status.md`](status.md); what a user is promised is on [agents.wf](https://agents.wf). Decisions
taken against this document since are in [`adr/`](adr/README.md). Its history, the migration
included, is in git.

> **Naming** ([ADR 0005](adr/0005-published-as-agentswf.md)). The project is **agents.wf**. Its
> npm package is `agentswf`, and the repository is `romanlv/agentswf`. The workspace packages are
> `@agentswf/*`, each named for its directory: `packages/harness` is `@agentswf/harness`. A workflow
> imports the author surface as `agentswf/workflow`. The operator's command is `awf`, and
> everything it owns at run time keeps that name: `.awf/runs`, `AWF_*`, docker's `awf.*` labels,
> and `awf-lab`. The command an agent runs inside its session is `wfa` (`wfa result`), short
> because every prompt carries it, and a workflow names its context `wf`
> ([ADR 0013](adr/0013-the-agent-command-is-wfa.md)).

## 1. What this is

An engine that runs **workflows made of coding agents**. A workflow is ordinary TypeScript: it
opens agents, gives them work, waits for structured answers, and composes the results. The agents
are real coding agents — claude, codex, pi, cursor — in their own TUI in a terminal pane, or headless. Herdr is the
first pane host; provider-specific launch and continuation stay behind that host. The workflow
interface selects agent behavior and whether an agent runs in its TUI or headless, not which
terminal or process topology provides it.

The distinguishing constraint is that the workers are **non-deterministic processes that bill money
and sometimes fail to answer**. That is not a normal task queue, and it drives most of what follows.

**The scarce resource here is design, not code.** A coding agent writes any of this competently and
fast. What it does not do reliably is pick the seams — notice that a result's authority has to ride
on the agent's connection rather than on a token the harness must deliver, that a checkpoint is not
a signal, that publishing a replay policy commits the author surface to a durability model before
it is designed. Those cost minutes to fix in a document and months to fix in a shipped interface.

So completeness is not a goal of this repository, and feature count is not a measure of it. The
expensive artifacts are the ones that are hard to change once something depends on them: this
document, the author surface, the record formats, and the stage gates. The implementation behind
them is the cheap part. Two sections carry more weight than the rest because of that — section 10,
what is deliberately unbuilt and what would have to happen before it is, and section 12, where every
stage gate is phrased as something to *prove* rather than something to ship. `AGENTS.md` carries
this rule into the repository itself, so an agent working here optimizes for the same thing.

### Vision

**First, a runner people trust with real work.** Agent work people run by hand — a review loop, a
review fanned out over lenses, plan-implement-review delivery, a watcher that triages alerts —
becomes a workflow file someone writes once. The engine owns what hand-run scripts learn one failure
at a time: confirmed delivery, one accepted answer per question, deadlines on every wait, cleanup,
durable runs that continue from where they stopped, and an honest record of what happened. Runs
start and wake on events, and a person can answer them while they run.

**Every run is measured.** Outcome, attempts, nudges, time, tokens and cost are recorded by the
engine, not by workflow code, so any two runs can be compared.

**Then, runs that improve runs.** An autoresearch loop in this repository searches over workflow
variants — prompts, models, harnesses, verifier limits — for better, faster and cheaper ones, and
scores them from the run record ([ADR 0002](adr/0002-autoresearch-lives-here.md)). It is a consumer
of the runner, not a part of it. Past that, [`design/ideas.md`](design/ideas.md) holds the raw
ideas, awf maintaining awf among them.

The order matters. Every later step leans on the one before being trustworthy, and a runner
shaped for an optimizer before it is shaped for people would optimize the wrong thing.

## 2. The evidence

The design is not speculative because of experiments E1–E3 and E5–E7 (E4 is unrun), run before any
of the code here existed, and the measurements since. Raw rows are in
`experiments/_archive/*/results/`, and [`findings/README.md`](findings/README.md) keeps what is
still live. Load-bearing conclusions:

- All three result channels work across the tested matrix — 480 trials, with a negative control
  that fails correctly. The measured conditions were narrow: short JSON, a trivial task, sequential
  execution, no blocked agents, pre-granted permissions. 4 of 480 needed a nudge to land; E3, which
  sends none, lost 4 of 80. **Delivery is feasible and needs a nudge policy — it is not "solved".**
- A pane on a subscription is charged to nobody *on the measured account*; `claude -p` bills
  metered even with no API key in the environment. E3 says the mechanism is undocumented and
  account-specific. **Cost is a first-class domain concern.**
- Branching a session (fork, `/fork`, `/clear`) re-paid the context almost everywhere in E7.
  Measured again in 2026-10 ([`fork-cache.md`](findings/fork-cache.md)), awf's forks now read
  their parent's cache in every placement.
- Schema constraints must be in the prompt, not just in the validator: 0/160 first-attempt validity
  without, 80/80 with — headless, one schema. Field-level error text costs 2.00 attempts against
  2.90–4.95 for a bare refusal, worst case 11. The runner sends the schema itself, with the value in
  a quoted heredoc: 20/20 valid first answers on headless codex (story 002).
- A tool call returning success is not evidence the model received anything. Confirm from the
  transcript.

A review loop outside this repository, written by hand before this one existed, is an independent
implementation of roughly half of what the harness package provides; story 002 lifted its usage
reader and price table. It is a reference for whether the seams are in the right place: code that
solved the same problem without knowing about them.

## 3. Survey

Six repositories were read — four for structure, two for a specific idea each: `earendil-works/pi`,
`openclaw/openclaw`, `sst/opencode`, `temporalio/sdk-typescript`, `inngest/inngest-js` and
`openai/openai-agents-js`. They have their own file, **[`reference.md`](reference.md)**: what was
taken, what was rejected and why, and what is still unmined. It is a standing input, not a one-time
justification for a layout.

## 4. What the survey changes

**A `contract` package at the bottom of the graph.** Four of six repos have a `protocol` or
`*-contract` package there. What the agent-side command and the engine genuinely share is a
*format*, and that is the contract; the acceptance gate and the directory I/O are engine
implementation — see section 7.

**`src/` versus `packages/` is the anti-overbuild lever.** openclaw runs a 100-folder application
without making it a package. Extract to `packages/` what something outside will import; keep the
rest as folders.

**Evals do not need an application.** pi's evals are `.eval.ts` files, a reporter, and a summary.

**Conformance tests belong with the contract — but only the pure ones.** Pure adapter-contract
assertions run against the fake backend and live in `harness/testing`: no credentials, no cost,
always on. The live matrix depends on installed CLIs, Herdr, credentials and machine state, and it
spends money: that is an opt-in `*.eval.ts`, not a contract test, and it must not sit beside a
zero-dependency package.

**No build step.** pi pays for a compiled monorepo with a hand-ordered build chain. bun runs
TypeScript directly, so packages export `src/index.ts`, and the published packages ship it as is.

**Cost accounting is a domain, not a metric.** No surveyed repo needed this, because none of them
pay per worker in two different currencies depending on how the worker was launched.

## 5. Decisions taken

- **`contract` is one package.** Subpath exports, not four packages. Revisit only if the boundary
  blurs in practice (the tripwire is in section 10).
- **No `telemetry` package yet.** Reasoning in section 8.
- **No `workflows/` directory or catalogue.** Reasoning in section 9.

## 6. Proposal

### Layout

```
awf/
  package.json              # bun workspaces: packages/*, examples, experiments/*
  AGENTS.md                 # and one per package directory
  README.md

  docs/
    foundation.md           # this file
    status.md               # what runs today and what is next
    design/                 # the interface design notes — messaging, composition, the map
    findings/               # what the measurements settled; raw data in experiments/
    research/               # background reading behind a design note — input, not evidence
    reference.md            # surveyed repos: taken, rejected, still unmined
    adr/                    # decisions taken later
    stories/                # deliverables, each decomposed into reviewed tasks; todo/ is the inbox

  packages/
    agentswf/               # the package users install: the `awf` bin and `agentswf/workflow`
    contract/               # pure: types, schema, record formats, the author surface. no I/O
    harness/                # drive a coding agent. adapters, liveness, usage extraction
    engine/                 # the workflow runtime, run-directory I/O, and local control plane;
                            # src/agent-cli is the in-session `wfa`, contract plus wire client only
    sandbox/                # sandboxes a workflow opens: the provider seam and the providers
    lab/                    # evaluating workflows against known answers; a consumer of the engine

  examples/                 # scenario workflows written against the author surface
  experiments/              # measurements: _archive/ is E1–E3 and E5, never edited
  site/                     # agents.wf, standalone
  scripts/                  # check-boundaries.ts, release, and ad-hoc dev commands
```

The justification for each package is that something outside it must import it. The in-session
command, `wfa`, is `engine/src/agent-cli`, held to contract-only by a path rule: the engine was its
only importer (ADR 0013). `packages/sandbox` came with [[004-sandboxed-agents|story 004]], so that
neither harness nor engine holds a provider's code.

### The packages

**`agentswf`** — thin: `awf` calls the engine's entry, `agentswf/workflow` re-exports the author
surface and `agentswf/testing` the testing one. It is what a user installs, so its names are the
public ones.

**`contract`** — **pure: types and pure functions, no I/O, no runtime-specific APIs.** That is a
sharper rule than "zero dependencies" and it is mechanically checkable. Formats live here; the code
that reads and writes them does not.

```
@agentswf/contract              core types
@agentswf/contract/schema       validate, describe, formatErrors — pure
@agentswf/contract/records      run-record formats and their version — not the file I/O
@agentswf/contract/wire         control-plane messages, with runtime-decodable schemas
@agentswf/contract/workflow     the author surface: what a workflow imports
@agentswf/contract/participant  what a participant outside the run speaks
```

The control-plane messages need runtime-decodable schemas, not TypeScript types alone, because
`wfa` is an untrusted process boundary and a version-skewed or malformed request has to be rejected
predictably.

**One production return channel, not three.** E2 measured three and all work, but an accepted
result settles through the control plane: a channel where the agent writes into the call directory
itself contradicts the engine being the only writer of the run record. `wfa result` takes flags or
stdin.

**`harness`** — open one run-owned agent host, then open logical agents and operations inside it;
prompt them; inspect their normalized state; know when native work settled; read raw outcome and
usage evidence. Provider-specific claude, codex, pi and cursor launch, continuation, transcript,
authentication and usage behavior is composed inside the host rather than selected as a per-agent
terminal backend. Contains the launch table, `command.ts`, host and provider adapters, liveness,
`testing/` (the pure conformance kit, run against the fake), and `usage/` — **extraction only**.
Pricing and aggregation are policy and live elsewhere; see section 8.

Placement is the agent's: `tui`, the default, or `headless`, part of the resolved agent identity
and every usage record. A workflow chooses it because it changes what an agent costs and how it can
be continued: a headless claude is billed per token even on a subscription (E3), so it also needs
`metered: true`. Runtime aliases name a harness, a model and an effort. Operator configuration
installs one run host, and every logical agent crosses the same host interface: inspection,
authority, deadlines, cancellation, cleanup and evidence stay symmetric across placements.
Swapping Herdr for another pane provider must not change workflow definitions or runtime aliases.

One run host owns one terminal group and its final cleanup. The pane of the session a run was
started from with `awf run --here` is driven through the same host but is not in that group: the
host never starts, closes or cleans it up
([ADR 0010](adr/0010-the-calling-session-is-an-agent.md)). Logical-agent handles own continuity;
each distinct operation receives fresh result authority. A TUI agent keeps one pane for all its
operations, and each later one is prompted into it once the agent has settled
([ADR 0008](adr/0008-a-pane-agent-continues-in-its-pane.md)). Initial prompts and check-ins share
one operation, slot and schema; on placements with measured receipt support, `wfa waiting` permits
repeated check-ins under one fixed deadline ([[021-turn-liveness-and-limits]]). The harness
reports dispatch, native acceptance and model receipt; the engine owns the timers. Unsupported
placements do not gain cooperative waiting by inference, and unrecognized receipt evidence fails
explicitly rather than confirming delivery.

Only successful answered operations preserve natural continuity of a run-owned pane; a non-success
stops the owned native work. Native session references never cross into workflow state as resume
authority. They cross as accounting evidence, so the engine can read what an agent spent from the
harness's own files ([story 002](stories/002-cost-and-time-accounting.md)), and, in a run of a
workflow with `events`, as the session a parked run's next attempt reopens each agent on, read from
the engine's own records alone (ADR 0012).

Result admission, durable publication, client acknowledgement and native release are distinct
facts. The engine acknowledges a saved answer so the agent can finish its command, but returns
`answered` only after bounded native release. Unresolved release retains the answer as evidence,
fails closed and prevents dependent work. This does not prove detached children or remote jobs
ended. The caller is never killed or interrupted after acceptance (ADR 0010). An operation's
deadline is computed once before queueing and includes all check-ins and waits.

A socket per agent provides routing for cooperative-but-fallible agents. The engine installs a
launcher that holds the socket and names its path in the prompt, so the connection says who is
answering and nothing secret has to survive the trip into a pane. It is not a security boundary
against mutually hostile same-UID processes: anything running as the engine's own user can run that
launcher. The connection guards against stale commands and accidental cross-wiring; adversarial
confinement requires agents in separate sandboxes ([[permissions]]). Prompts that forbid
delegation are spending guidance, not proof of confinement.

**`engine/src/agent-cli`, `wfa`** — the command the in-session agent runs, through a launcher the
engine installs per agent: `wfa result`, `wfa waiting`, `wfa tool`, `wfa peers`, `wfa send` and
`wfa reply`. It *compiles* against `contract` alone and talks to the engine over the local control
plane described in section 7. It never links the rest of the engine and never touches the run
directory.

**`engine`** — logical-agent identity, alias resolution, queueing, idempotency, `parallel`, stages,
events and timers, messaging, usage collection, **all run-directory I/O, and the local
control-plane server**. Spend admission lands here too, and is not built ([[live-spend-limits]]).
It carries the operator CLI, which `agentswf`'s `awf` calls.

**`sandbox`** — the sandboxes a workflow opens ([[004-sandboxed-agents|story 004]],
[[permissions]]). `@agentswf/sandbox` is the seam and path resolution; `@agentswf/sandbox/srt` and
`@agentswf/sandbox/docker` are the providers; `@agentswf/sandbox/testing` is the conformance suite
and a fake. Only the composition root, `engine/src/operator-runtime.ts`, imports a provider; the
second composition root, `engine/src/workflow-testing/`, which runs a workflow's tests on fakes,
uses the fake alone (ADR 0006).

### Dependency graph

```
sandbox       → contract
harness       → contract, sandbox
engine        → contract, sandbox, harness    (a provider: operator-runtime.ts only;
                                               the fakes: workflow-testing/ and tests)
agent-cli     → contract            (engine/src/agent-cli, bundled as `wfa`)
agentswf      → contract, engine
lab           → contract            (runs `awf run`)
examples/     → contract/workflow   (their tests: engine/workflow-testing too)
scripts/*     → any
```

TypeScript will not hold any of these on its own — workspace packages are symlinked into one
`node_modules`, so anything can import anything and still typecheck. The rules are listed in
`AGENTS.md` and checked by `scripts/check-boundaries.ts`, which `bun run check` runs. Two carry an
argument: `engine/src/accounting` stays pure so it can be lifted out whole (section 8), and `lab`
reaches the engine only through `awf run`, as any outside caller would (section 7).

### Mechanics

- Each package's `exports` points at TypeScript source; bun runs it, and the published packages
  ship it. `tsc --noEmit` typechecks, `bun test` at the root runs everything free.
- Inter-package deps as `workspace:*`, which the release stamps to one version across packages;
  `typescript` and `@types/bun` pinned once in the root catalog.
- `*.eval.ts` for anything that spends money, excluded from `bun test`.

## 7. Where the roadmap lands

Every capability gets a decided home before it is built. A folder in the right package costs
nothing; a feature arriving with nowhere to go does.

| Capability | Lands in | State |
| --- | --- | --- |
| fork | native primitive in `harness`; logical branch creation in `engine` | built: a new agent on a copy of the session ([ADR 0009](adr/0009-a-fork-is-a-new-agent-on-a-copy-of-the-session.md)) |
| messaging between agents | cross-cutting, over the local control plane | built (story 029); see below |
| skills and tools | request and report shapes in `contract`; resolution in `harness`; tool calls through the control plane | built: skills as sources ([ADR 0004](adr/0004-skills-are-copied-per-agent.md)), tools the workflow's code handles (story 035) |
| workflows calling workflows | `engine` | `call` in `contract/workflow` |
| checkpoints and human approval | an `engine` admission barrier, not a signal | a person answers over routes as a participant (story 032); a barrier that stops dispatch is not built |
| durable runs and events | `engine`, records in `contract` | built: stages and continue (ADR 0011), events, parking and timers (stories 034, 037) |
| evals | `*.eval.ts` + a reporter | regression checks, not a system |
| autoresearch | `packages/lab`, as a consumer of the engine — see below | the general tools here, a project's variants and fixtures in its own repository ([ADR 0003](adr/0003-autoresearch-tools-here-project-data-there.md)) |
| observability | shapes in `contract`, extraction in `harness` | the run's event log and `awf logs` (story 028); section 8 |
| context usage | `harness`, beside liveness and usage | per-harness reading, same shape as usage ([[context-size]]) |
| fast typed decisions | questions, answers and the record in `contract`; providers in `engine/src/decisions/` | built: a decision is not an agent, one stateless request recorded and costed apart ([story 006](stories/006-typed-decisions.md)) |

Three of these need more than a table row.

### Messaging cannot be one package

The feature spans every layer:

- route, envelope and obligation **types** — needed by everything
- `HarnessTurn.deliver`, presenting a message at the next safe model continuation — **harness**
- `wfa peers`, `wfa send --await-reply`, `wfa reply` — **engine** (`src/agent-cli`)
- the obligation state machine: atomic acceptance of a send and its obligation, a request waking
  an agent that awaits a reply, refusing `wfa result` while a reply is owed — **engine**

The types go in `contract` and the enforcement in `engine`, the way openclaw names
`gateway-protocol` separately from the gateway.

**A dependency rule is not a communication channel.** `wfa` is a separate operating-system
process. `wfa send --await-reply` has to create its obligation atomically with the message; `wfa
result` has to be refused while a reply is owed; a `wfa reply` has to be matched against the wait
still open, ordered against another process's send. None of that can be done by two processes
writing to a shared directory. So **the engine owns a local control plane**, an authenticated local
endpoint it serves and `wfa` calls. Wire messages go in `@agentswf/contract/wire`, the client is
`wfa`'s internals, the state and transactions are the engine's. Remote execution later replaces
the transport without having to invent the boundary.

The run directory does not go away. It stays the durable record an optimiser reads. The socket is
the control plane; the directory is the record; the engine is the only writer of either.

### What a hand-run loop needed

Before this engine, a 349-line bash skill ran a two-reviewer feedback loop in Herdr panes, and kept
a log of what went wrong while running it. That log independently rediscovered most of what this
engine exists to provide, from the other direction. E1–E7 measured what a harness can be made to
do; this measured what a real multi-agent loop needs and has to hand-roll.

| Observed without an engine | What it is in this design |
| --- | --- |
| `herdr agent prompt` exits 0 having delivered nothing; two pings vanished and both printed `notified` | E7's finding, reached independently. Delivery is confirmed from the transcript, never from a return value |
| Herdr reports `idle` mid-turn, so the findings doc is the only signal `wait` can trust | Turn completion and result submission are separate signals — the result gate, not lifecycle state |
| The shell ate a round: a backtick inside a disposition was substituted away, silently | `wfa result` reads stdin or flags, with no shell substitution in the value's path |
| Both sides idle looks identical to work in progress; a stalled loop surfaces only when a human opens the tab | The engine holds queue and admission state, so "waiting on nobody" is a state it can report |
| One reviewer pinging hides the other's silence indefinitely | `parallel` with a per-branch outcome, where `unanswered` is terminal rather than quiet |
| Derived agent names changed under running reviewers, stranding two of them | A stable agent key, owned by the engine |
| A round nobody receives, retried for 30s, residual left to the implementer | Durable queueing and an explicit nudge, with the attempt recorded |
| Convergence needs one place to look; with two docs, "both clean" is the implementer's bookkeeping | The run record |
| Reviewer-to-reviewer messaging stays out — no arbiter, no natural stop | Routes are granted by the workflow (`messages.allow`), never ambient |
| Only the implementer's adjudication ended a seven-round disagreement | A checkpoint, which is not a signal |
| A reviewer that ran out of context sits idle with its round lost | Context usage read per agent ([[context-size]]) |

Two rows carry more than the others. The delivery row is a second independent observation of the
same failure, which moves it from a quirk to a property of the substrate. And the messaging row is a
*negative* requirement: the skill refused reviewer-to-reviewer routes because there is no arbiter
and no stopping rule. An ambient message bus would make that refusal inexpressible; granted routes
make it a design choice.

The engine does not have to beat such a script to be worth building. It has to make the same loop
something a workflow author writes once.

### Autoresearch is a consumer of the engine

**Evals** answer "does this still work": `*.eval.ts` files, a reporter, a summary. No package.

**Autoresearch** answers "which combination is better, faster or cheaper" — searching over workflow
design, models, harnesses, tools and skills. Its core is comparison: fixtures with known answers, a
scorer, and a comparison of variants with their spread. Whoever proposes the variant, a person or
an agent in a loop, uses the same comparison ([ADR 0002](adr/0002-autoresearch-lives-here.md)). Its
general tools live in `packages/lab`, a project's variants and fixtures in that project's own
repository ([ADR 0003](adr/0003-autoresearch-tools-here-project-data-there.md)). It is a *user* of
the engine: it has a different lifecycle and a different failure mode, and it reaches the engine
only through `awf run` and the run record, as any outside caller would.

It is the most demanding consumer, which makes it the useful one to design against:

**Everything it varies must be injectable, with workload and provisioning kept distinct.** Harness,
model, effort, placement, skills and tools are workload parameters. The terminal host,
authentication route, funding pool and admission are operator provisioning and accounting policy.
A workflow's `metered: true` only consents to the funding consequence of a placement; the route and
the pool stay the operator's. The alias table and run policy are arguments to the engine, not files
it silently loads.

**The engine has a programmatic entry point.** Run a workflow with injected configuration, get a
structured result. The operator CLI is a wrapper over it, never the only way in.

**The run record is a public format with an external reader.** An optimizer scores runs it did not
observe live: outcomes, attempts, nudges, timings, tokens, and both dollar columns, serialized and
stable. That is the strongest reason the record formats live in `contract`, and it means changing
them is a breaking change, not an implementation detail ([[run-record-layout]]).

## 8. Telemetry and cost — a package, but not yet

The question is whether usage and cost deserve their own package, given that E3 made cost a
first-class concern rather than a metric. Splitting the problem into three parts settles it.

**Extraction is harness-specific, as specific as the flags table.** claude writes usage into a
transcript JSONL where one API response appears as several rows sharing a `message.id` — E3 found a
reader double-counting because of it. codex and pi record per-turn usage on disk in their own
formats. cursor records none on disk; its headless JSON prints each turn's tokens, which awf keeps
beside the chat (story 019); a pane's cursor prints none, so its usage is unknown. Whatever reads
those files belongs next to the adapter that knows which harness it is talking to —
`harness/src/usage/`.

**The record shape is not harness-specific, and it is the expensive thing to change.**
`SettledOperation` lives in `contract` and records only what was observed: times, native sessions,
billing mode, tokens by model and token class, and a charge only where one was billed per token. If
telemetry is extracted later, the shape does not move and nothing downstream breaks.

**Pricing and aggregation are policy, not observation.** A rate card changes independently of any
harness. Prices are applied when a run is summarised, so a run can be re-priced later with a
different table, and the summary names the table it used. Only extraction sits beside the adapter.

**One cost field cannot say which cost it was.** `charged` is what an API billed, the list-price
`estimate` exists only in the run's summary, and `billing` says whether the agent drew on a
subscription or was metered (story 002). A decision (story 006) is always metered, on the
operator's own provider account; its list-price estimate sits in the summary apart from the
agents'.

What a package boundary buys is control over who may import something. Nothing here needs that:
the engine and ad-hoc scripts should both be able to ask what a run cost. A boundary would not have
prevented E3's double-count either — tests did that, and tests do not need a package.

**Where it sits meanwhile.** Session-file readers and billing in `harness/src/usage/`, handed to the
engine by the run host, because how an agent is launched decides who pays. Reading at run end and
splitting spend between operations in `engine/src/run-usage.ts`. Prices and the summary in
`engine/src/accounting/` — pure, importing only the contract, exported so a finished run can be
priced again, and positioned to be lifted out whole.

**When it fires.** When something needs control over who may import it. Counting producers and
consumers was the first trigger, and it fired without that need: story 028 made the engine a second
producer, story 030's OTel export is another consumer, and no package followed.

One thing to carry regardless of packaging: the two dollar columns are not the same number, and the
difference is not currency — both are USD. The dimensions a cost record has to carry are **charge
basis, funding pool, estimation basis and rate-card version**. Without them it will silently report
one as the other ([[billing-provenance]]).

## 9. Explicit workflow files, not a catalogue

The scenarios in `examples/` compile against the author surface, may use a pure JSON Schema
authoring library, and never import the engine or a harness. TypeBox is the first such library: its
inferred types and schema objects stay in the workflow while contract owns the supported subset,
prompting and validation. A workflow default-exports its `defineWorkflow`, which `awf run` loads.
The workflow may constrain an operator alias to an exact model when that choice is part of its
behavior; alias definitions, adapters, authentication, run-directory I/O, loading and cleanup stay
in the operator and engine.

The engine supplies the working directory and, when the run has one, an enforced absolute deadline;
they are not domain arguments. The operator sets the deadline with `awf run --timeout`, and a run
without it has none ([[032-run-coordinator|story 032]], Q1). Expiry cancels active agent work;
shutdown has a fixed grace so an uncooperative adapter cannot keep the operator open. Every wait
inherits the scope's deadline when the workflow omits one, or takes its own: no engine or harness
wait is unbounded.

`awf run {file}` is explicit loading of trusted code, not discovery. The named module runs with the
operator's filesystem and process authority before its export can be validated. There is no
registry, installed workflow catalogue, package-specifier loading, or `workflows/` deployment
surface. Add one only when multiple distributed workflows create evidence for its ownership and
lifecycle.

## 10. Deliberately not built yet

Each of these has a decided home (section 7) and stays a folder inside an existing package, or
nothing, until a named trigger fires.

| Not yet | Lives in for now | Extract or build when |
| --- | --- | --- |
| `telemetry` / accounting package | readers and billing in `harness/src/usage/`, activity readers beside them; run-end reading in `engine/src/run-usage.ts`; prices and summary in `engine/src/accounting/`; the run's event log and the records in `contract` | something needs control over who imports it |
| `messaging` package | `engine/src/messaging/`, types in `contract` | never as one package — see section 7 |
| per-adapter packages | `harness/src/adapters/` | an adapter needs its own dependencies |
| `decisions` package | `engine/src/decisions/`, the author surface in `contract/workflow` | a decision provider needs its own dependency |
| context-usage reading | not built ([[context-size]]) | where it appears is settled: a published record or its own call |
| a checkpoint that stops dispatch | not built; a person answers as a participant (story 032) | a workflow needs every branch held, not one wait answered |
| spend limits | not built ([[live-spend-limits]]) | live usage is read with the coverage and attribution enforcement needs |
| agent retention | an event run's kept sessions and `keepAlive`'s window — ADR 0012; releasing one agent's pane alone is not built ([[agent-release]]) | a harness release that proves the process gone, and a workflow with a second agent beside a kept one |
| crash recovery | a continue reuses the stages that succeeded (ADR 0011); what a dead awf left running is not ended ([[crash-leftovers-reaper]]) | the record each owner writes as it launches is designed |
| remote execution | not built — [[workflow-in-sandbox]] | the engine runs where the agents are, so the local control plane never crosses a network |
| Node.js | not supported ([[node-runtime]]) | a consumer that can't run Bun |
| TUI | not built | — |

The point of the table is that none of these get quietly built because a directory existed.

**The tripwire on `contract`.** It holds schema, record formats, wire messages, the usage record,
messaging types and the author surface, and subpaths keep that navigable. The signals to split are
a subpath needing a dependency the others do not, a runtime constraint the others do not share, or
a release cadence that has to differ because something outside consumes it independently.

## 11. Integration story

Pieces should drop into existing work without adopting the whole engine.

**Every package is independently useful, within a stated limit.** `harness` with no engine is "run
claude through a configured adapter, know when it settled, read the transcript and what it cost" — a
raw session outcome. It cannot on its own promise the engine's *accepted structured result*,
because that settles through the control plane; a standalone caller either takes the raw outcome or
supplies its own result sink. `contract/schema` with nothing else is "validate a model's JSON and
tell it what is wrong in words that work".

`harness` has to be importable by something that knows nothing about workflows — an ad-hoc command
drives one harness, autoresearch drives many — and none of them should boot an engine to do it.
Stage 1 tests that import deliberately rather than waiting to find out it is awkward.

## 12. Stages

Each stage is a gate phrased as something to prove. Which are open is in [`status.md`](status.md).

- **Stage D — fix the interface, in place, as design.** Done. Six interface faults were corrected
  in the author surface before anything was built on it: harness outcomes became harness-local, the
  replay policy's journal arm came out, checkpoints left signal semantics, fork got no public API
  until measured, the acceptance gate's contract states atomicity, and every wait resolves a
  deadline. Unbuilt types have since come out too ([ADR 0001](adr/0001-unbuilt-interface-leaves-the-surface.md)).
  Result authority rides on a socket per agent, because a bearer token has to be delivered and no
  harness will promise to deliver one.
- **Stage 0 — skeleton and move.** Done.
- **Stage 1 — prove the harness stands alone.** The adapter contract, the shared fake, the
  direct-process and pane adapters and the Herdr run host are tested without the engine. The gate
  is a small general-purpose command that drives one harness through `harness` alone.
- **Stage 2 — minimum engine and the control plane.** Done: `agents.open/run`, `parallel`, result
  slots, `wfa`, the local endpoint and the workflow loader, proven against a fake and then live. An
  ambiguous Herdr `idle` is not an answer or proof that background work ended. Native release is
  bounded and required before success; detached-child isolation and crash recovery remain separate
  proofs.
- **Stage 3 — measure and run something real.** A real workflow on the engine and accounting for
  every run are done. Left: **E4**, concurrency — the one question never answered, and the only
  remaining measurement that changes the engine rather than confirming it.
- **Stage 4 onward** — messaging, composition, durable runs. Messaging was the structural test: it
  touches every package, and it landed without moving a boundary (story 029).

## 13. Open questions

1. **Author surface as a subpath or a package?** Temporal makes it a package because the constraint
   is enforced by a sandbox. Here it is enforced by discipline, so it is a subpath — revisit if a
   workflow ever reaches past it.
2. **What must a run record carry so an optimiser can score it?** Cost and wall clock are measured.
   Quality is scored against known answers for reviews (story 008); whatever stands in for it in
   another kind of workflow has to be *emitted here*, or the optimiser will happily find the
   cheapest way to be wrong ([[second-case-kind]]).
