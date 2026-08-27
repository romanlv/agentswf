# Reference projects

Repositories that have already solved versions of this project's problems, and what this project
takes from each.

This is a standing design input, not a one-time justification for the proposed layout. As
[`foundation.md`](foundation.md#1-what-this-is) explains, design is the scarce resource here. A
repository that has solved one of these problems in production is more useful than reasoning from
first principles alone.

Each repository entry or scoped survey records:

- **What it is** — enough to know whether it is worth opening.
- **Taken** — what this project does differently because of it. If nothing, say so.
- **Rejected** — what was read and deliberately not copied, with the reason. This prevents the same
  decision from being relitigated.
- **Unmined** — questions the repository has not yet been read against. This is the working list.

Add an entry when a repository is read against a real question, not when it seems relevant.

## Unmined work

Most of the initial survey focused on **layout**: how to split packages. That question is answered,
but several repositories have not yet been examined against the harder design problems:

| Open design problem | Where to read | The specific pattern |
| --- | --- | --- |
| Adapter capability negotiation — fork exists on claude, not on cursor | MCP; openclaw `plugin-package-contract` | declared capabilities, negotiated at connect |
| Messaging routes granted rather than ambient | openclaw `gateway-protocol` | a protocol package that plugins depend on, never the reverse |
| Conformance kits that travel with a contract | pi `telemetry/src/testing/conformance.ts` | named here, only half-applied |
| Mechanical boundary enforcement | openclaw `tsconfig.package-boundary.*` | `contract` purity is currently a rule, not a check |
| Effect boundaries before unshelving the journal | Temporal | all non-determinism goes through activities (E6) |

---

## Local clones

Clone them shallowly into `~/dev/ref-repos`, outside this repository. This gives agents direct
access to the sources without mixing third-party repositories into the project tree.

```sh
ref_repos_dir="$HOME/dev/ref-repos"
mkdir -p "$ref_repos_dir"

for repo in earendil-works/pi openclaw/openclaw sst/opencode \
            temporalio/sdk-typescript inngest/inngest-js openai/openai-agents-js \
            akka/akka-core erlang/otp hashicorp/go-plugin capnproto/capnproto \
            nats-io/nats-server nats-io/nats.docs; do
  git clone --depth 1 "https://github.com/$repo" "$ref_repos_dir/${repo#*/}"
done
```

| Clone | Open first |
| --- | --- |
| `pi` | `packages/telemetry/src/testing/conformance.ts`, `packages/evals/src/vitest-evals/`, root `package.json` build script |
| `openclaw` | `tsconfig.package-boundary.*.json`, `packages/gateway-protocol/`, `packages/plugin-package-contract/` |
| `opencode` | `bunfig.toml`, `package.json`, `packages/protocol/` |
| `sdk-typescript` | `packages/workflow/src/workflow.ts` (setHandler semantics), `packages/client/src/workflow-client.ts`, `packages/activity/src/index.ts` |
| `inngest-js` | `packages/inngest/AGENTS.md`, the `step.waitForEvent` implementation |
| `openai-agents-js` | package boundaries only |
| `akka-core` | `akka-docs/src/main/paradox/typed/reliable-delivery.md`, `akka-actor-typed/src/main/scala/akka/actor/typed/delivery/` |
| `otp` | process and monitor docs, `lib/stdlib/src/supervisor.erl` |
| `go-plugin` | `docs/internals.md`, `client.go`, `runner/` |
| `capnproto` | `doc/rpc.md`, `c++/src/capnp/rpc.capnp` |
| `nats-server`, `nats.docs` | `server/`, request/reply docs, JetStream acknowledgement docs |

## Messaging: five pattern sources, one engine-owned protocol

The detailed survey is in
[`research/messaging-patterns.md`](research/messaging-patterns.md). No single project solves the
whole problem, and transport success still cannot prove that a terminal coding agent observed a
prompt. The useful abstractions come from five places:

| Concern | Best reference | Pattern to take |
| --- | --- | --- |
| Processing acknowledgement | Akka Typed Reliable Delivery | Only the consumer confirms processing; transport or mailbox delivery is insufficient |
| Peer death and restart | Erlang/OTP | Correlated process monitors, session incarnations, bounded restart policy |
| Granted routes | Cap'n Proto RPC | An opaque reference both designates a target and grants bounded authority |
| Local subprocess control | HashiCorp `go-plugin` | Versioned startup handshake, endpoint discovery, lifecycle ownership, explicit reattach metadata |
| Persistence and redelivery semantics | NATS Core/JetStream | Distinguish no responder, stored, delivered and consumer-acknowledged; redeliver with deduplication |

The resulting protocol needs distinct states rather than one `delivered` boolean:

```text
submitted -> admitted -> offered -> observed -> processed/responded
```

- `admitted` means the engine authenticated and durably recorded the command.
- `offered` means the harness scheduled it for a safe continuation.
- `observed` requires harness evidence that it reached a model continuation or transcript.
- `processed/responded` is application-level confirmation from the recipient.
- A post-dispatch timeout may be `maybe_processed`; it must not be reported as a clean rejection.

Process death is a first-class event, but Erlang's monitor pattern does not detect a live, wedged
process. That still requires progress evidence and a deadline. Routes should be opaque,
invocation-scoped capabilities bound to source, destination, allowed actions, expiry and session
incarnation. These are patterns to copy into the engine's small local protocol, not reasons to add
an actor runtime or message broker.

---

## earendil-works/pi

**What it is.** The closest analogue: npm workspaces, ten packages.

```
agent  ai  client  coding-agent  evals  protocol  server  session-backends  telemetry  tui
```

Almost exactly the decomposition arrived at independently here — `protocol` is a wire contract
(`codec.ts`, `framing.ts`, `schemas.ts`, `cbor/`), `session-backends` is a family of interchangeable
session implementations, `agent` is the runtime loop, `telemetry` and `evals` are first-class rather
than scaffolding.

**Taken.**

- A contract package at the bottom of the graph, which four of the six surveyed repos have.
- **Evals are tests, not an application.** `packages/evals/src/` is `smoke.eval.ts`,
  `extensions.eval.ts`, a `pi-harness.ts`, and `vitest-evals/{setup,reporter,summary,harness-table,artifacts}.ts`.
  There is no eval binary — a test runner config, a reporter, and files named `.eval.ts`. That
  removed a whole package from the day-one plan and turned `trial.ts` / `runner.ts` into a reporter
  plus a test config.
- **A contract ships with the kit that proves an implementation satisfies it** — `telemetry` is
  described as "vendor-neutral telemetry contracts, reference adapter, conformance tests" and ships
  `src/testing/conformance.ts`.

**Rejected.**

- **The build chain.** Its root `build` is a hand-ordered `cd packages/tui && npm run build && cd
  ../telemetry && ...` across nine packages. That is the price of compiling a monorepo, and it is
  the single clearest argument for this repository exporting `src/index.ts` and skipping the build.
- Ten packages at this project's current scale.

**Unmined.**

- `telemetry/src/testing/conformance.ts` read properly, and applied to `harness/testing` — the
  pattern was named here and only half-applied.
- `vitest-evals/` as the concrete shape for the eval reporter and summary.
- `session-backends` as a family, against this project's session adapters.

## openclaw/openclaw

**What it is.** pnpm workspaces. The interesting part is what is *not* a package.

```
src/          the entire gateway application — 100+ feature folders, not a workspace package
packages/     23 packages: gateway-protocol, plugin-package-contract, session-url-contract,
              workboard-contract, plugin-sdk, agent-core, llm-core, terminal-core, retry...
extensions/   130+ independently loadable integrations
skills/       ~50 plain skill directories
apps/  ui/  deploy/  qa/  docs/
```

**Taken.**

- **`packages/` is for contracts and genuinely shared libraries; the application lives in `src/`;
  breadth lives in `extensions/`.** A repository can be enormous without its core being split,
  because splitting is reserved for what something outside must import. This is the anti-overbuild
  lever, and it is why `messaging`, `telemetry` and capability resolution stay folders.
- **`*-contract` naming makes dependency direction obvious at a glance** — a plugin depends on
  `plugin-package-contract`, never on the gateway.

**Rejected.**

- 23 packages and 130 extensions is a scale answer, not applicable at this project's current scale.

**Unmined.**

- `tsconfig.package-boundary.base.json` / `tsconfig.package-boundary.paths.json` — they enforce
  boundaries mechanically. Here, `contract` purity is a stated rule with a manual grep behind it.
  That is a real gap and this is the reference for closing it.
- `gateway-protocol` — a protocol package plugins depend on and the gateway does not, as the model
  for granted-rather-than-ambient messaging routes.
- `plugin-package-contract` — how a plugin declares what it can do, for adapter capability
  negotiation.

## sst/opencode

**What it is.** bun workspaces (`bun.lock`, `bunfig.toml`) plus Turborepo, thirty packages.

```
app cli client codemode console containers core desktop docs effect-drizzle-sqlite
effect-sqlite-node enterprise function http-recorder httpapi-codegen identity llm
opencode plugin protocol schema script sdk-next sdk server session-ui slack stats
storybook tui ui web
```

**Taken.**

- Confirmation that **bun workspaces are viable for a terminal-agent product of real size**.
- The `protocol` / `plugin` / `sdk` triad as the extension surface, if one is ever needed.

**Rejected.**

- Thirty packages. `effect-sqlite-node` and `httpapi-codegen` are packages because a team of that
  size needs them to be. This is explicitly not a model to copy at the project's current scale.

**Unmined.**

- Its `bunfig.toml` and whether it ships TypeScript or compiled output — directly relevant to open
  question 4, whether bun is the supported public runtime.

## temporalio/sdk-typescript

**What it is.** Prior art for the durable half.

```
activity client common core-bridge worker workflow testing plugin envconfig meta nexus ...
```

**Taken.**

- **The package boundary *is* the constraint.** `workflow` is a separate package because workflow
  code runs under determinism constraints and must not be able to import the worker. That framing is
  what makes open question 2 — author surface as a subpath or a package — a real question rather
  than a style preference.
- `testing` as a first-class package shipping a time-skipping environment.
- **Update is the checkpoint primitive, and it is not a signal.** `setHandler` takes an
  `UpdateDefinition`, a `SignalDefinition` or a `QueryDefinition`, and the three differ in exactly
  the way `foundation.md` section 7 argues a checkpoint differs from `Signals.receive`. An Update
  carries an optional **validator**, returns a result to its caller through
  `WorkflowUpdateHandle.result()`, and — the decisive part, from the SDK's own implementation
  comment — **an Update with no handler is rejected at the end of the activation, while a Signal
  with no handler buffers indefinitely**. An approval nobody is listening for must fail loudly. wf
  currently has only the buffering half.
- **The task token is the operation capability, already solved.** Async activity completion hands an
  out-of-process worker an opaque `taskToken`; that worker calls
  `client.activity.heartbeat(taskToken, details)` or completes against it, and the token identifies
  exactly one activity invocation. That is `wf result` — an out-of-process agent settling one slot it
  was handed — and it is why `CallEnv` is replaced rather than migrated. `runDir` plus `callId` are
  identifiers; a task token is a capability.

**Rejected.**

- Enforcing the author surface with a sandbox. Here it is enforced by discipline, so a subpath is
  proposed — revisit if a workflow ever reaches past it.

**Unmined.**

- **All non-determinism goes through activities.** E6 found the hard version of Temporal's central
  problem — a journal key covering the prompt but not the working tree replays a stale answer
  silently. Read this before unshelving `journal.ts`.
- Heartbeat and cancellation propagation. E7's vanished prompt and `review-feedback`'s undelivered
  pings are both the absence of a heartbeat.
- Retry policy shape, against nudges and attempts.

## inngest/inngest-js

**What it is.** pnpm; packages `inngest`, `realtime`, `otel`, `test-harness`, several `middleware-*`.

**Taken.**

- **The step API, ergonomically.** `step.run(id, fn)` / `step.sleep` / `step.waitForEvent` /
  `step.invoke` is the same surface as `Steps` and `Signals` in `interfaces/workflow.ts`, with years
  of iteration behind it.
- **Every wait has a deadline.** `step.waitForEvent` pairs correlation with a timeout. That closes
  the unbounded-wait hole in `Signals.receive` without adding a new abstraction.
- `middleware-*` as separate packages is how a small extension surface stays small.

**Rejected.** Nothing yet.

**Unmined.**

- `step.invoke` against `context.call` for child workflows.

## openai/openai-agents-js

**What it is.** `agents-core`, `agents`, `agents-openai`, `agents-realtime`, `agents-extensions`.
The umbrella package re-exports; `-core` holds the provider-agnostic centre; providers and
extensions are separate. Temporal does the same with `meta`.

**Taken.** Nothing yet; this is reserved for the point when the project wants a single friendly
import.

**Rejected.** Nothing yet.

**Unmined.** `agents-extensions` as a shape, if per-adapter packages are ever extracted.

---

## Candidates not read yet

- **MCP** — capability negotiation at connect is the closest available model for an adapter
  declaring that it supports fork, compaction or a context read, and for the engine deciding
  fail-vs-downgrade when it does not.
