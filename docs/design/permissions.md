# Permissions

What an agent may reach and use, who decides, how it is held, and what the record says afterwards.

A workflow opens agents and gives them work. Nothing today says what those agents may touch: the
interface can list an agent's skills, but not whether it can write to disk, reach the network, or
read the developer's cloud credentials. This document closes that gap in the design, before any
code.

Terms. A **harness** is the coding agent program: claude, codex, cursor, pi. An **adapter** is the
engine's driver for one harness on one backend. The **operator** configures the engine on a
machine. The **workflow** is the TypeScript that opens agents, possibly written by someone else.
**Isolation** is how a grant is held: by a sandbox under the harness, or by the harness's own
permission system. A **sandbox provider** is one implementation of the sandbox: Seatbelt on the
host, a container, a remote machine.

The evidence behind the sandbox sections is a measured study of these harnesses under Seatbelt
and in containers, verified 2026-08-08: `braintrust/docs/agent-sandboxing.md`, cited below as
*the study*.

## Where things stand

An agent inherits the whole environment of the engine process minus three `WF_*` variables
(`childEnvironment` in `packages/harness/src/command.ts`): every API key, cloud credential, and
SSH socket the developer holds. The working directory is where the agent starts, not where it
stops. Codex runs with `sandbox_mode="danger-full-access"` and cursor with `--force`, because E1
and E2 granted everything so they could measure result delivery instead of permission prompts.
Measurement settings became the product default.

Outside the engine, the same harnesses already run daily under `srt`, Anthropic's sandbox-runtime,
with permission prompts bypassed inside it, and in a container with Herdr inside the box. None of
that reaches the engine yet.

## The model

Three parties, each saying what and how firmly:

```text
operator   ceiling + floor        the most any agent may hold; the weakest isolation allowed
workflow   request + isolation    what this agent needs; how it should be held
engine     held grant             what the agent actually got, per axis, and what holds it
```

The engine refuses to start an agent whose request exceeds the ceiling or whose isolation is
below the floor. A workflow can ask for less than the operator allows, never more, which is what
makes a workflow you did not write safe to run. Codex's `allowed_sandbox_modes` and claude's
`allowManagedPermissionRulesOnly` are the same shape, reached independently.

**What** has two halves, held by different machinery. *Reach* is files, network, and environment:
an agent has these by existing, and something takes them away. *Use* is tools, skills, and MCP
servers: an agent has none until the harness hands them over. Messaging already works the second
way, a route granted by the workflow and never ambient; this is that discipline extended.

**How** is three levels, strongest first:

```text
sandbox    a provider starts the agent inside a boundary; the harness's permission prompts are off
harness    the harness's own permission system holds the grant; a cooperative agent honours it
none       nothing holds it; the record says so
```

A workflow names the level exactly, not as a minimum, because the levels do not nest in what they
permit: a sandbox is stronger and also blunter, and the agent that needs SSH needs `harness`
specifically. An engine that cannot provide the level asked for refuses. Portability across
engines is the operator installing a provider, never the engine guessing a level.

Which provider stands behind `sandbox` is part of the **runtime**, beside harness, model, and
backend. An alias names it, the operator installs it by name, the record carries it.

Every allowlist entry names a family: a path names everything beneath it, a domain with a leading
dot names its subdomains, `skill:` names every skill. Allowlists compare by containment, so the
ceiling check is set arithmetic, not a matching language. The study reached the same posture from
the other side: reads are deny-by-default with twenty named paths, because a deny-list requires
having already thought of the thing.

## Example

A review loop: reviewers that read, an implementer that writes, a publisher that pushes.

```ts
const reviewer = await workflow.agents.open({
  key: "reviewer:security",
  runtime: "reviewer",
  instructions: "Review the change and return your findings.",
});

const implementer = await workflow.agents.open({
  key: "implementer",
  runtime: "implementer",
  instructions: "Implement the approved ticket.",
  grant: { write: ["."], use: ["skill:ticket-doc"] },
});

const publisher = await workflow.agents.open({
  key: "publisher",
  runtime: "implementer",
  instructions: "Push the branch and open the merge request.",
  grant: { write: ["."], read: ["~/.ssh"], network: ["gitlab.com"] },
  isolation: "harness",
});
```

The reviewer says nothing and gets the default: reads its working directory, writes nothing,
reaches no network, sees a minimal environment, holds a shell, sits in a sandbox. Its findings
return through `wf result`. The implementer asks to write and to use one skill, still sandboxed.
The publisher needs SSH, which a sandbox denies by design, so it asks to be held by claude's own
rules instead, visibly, where a reader of the workflow sees it. The operator's floor decides
whether that is allowed here at all.

The operator's side:

```ts
const runtime: AgentRuntimeConfig = {
  aliases: {
    reviewer: { harness: "claude", model, backend: "headless", pool, sandbox: "srt" },
    implementer: { harness: "claude", model, backend: "pane", pool, sandbox: "srt" },
    batch: { harness: "codex", model, backend: "headless", pool, sandbox: "box" },
  },
  backends: { pane: herdr, headless: subprocess },
  sandboxes: { srt: seatbelt, box: container },
  ceiling: {
    write: ["."],
    read: ["~/.ssh"],
    network: ["registry.npmjs.org", "gitlab.com", ".gitlab.com"],
    env: ["PATH", "HOME", "LANG"],
    use: ["tool:shell", "skill:"],
  },
  floor: "harness",
};
```

Relative paths resolve against each agent's working directory. Under this ceiling a request for
`network: ["example.com"]` or `isolation: "none"` does not start: activation fails and names the
excess. Nothing is silently narrowed.

## The types

```ts
/** An allowlist per axis. Every entry names a family. Absent means the minimum on that axis. */
export type Grant = {
  /** Directories readable beyond the working directory, which is always readable. */
  read?: readonly string[];
  /** Directories writable. Nothing is writable unless listed, the working directory included. */
  write?: readonly string[];
  /** Domains the agent's own commands may reach. The harness's model traffic is never listed. */
  network?: readonly string[];
  /** Environment variable names the agent's commands may see. */
  env?: readonly string[];
  /** Capabilities handed over, by ref: `skill:review-feedback`, `tool:shell`, `mcp:github`. */
  use?: readonly CapabilityRef[];
};

/** Namespaced by convention. The grammar waits until two adapters show what is portable. */
export type CapabilityRef = string;

/** How a grant is held, strongest first. */
export type Isolation = "sandbox" | "harness" | "none";

export type SandboxKind = string;

export type ExecutionConfig = {
  harness: HarnessKind;
  model: string;
  backend: BackendKind;
  pool: SpendPoolKey;
  /** Where the process lives, by installed provider name. Absent means no sandbox available. */
  sandbox?: SandboxKind;
  settings?: ModelSettings;
};

export interface AgentRuntimeConfig {
  aliases: RuntimeAliases;
  backends: Readonly<Partial<Record<BackendKind, AgentSessionAdapter>>>;
  /** Installed providers, by the name an alias uses. */
  sandboxes?: Readonly<Record<SandboxKind, SandboxProvider>>;
  /** The most any agent in this engine may hold. */
  ceiling: Grant;
  /** The weakest isolation the operator allows. Default `"sandbox"`. */
  floor?: Isolation;
}

export interface AgentOpenSpec {
  // ...key, cwd, instructions, runtime
  /** Checked against the ceiling. Absent means the default below. Replaces `skills`. */
  grant?: Grant;
  /** Checked against the floor. Default `"sandbox"`. */
  isolation?: Isolation;
}
```

The provider name is the one permission word in `ExecutionConfig`, because where a process lives
is a runtime fact like the harness, and an optimiser comparing runs wants it in the record. The
allowlists are not: execution config flows into every usage record and the run record, which
[`foundation.md`](../foundation.md) §7 calls a public format with an external reader, and the
allowlists are the most volatile vocabulary in the project. An alias decides where an agent runs,
not what it may do there.

**Say nothing and you get a sandboxed reader.** The shell is there because `wf result` is a shell
command, and it is safe because reach is narrowed underneath it: a read-only sandbox does not
care which tool asks to write. This is the reviewer, the case worth making effortless, and it is
checked against ceiling and floor like any other request. Until a provider is installed, the
examples in this repository say `isolation: "none"` in the open, which is the true statement
about them today.

## Isolation

Harness flags are not a boundary. An agent with a shell can relaunch its own harness with
different flags, so `allowedTools` and `sandbox_mode` bind a cooperative agent and nobody else. A
sandbox lives below the harness, which cannot see it, let alone lift it.

Both levels are worth having. A sandbox is the default because it is the only level that holds
an adversarial agent, and the only one that holds pi, which has no permission system. Harness
isolation exists because a sandbox is blunt: it denies SSH, keychain writes, and installs that
unpack forbidden filenames, and it cannot be argued with. Harness rules are finer, argument-scoped
on claude, and right when the task needs something the sandbox breaks and the operator trusts
the agent to cooperate. The workflow says which; the operator says how low it may go.

### The sandbox seam

A sandbox is applied once, to a process, at launch. `srt -s cfg claude` starts claude under
Seatbelt, and every turn, tool call, shell, and subagent it spawns runs under that policy until
the process exits. Nothing is wrapped per prompt or per tool; the engine never sees a tool call.
So the seam is one method deep: **a sandbox is what starts the agent's outermost process.**

```ts
/** Everything a sandbox must hold, already summed: the held grant plus what the harness needs. */
export type SandboxProfile = {
  cwd: string;
  read: readonly string[];
  write: readonly string[];
  network: readonly string[];
  /** The static environment inside. Per-process values arrive with the command at `launch`. */
  env: Readonly<Record<string, string>>;
  /** Refused even inside `write`: git hooks, harness settings, anything that executes later. */
  denyWrite: readonly string[];
  /** The engine's endpoint. The one door every provider must open, so `wf` can reach the engine. */
  controlPlane: string;
};

/** A process the engine is about to start: the harness, or the shell a harness will be typed into. */
export type CommandSpec = {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
};

export interface SandboxProvider {
  /** Holds the whole profile or rejects, naming the axis it cannot hold. Never opens narrower. */
  open(profile: SandboxProfile, deadline: AbsoluteDeadline): Promise<Sandbox>;
}

export interface Sandbox {
  /** The host command that starts `root` inside the boundary. Pure; called once per process. */
  launch(root: CommandSpec): CommandSpec;
  /** Authority the provider could neither remove nor list: an open socket, a writable hook dir. */
  readonly residual: false | { detail: string };
  close(): Promise<void>;
}
```

**A sandbox holds the whole profile or does not open.** That one invariant is what keeps the seam
this small. A provider does not advertise what it can hold, and a sandbox does not report which
axes it held, because the answer is always all of them: a container without an egress proxy that
is asked for a domain list rejects at `open`, it does not open wider and say so afterwards. The
engine therefore records `sandbox` by that provider's name on every axis, and the only thing a
sandbox reports about itself is `residual`, the authority it knows it left behind.

`launch` is a prefix on the root process's own argv. For the host provider it is `srt -s <file>`,
the file written at `open`; there is no other object, the boundary is the running process. A
container provider creates the box at `open` with the profile as its mounts, and `launch` is
`docker exec` of the root inside it. A remote provider syncs the working directory at `open` and
`launch` is an exec on that machine. The root differs by backend and that is the backend's
business: for a headless agent it is the harness itself, once per turn process, through the same
`launch` with the same profile for the life of the agent; for a pane it is the pane's shell, the
outermost process, which the study found to be the one topology that holds, and the harness is
typed into it. The pane adapter today opens a fresh pane per operation, so it too launches more
than once. Per-process values, the operation binding above all, ride in the command's `env`; the
profile's `env` is the static allowlist beneath them.

Adapters compose with the seam in one direction. The engine opens the sandbox, hands it over in
`HarnessActivation`, and the adapter starts every root through `launch` and no other way. It never
builds a sandbox or sees a profile. Any pairing works: a pane whose shell is
`docker exec -it box zsh` is a host Herdr pane living in a container.

| | host (`srt`, Seatbelt) | container | remote |
| --- | --- | --- | --- |
| shares with the host | toolchain, caches, every path in the profile | exactly the mounts | nothing; the tree is synced |
| network | domain allowlist, a real boundary | proxy sidecar, or rejects a domain list | provider's own |
| harness credential | read in place; claude needs one keychain file | copied or minted in | minted in |
| status | daily use | built and smoke-tested | not built |

**The profile is generated by one pure function, never hand-written per agent.** It sums the held
grant with what the harness needs merely to run, which is a fact about the harness and so lives
in `spec.ts` beside its other strings: state directory, credential, caches, model-traffic
domains, and the files that execute later and must be refused. The workflow's vocabulary never
contains `~/.claude` or `api.anthropic.com`; the record does, because the agent can read them.

**Inside a sandbox, the harness's permission prompts are off.** Seatbelt underneath is answering
every question a prompt would have asked, on every turn, without a person. That is where
`danger-full-access` and `--force` belong. The adapter chooses that variant from the isolation
it was activated with; `spec.ts` holds the strings for both variants and no policy.

**A sandbox cannot be shed from inside.** The study tested a detached background child, tty input
injection into the parent shell, and a login item that would run unsandboxed later. All denied.
That is what `sandbox` means in the record. A provider that cannot make that promise is `none`
with a reason.

**A sandbox has doors, and the record names them.** A permitted domain plus a token the agent
holds is an exfiltration path for everything readable, and the model API is one too; the egress
list is the compensating control for every credential inside, which is why `network` is a domain
list and not a boolean. A git hook, a harness settings file, a lockfile installed outside: writable
inside, executed on the host later, so `denyWrite` carries the ones the harness table knows and
the rest is `residual`. The Docker socket is the host and the Herdr socket is every other pane; a
profile never contains a socket, and a provider that must open one reports it as `residual`.

### Channels between agents

A boundary that stops an agent reaching the host also stops it reaching the engine and its peers
unless a door is opened on purpose.

**The control plane is the one door every provider opens.** The endpoint is a unix socket in the
run directory. `srt` denies unlisted unix sockets, a container does not see a host socket, a
remote machine has no socket to see. The profile carries the endpoint, `open` makes it reachable,
and `wf` is inside on `PATH`. A provider that cannot do both cannot hold an agent, because an
agent that cannot call `wf result` cannot answer.

**Messaging crosses sandboxes for free.** A message goes `wf send`, engine, `HarnessTurn.deliver`.
The engine owns the inbox and the peer's provider presents the prompt. Two agents in different
containers talk exactly as well as two on the host, through the same door. There is no
agent-to-agent channel to preserve and this design creates none.

**Shared files do not cross.** [`messaging.md`](messaging.md) puts durable state in shared files,
and the review workflows coordinate through a ledger in the worktree. That holds while every
agent sees the same working directory, which is true on the host and inside one container, and
false the moment two agents live in different runtimes. A workflow that mixes runtimes must carry
state through results and messages, or the providers must agree on a shared tree. Not designed
here; recorded so the first mixed workflow does not discover it by losing a ledger.

### The harness level

The adapter translates the grant into the harness's own permission configuration and leaves the
prompts on, set to never ask:

| | claude | codex | cursor | pi |
| --- | --- | --- | --- | --- |
| read / write | OS sandbox on shell children, `--add-dir` | `sandbox_mode`, `writable_roots` | `--sandbox`, `--add-dir` | none |
| network | domain rules | a boolean | tri-state and allowlist | none |
| env | none | none | none | none |
| use | `--allowed-tools`, argument-scoped | mostly ambient | file rules, no flag | tool names only |
| a denied call | blocked | blocked | blocked | never denied |

The level is uneven and the record says so, per axis. Codex holds a boolean, so a domain list
widens to "any" and is recorded as `harness` with that detail, or refused if the ceiling forbids
the widening. No harness holds `env`; the engine's child environment does, at every level. Pi holds
nothing, so on pi every axis is `none` and the default floor refuses it. Claude's native sandbox
keeps the harness process outside its own boundary and so withholds claude's credential from the
agent, which no provider can do; it may also run inside a provider's sandbox as a second layer,
and the record shows the outer one.

## What the record says

```ts
export type Enforcement =
  /** `by` names the provider or the harness feature: `"srt"`, `"box"`, `"claude sandbox"`. */
  | { isolation: "sandbox" | "harness"; by: string }
  | { isolation: "none"; reason: string };

/** What the agent actually holds. Recorded once at activation; fixed for the life of the agent. */
export type HeldGrant = {
  granted: Grant;
  /** What the workflow asked for. Every axis below is at or under it, never above. */
  isolation: Isolation;
  read: Enforcement;
  write: Enforcement;
  network: Enforcement;
  env: Enforcement;
  /** What the harness needed so it could run: state, credential, caches, model domains. */
  harness: Grant;
  /** Copied from the sandbox; `false` at the harness level, which leaves nothing behind it. */
  residual: false | { detail: string };
};
```

The engine fills this in, not the adapter or the provider. Under `sandbox` every axis is the
provider's name; under `harness` each axis is what the table above says that harness holds; under
`none` each axis carries the reason. `harness` is never read as `sandbox`, the way an absent cost
is never read as zero anywhere else in this engine. A record showing two granted tools for a
codex agent launched with `danger-full-access` and nothing else is a false audit: a reader
concludes the agent could not write. The auditable answer to "what could this agent do" is
`HeldGrant`, never `Grant`.

## Rules

**Refuse, never downgrade.** A request above the ceiling, an isolation below the floor, an alias
with no provider asked for `sandbox`, a profile a provider cannot hold, a capability that cannot
be handed over: each fails activation and names the cause. A silent downgrade is the one outcome
nobody can audit, and a workflow written against one can never be made strict later. The only way
down is the workflow asking for a lower level, in the open, under the operator's floor.

**Tighten, never loosen.** A provider or adapter may hold more strictly than asked and record
what it applied; a blocked call surfaces as `blocked` through the turn outcome that exists. It may
never hold less and continue, because that report would arrive after the network call.

**Bypass only inside a sandbox.** The prompt-skipping flag is set at launch when, and only when, a
provider has put a boundary underneath. Under `harness` the prompts stay on and never ask. The
same flag with nothing underneath is `none`.

**Nobody asks a human.** There is no person at the pane, and a prompt is a stalled turn. A denied
call surfaces as `blocked`. Human approval is a checkpoint that stops dispatch, not a per-session
permission field.

**Nothing an agent runs raises its own authority.** No `wf` verb widens a grant or lowers an
isolation. A native fork holds at most what its parent held, at the same level.

**A harness's own subagent inherits the isolation, never the capability.** Reach is inherited by
construction. The operation capability must not be: today it travels in the environment, so every
child process can settle the parent's result slot and send as the parent, a result race and an
impersonation by default. A subagent that cannot call `wf` is right; it does work and the parent
reports. How the capability reaches `wf` without the environment is open in
[`messaging.md`](messaging.md).

**A skill is code.** Skills resolve by name from an operator-controlled root, mounted read-only.
A path from a workflow would be code injection; a writable skill is a command that runs at the
next harness startup.

**The session tool is not a capability.** The Herdr socket is a control channel over every other
pane; the study reads a denied private key through a neighbouring pane in one line. The pane
adapter keeps it out of the profile. An agent that needs to see sessions gets a read-only relay;
one that needs to run things in panes gets a session inside a container. Anything else is
`residual`.

## Where the code goes

| Package | Holds |
| --- | --- |
| `contract` | `Grant`, `CapabilityRef`, `Isolation`, `SandboxKind`, `Enforcement`, `HeldGrant`, and the containment check between two grants. Types and one pure function |
| `harness` | `src/sandbox/`: the `SandboxProvider` seam, the profile function, the providers. `spec.ts`: each harness's needs and its two launch variants. Each adapter: the grant-to-native translation for `harness` |
| `engine` | checking ceiling and floor, opening the sandbox, refusing activation, filling in `HeldGrant` |
| `cli-agent` | nothing |

`HarnessActivation` gains `grant`, `isolation`, and an opened `sandbox`. `HarnessSession` gains
nothing: the engine already has everything the record needs before it calls `activate`.
`ExecutionConfig` and `ExecutionRequirements` gain `sandbox`. Providers know nothing about
harnesses; the harness table knows nothing about providers; the profile function is where they
meet, and it is pure.

**The test surface is the seam.** The containment check and the profile function are pure and
tested as such. A fake provider records the profile it was opened with and prefixes `launch`
with a marker; the adapter conformance test then asserts that every process an adapter starts
carries the marker, and that the `harness` variant carries the translated flags instead. The
engine's tests assert on `HeldGrant` and on refusals by cause. None of it starts a live agent.
What a real provider actually denies is the study's evidence, and the first eval here.

## Build order

1. The child environment becomes an allowlist instead of a three-variable denylist. One function,
   one test, and the one axis the engine holds at every level for every agent.
2. The host provider: `open` writes the policy file the study already uses, `launch` prefixes
   `srt -s`. With it, the profile function and the harness needs in `spec.ts`.
3. The container provider, once one workflow has run under the first.

## Deliberately not built

- **A provider field on the agent.** A workflow that needs a provider constrains the runtime
  through `ExecutionRequirements.sandbox`, as it can for harness and backend.
- **A provider that declares what it can hold.** The invariant makes it redundant: `open`
  rejects, and rejecting is an error mode `open` needs anyway.
- **Nested providers.** A per-agent Seatbelt inside a container is a real topology, expressible as
  one provider whose `launch` calls another's. First-class when two providers must agree on how
  `residual` merges.
- **Per-command and per-path rules** like `Bash(git *)`. Three rule languages over different
  things and pi has none; a portable one is a lowest common denominator or a translator with
  silent holes. An operator writes them in the alias's native settings, under `harness`, as a
  supplement the record does not see.
- **Per-axis isolation.** One level per agent. An agent that wants SSH from inside a sandbox wants
  a door in the profile, which is the operator's.
- **A sockets axis.** The sockets that matter are each a full escape. Operator profile entries
  only, recorded as `residual`.
- **Optional capabilities.** A dropped request is a downgrade by another name. Add when a workflow
  actually runs both with and without one.
- **Harness-native passthrough on the author surface.** It would make workflows harness-specific.
  It lives in alias configuration beside `ModelSettings.providerOptions`.

## Alternatives considered

- **Bake `srt` in.** Least code and what runs today. Rejected because the container is the study's
  most promising direction, a remote provider is the only way this engine ever leaves the laptop,
  and the seam is one method and one invariant.
- **Sandbox only.** Rejected because a sandbox is blunt in ways that are not going away: no SSH,
  no keychain writes, no way to withhold the harness's own credential. Forcing those tasks out of
  the engine forces them out of the record.
- **Harness only.** The first draft. Three rule languages, pi with none, all of them requests. The
  study shows one mechanism covering every harness, and what harness rules are worth once the
  agent has a shell.
- **The sandbox inside the session adapter.** Then every adapter reimplements every provider and a
  tmux adapter learns Seatbelt. One direction of composition keeps both seams small.
- **The sandbox as a process runner.** `sandbox(run: RunProcess): RunProcess` is the same seam for
  a headless agent and no seam at all for a pane, which Herdr starts. An argv prefix is the one
  shape both backends can apply.
- **Operator-named roles instead of a grant.** `role: "reviewer"` is trivial for the common caller
  and hides the agent's needs in operator config, where a reader of the workflow cannot see them
  and another operator does not have them. Sugar over `Grant` later, if a workflow repeats one.
- **Isolation on the alias.** Rejected because the motivating case is two agents on one alias held
  differently, and a lowered level should be visible in the workflow where a reviewer reads it.
- **Isolation as a minimum.** Would let one workflow run on engines with and without a provider.
  Rejected because the levels do not nest: the publisher that works under `harness` breaks under
  `sandbox`, so the engine picking the stronger one is a downgrade in the other direction.
- **Network as a boolean.** True that only a boolean means the same thing on every harness.
  Irrelevant once a provider holds the list, and the egress list is what makes credentials inside
  a sandbox acceptable at all.
- **Clamp the request to the ceiling.** The silent downgrade in another costume. Refusal is loud
  once at activation instead of quiet on every call.
- **A ceiling as a predicate.** A ceiling nobody can read is a ceiling nobody can audit, and
  containment is not a language.
- **Absent grant means today's behaviour.** Makes the unsafe case the one you get by saying
  nothing. Nothing is implemented, so nothing is taken away.
- **Extend the operation capability.** Compaction and message turns have no result slot; a bearer
  token is presented by the agent while a sandbox is applied at process construction; and a token
  is an authority raise, the worst shape for a restriction.

## Open questions

1. **Nothing has measured a denied agent inside this engine.** The study measured denial by hand
   under `srt`. That a denial surfaces cleanly as `blocked`, at both levels and under both
   measured providers, is design, not evidence, and the first experiment here.
2. **Mixed runtimes in one workflow.** Two agents in different sandboxes share the engine and
   nothing else, and the shared-file pattern assumes one runtime without detecting it. Provider
   shared tree, workflow rule, or refusal to mix: undecided.
3. **A remote provider moves the control plane.** The endpoint is a unix socket today, and the
   operation capability rides in the environment. Both must cross a network. Foundation §7 says
   remote execution only swaps the transport; the remote provider is what forces that swap.
4. **Harness-level translation loss.** Codex widens domains to a boolean, cursor's rules live in
   files, claude's are argument-scoped. Two adapters before the translation is called a contract.
5. **Sandboxed is not disposable.** The worktree, a shared git object store, a shared package cache
   all outlive the agent. A private store per agent is the cheap win; exchanging work through a
   remote instead of a shared gitdir is the strong one. Profile concern or provider concern is open.
6. **No shell, no return channel.** `wf result` is a shell command. E2 measured a delimited-line
   channel at full delivery, so a no-shell agent is buildable, but it is a different channel.
7. **One ceiling and floor, or one per provider?** A container and a host sandbox share the host
   differently. One pair per engine is what is written.
8. **Per-agent credentials.** A credential inside a sandbox is spendable by everything inside it.
   Scoped short-lived tokens are the answer for untrusted workflows; nothing mints them.
9. **Outside participants.** A session the engine did not start, per
   [`composition.md`](composition.md), cannot be held at all: every axis `none`, the least
   trustworthy peer in every run.
