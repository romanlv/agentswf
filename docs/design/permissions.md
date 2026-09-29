# Permissions

What an agent may reach and use, who decides, how it is held, and what the record says afterwards.

A workflow opens agents and gives them work. Left alone, an agent can touch whatever the operator
can: write to disk, reach the network, read the developer's cloud credentials and past
transcripts. This document says how that is narrowed. It has two levels. At the first, a workflow
opens **sandboxes** as objects and puts agents in them. At the second, a harness's own permission
system holds a grant, and a workflow hands an agent its tools; that level is designed, not built.
Skills are handed over at neither level but beside both: a workflow names each agent's, and the
engine copies them to it ([[007-agent-skills|story 007]]).

This is the standing statement of the design. [[004-sandboxed-agents|Story 004]] built the first
level and records how it got there, and [[status]] says what is verified today.

Terms. A **harness** is the coding agent program: claude, codex, cursor, pi. An **adapter** is the
engine's driver for a harness under one session adapter, such as Herdr or a direct process. The
**operator** configures the engine on a machine. The **workflow** is the TypeScript that opens
agents. A **sandbox** is a boundary the workflow opens and puts agents in. A **provider** is one
implementation of it: `srt` (Anthropic's sandbox-runtime, Seatbelt on the host) or `docker` (a
container).

The evidence is [[sandbox-providers]], story 004's measurements of srt and docker with these
harnesses, and before it a study of the same harnesses under Seatbelt and in containers, verified
2026-08-08: `braintrust/docs/agent-sandboxing.md`, cited below as *the study*.

## Two kinds of agent

An agent opened with `sandbox` runs inside one. It sees its sandbox's reach, the git directories
its paths belong to, and its base: under srt the host system and the toolchain outside the denied
regions, under docker the image. It reaches the domains the sandbox names and its harness's model
domains. Its processes get exactly the environment variables the provider sets, and it has a
harness home of its own.

An agent opened without `sandbox` inherits all the engine's environment variables but two `WF_*`
ones (`childEnvironment` in `packages/harness/src/command.ts`): every API key, cloud credential and
SSH socket the developer holds. The working directory is where it starts, not where it stops.
Codex runs with `sandbox_mode="danger-full-access"` and cursor with `--force`, because E1 and E2
granted everything so they could measure result delivery instead of permission prompts.

## The model

**The workflow restricts itself.** A sandbox makes agents safe from their inputs: a replayed
reviewer cannot read the answer key, and a coder cannot leak a token to a domain it read about. It
does not make a stranger's workflow safe to run: the workflow is trusted code, and the operator
sets no ceiling on what it asks for. One exception is built: `awf run --sandbox` gives the whole
run one sandbox of the operator's, every agent runs in it, and a workflow that opens its own is
refused. It exists so that an evaluation can hold every variant to one reach without trusting any
of them to ask for it ([[010-eval-isolation|story 010]]). A ceiling a workflow's own sandboxes fit
under can return later, per provider (open question 7).

**A sandbox is three things:**

1. **Reach**: which host paths the agents see, read-only or writable, and which domains they reach
   beyond their models. It is common to every provider and means the same under each: srt enforces
   it by re-allowing a path, docker by mounting it. A path is seen at the same path inside.
2. **Environment**: the base the agents start from, under a key named for the provider: the host
   and its toolchain for `srt`, an image for `docker`. Naming the key pins the provider; leaving it
   out uses the operator's default, srt when installed, else docker. srt is the default because it
   runs the project's own toolchain, which an image lacks.
3. **The instance**: an object with a key and a lifetime, from `open` to the end of the run.
   Sharing it is how agents share a box. A spec given inline to one agent is shorthand for a
   private instance.

**Absent means no sandbox.** `sandbox: {}` is the reader: it reads its working directory, writes
nothing, reaches only its model, and sees nothing else under the operator's home, the temp
directories or harness state. That is the replayed reviewer, the case worth making effortless.

**A sandbox is a trust boundary.** Agents in one sandbox share its files and may reach each other's
homes, temp directories and doors: one could post a result as its sibling, as any two agents under
one uid can. Agents in different sandboxes reach none of each other's. So agents whose outputs must
be independent go in separate sandboxes: replay variants, and a judge and what it judges. An
inline spec, the easy path, is already private.

**The provider is not on the alias.** The workflow chooses reach and, when it cares, the
environment. Neither goes on a runtime alias, because `ExecutionConfig` flows into every usage
record, and reach is the most volatile vocabulary in the project. The sandbox record carries it
instead.

The first version of this design had the workflow name an isolation level per agent, the operator
bind a provider to an alias under a ceiling and a floor, and a sandboxed reader as the default.
The story's "What this reverses" says why each changed.

## Example

A coder and a tester share a container; a reviewer gets a private reader; a lead works in a pane.

```ts
const headless = { placement: "headless" } as const;

const box = await workflow.sandboxes.open({
  key: "build",
  write: ["."],
  network: ["registry.npmjs.org"],
  docker: { image: "awf-agent:node22" },
});
const coder = await workflow.agents.open({ key: "coder", runtime: codex, ...headless, sandbox: box });
const tester = await workflow.agents.open({
  key: "tester", runtime: claude, ...headless, metered: true, sandbox: box,
});

// A spec instead of a ref: a private sandbox on the default provider.
const reviewer = await workflow.agents.open({ key: "reviewer", runtime: codex, ...headless, sandbox: {} });

// srt: the host's toolchain instead of an image. Only the environment key differs.
const lint = await workflow.sandboxes.open({ key: "lint", write: ["."], srt: {} });
const lead = await workflow.agents.open({ key: "lead", runtime: claude, placement: "pane", sandbox: lint });
```

The types are `SandboxSpec`, `SandboxOpenSpec`, `SandboxRef` and `InlineSandboxSpec` in
`packages/contract/src/workflow/sandboxes.ts`. What is refused at open, and why the surface has
this shape, is in the story's "The author surface". A refusal names its cause: a spec is held
whole or not at all.

## Isolation

Harness flags are not a boundary. An agent with a shell can relaunch its own harness with
different flags, so `allowedTools` and `sandbox_mode` bind a cooperative agent and nobody else. A
sandbox lives below the harness, which cannot see it, let alone lift it. It is the only level that
holds an adversarial agent, and the only one that holds pi, which has no permission system.

A sandbox is also blunt: it denies SSH, keychain writes, and installs that unpack forbidden
filenames, and it cannot be argued with. Harness rules are finer, argument-scoped on claude, and
right when a task needs something a sandbox breaks and the operator trusts the agent to cooperate
([[#The harness level]]).

### The seam

A sandbox is applied once, to a process, at launch. `srt -s {file} -- {harness executable}` starts
the harness under Seatbelt, and every turn, tool call, shell and subagent it spawns runs under that
policy until the process exits. Nothing is wrapped per prompt or per tool; the engine never sees a
tool call. So the seam is shallow: **a provider opens a sandbox, and a sandbox admits agents**,
each of which launches its outermost process through the sandbox.

The seam is `packages/sandbox/src/seam.ts`, and the story's "The seam" gives each type. In short:

- `open` resolves nothing itself: the engine hands it a spec with every path absolute and real,
  and the git directories each path belongs to. It holds the whole spec, or rejects.
- `admit` readies the sandbox for one agent and returns an **occupant**. The engine serializes it
  per sandbox. An adapter sees only the occupant: it launches every process through
  `occupant.launch`, and a pane asks it for a terminal. It never builds a sandbox.
- `launch` turns the agent's command into a host command that runs it inside. `runProcess` runs
  that command as its own process group with exactly its environment variables, kills the group
  when a turn ends, then calls the provider's `reap` for whatever the command left inside.
- `release` ends one agent's processes and its door; `close` ends the sandbox, after every
  release, when the run ends.

**Every provider holds seven invariants:**

1. **All or nothing.** `open` and `admit` hold everything asked, or reject before anything
   launches. The engine has no per-provider code.
2. **Same paths.** The working directory, reach paths, homes and launchers have the same paths
   inside as on the host. Nothing translates a path.
3. **The door.** Each agent's launcher runs inside and reaches its endpoint. No agent writes to a
   launcher or reaches a door in another sandbox.
4. **Reach, and nothing else.** Unreadable inside: the operator's home, temp directories and
   harness state, the run root outside this sandbox's directory, and other sandboxes. No domain
   beyond the models and `network`, and no model-side web search.
5. **Trust stops at the boundary.** Invariants 3 and 4 hold between sandboxes.
6. **A killed turn leaves nothing running,** so the next turn resumes a session nothing else
   writes. Each provider has one known exception: under srt, a process that starts its own session
   escapes the group kill and runs, confined, until it exits (X21); under docker, a process that
   leaves its group runs until `close`.
7. **Nothing outlives `close`,** except the agents' homes, and under srt a process that started its
   own session (X21).

**What checks them.** The conformance suite in `@agentswf/sandbox/testing` runs `sh` through a provider
and checks invariants 2, 3, 6 and 7. It checks 4 and 5 only for a provider that confines, which
the fake does not, so against the fake they are skipped. Each provider's local test
(`*.local.test.ts`) runs the suite against the real provider, and adds the network and the
provider's own cases. No test yet covers invariant 1 as such; each refusal has its own test.
What real agents are denied is checked by the `sandbox-*` evals, from the agents' own transcripts
([[testing]]).

**A sandbox holds the whole spec or does not open.** That one invariant is what keeps the seam
small. A provider does not advertise what it can hold, and a sandbox does not report which parts
it held, because the answer is always all of them: it rejects at `open` or `admit`, never opens
wider and says so afterwards.

**What a harness needs to run is a fact about the harness**, in
`packages/harness/src/sandbox-needs.ts`: the variables that point it at its home, the credential to
seed, first-run answers, its model domains, its executable and the install tree it reads, and the
flags that take away what reaches past egress: model-side web search (X15), codex's apps and
plugins (X23), pi's extensions. The workflow never names `~/.claude` or `api.anthropic.com`; the
record does, because the agent can reach them. cursor has no entry and is refused.

| | srt | docker |
| --- | --- | --- |
| a sandbox is | a base profile, and a profile file per agent | one container, with an `--internal` network and a filtering proxy |
| shares with the host | the system and the toolchain, outside the denied regions | exactly the mounts |
| network | srt's domain allowlist | the proxy's CONNECT allowlist, port 443 |
| the door | the agent's own socket in its profile | a stdio relay over `docker exec -i` (X6) |
| a killed turn | the group dies; a process that starts its own session survives it and `close`, confined (X21) | the in-box group, killed by its recorded pid; a process that leaves its group lives until `close` removes the box |
| agents in one sandbox | each lists only its own socket | one uid: each can read another's environment variables, token included, and reach its door |
| panes | in the run's Herdr | in the box's own Herdr, of the version the host runs |

How each provider does it, and why, is in the story's provider sections and its implementation
notes; a provider's known leftovers are in [[sandbox-providers]], not in a type.

### A fresh harness home

A sandboxed agent never sees the operator's harness state. Protecting individual files cannot be
complete: the operator's harness state holds code the host runs (codex's binary sits under
`~/.codex`, and hooks, plugins and extensions under the others), which changes with every release,
and transcripts sit beside it. Write access is host code execution; read access exposes past
transcripts, the answers a replay must not see.

So the engine gives each sandboxed agent a home of its own under its sandbox's directory, and the
workflow never declares it:

- **It holds the credential and first-run answers, nothing else of the operator's.** codex and pi
  get a copy of `auth.json`; claude gets its `CLAUDE_CODE_OAUTH_TOKEN` as an environment variable
  instead, and is refused without it. Each harness's `defaults` are written fresh: claude's
  onboarding, folder trust and bypass answers, codex's folder trust, pi's shell. A refreshed copy
  is written back to the operator's file, only if that file has not changed since it was copied.
  Whether a copy's refresh logs the operator out is X13, not yet measured.
- **The operator's skills, `AGENTS.md` and memory are absent**, which is right for a replay. A
  repository's own `AGENTS.md` in the working directory is still read. The skills the workflow
  names for the agent are copied into the home while it is staged, before it moves into place.
- **Accounting reads usage from the home**, and the homes stay in the run directory as evidence
  for a contamination audit.

### Doors

A boundary that stops an agent reaching the host also stops it reaching the engine, unless a door
is opened on purpose.

**The control plane is the one door every provider opens.** The endpoint is a unix socket per
agent under `/tmp`, not the run directory, because `sun_path` is 104 bytes on macOS. The launcher
beside it runs the `wf` command, bundled into one file so it runs in any sandbox that has bun. srt
lists the agent's socket in its profile. A container cannot connect to a host socket (X6), so
docker relays each connection over `docker exec -i`. A provider that cannot open the door cannot
hold an agent, because an agent that cannot call `wf result` cannot answer.

**The connection says who is answering, between sandboxes.** Within one docker box, agents share a
uid and can reach each other's doors, as the trust boundary allows. Confining agents against each
other takes separate sandboxes.

**Messaging crosses sandboxes for free.** A message goes `wf send`, engine,
`HarnessTurn.deliver`. The engine owns the inbox and the peer's provider presents the prompt. Two
agents in different sandboxes talk exactly as well as two on the host, through the same door.
There is no agent-to-agent channel to preserve and this design creates none.

**Shared files cross only within a sandbox.** [[messaging]] puts durable state in shared files,
and the review workflows coordinate through a ledger in the worktree. That holds while agents
write the same tree, which agents in one sandbox with `write: ["."]` do. Agents in different
sandboxes, or in a reader, must carry state through results and messages (open question 2).

**The session tool is not a door.** The Herdr socket is a control channel over every other pane;
the study reads a denied private key through a neighbouring pane in one line. Under srt it lies
under the denied `~`, so a pane agent cannot reach the run's Herdr. Under docker, panes are in a
Herdr inside the box, which its agents may drive within the trust boundary, and which reaches
nothing outside it.

### Panes

A pane agent needs a terminal the operator can watch and Herdr can drive. Herdr detects an agent
from the processes it can see, and `agent start` refuses a pane whose root process is not a shell
(H1, H4). So a sandboxed harness is **typed, then adopted**: the pane's shell runs a prelude that
execs a confined shell, the engine waits for a prompt only the confined shell can draw, types the
harness, and adopts it by name. The occupant describes which Herdr the pane lives in and what is
typed; the Herdr host does the rest. No token crosses an argv: the prelude reads it from a file it
deletes. The story's "Panes" section has the detail.

Under srt the pane opens in the run's Herdr. Under docker it opens in a Herdr inside the box,
which the operator watches with the `docker exec -it … herdr` the run prints (H2, H3); the host
refuses a box whose Herdr is not the version it drives.

### The harness level

Designed, not built. A workflow would hand an agent a **grant**, which the adapter translates into
the harness's own permission configuration, leaving its prompts on and set to never ask:

```ts
/** An allowlist per axis. Absent means the minimum on that axis. */
export type Grant = {
  /** Paths readable beyond the working directory, as `SandboxReach.read`. */
  read?: readonly string[];
  /** Paths writable, as `SandboxReach.write`. */
  write?: readonly string[];
  /** Domains the agent's own commands may reach, as `SandboxReach.network`. */
  network?: readonly Domain[];
  /** Capabilities handed over: `tool:shell`, `mcp:github`. */
  use?: readonly CapabilityRef[];
};

/** Namespaced by convention. The grammar waits until two adapters show what is portable. */
export type CapabilityRef = string;

// AgentOpenSpec would gain:  grant?: Grant.
```

An agent asks for the harness level by carrying a `grant` and no `sandbox`, in the open, where a
reader of the workflow sees that a cooperative agent is trusted with it. That is the agent that
needs SSH, which a sandbox denies by design. `use` applies with or without a sandbox: tools and MCP
servers are what an agent has none of until the harness hands them over, as a route is granted for
messaging. A sandboxed agent's fresh home already holds none of the operator's. Skills are not in
`use`: `AgentOpenSpec.skills` names them, with or without a grant.

| | claude | codex | cursor | pi |
| --- | --- | --- | --- | --- |
| read / write | OS sandbox on shell children, `--add-dir` | `sandbox_mode`, `writable_roots` | `--sandbox`, `--add-dir` | none |
| network | domain rules | a boolean | tri-state and allowlist | none |
| environment variables | none | none | none | none |
| use | `--allowed-tools`, argument-scoped | mostly ambient | file rules, no flag | tool names only |
| a denied call | blocked | blocked | blocked | never denied |

The level is uneven. Codex holds a boolean, so a domain list widens to "any". No harness holds
environment variables; the engine's child process does. Pi holds nothing, so it would be refused.
Claude's native sandbox keeps the harness process outside its own boundary and so withholds
claude's credential from the agent, which no provider can do; it may also run inside a provider's
sandbox as a second layer.

## What the record says

`output.json` lists each sandbox once (`OutputRecord.sandboxes`): its key, provider, resolved spec,
directory, the git directories its paths belong to, every domain reachable in the end, docker's
image digest or srt's toolchain, and every agent admitted with its home, including one whose turns
never completed. Membership lives there, not in the accounting, which would miss an agent that
failed before its first operation.

An agent without a sandbox has no entry: the record says nothing held it, which is the truth. A
per-axis record of what held each axis at which level waits for the harness level; with one level
built, the sandbox record is the whole answer to "what could this agent do". Readers must not
switch exhaustively over `provider`, which grows.

## Rules

**Refuse, never downgrade.** A spec a provider cannot hold, a pinned provider that is not
installed, a pane in a sandbox that hosts none, a harness with no sandbox needs: each fails the
agent's open, before its channel opens, and names the cause. A silent downgrade is the one outcome
nobody can audit, and a workflow written against one can never be made strict later.

**Tighten, never loosen.** A provider may hold more strictly than asked: srt's base denies more
than reach names, and docker's image is its own base. What it held shows only in the resolved spec
and the final domains in `OutputRecord.sandboxes`. It may never hold less and continue, because
that report would arrive after the network call.

**Bypass only inside a sandbox.** Inside one, the provider answers every question a permission
prompt would have asked, so the prompts can be off. Outside, the same flags are what E1 and E2 left
behind, and nothing holds the agent.

**Nobody asks a human.** There is no person at the pane, and a prompt is a stalled turn. Human
approval is a checkpoint that stops dispatch, not a per-session permission field.

**Nothing an agent runs raises its own authority.** No `wf` verb opens a sandbox or widens one. A
running box cannot gain mounts, so an agent whose working directory lies outside its sandbox's
reach is refused.

**A harness's own subagent inherits the sandbox, never the right to report.** Reach is inherited
by construction. Answering must not be: the launcher is a path anything in the sandbox can run —
see [[design/README#What an agent inside a session sees|README]] — so a result race and an
impersonation are available to every subagent that sees the prompt. A subagent that does not call
`wf` is right. Making that a rule the engine enforces needs a per-process distinction the
filesystem does not give.

**A skill is code.** A workflow names each agent's skills, by a path or as a public skill in a git
repository ([ADR 0004](../adr/0004-skills-are-copied-per-agent.md)). The workflow runs with the
operator's authority, so a path it names is no more injection than its imports. What must not
happen is an agent writing code that runs later outside its reach: a writable skill is a command at
the next harness startup. So every agent gets a checked copy of its own, never a link to the
source, and a copy refuses links, which could carry what they point at into a sandbox. The same
holds for a git hook, and that part is built too: in a
writable git directory, what the host's git runs or follows is kept from the agent
(`protectedGitPaths` in `packages/sandbox/src/git.ts`). srt denies writing it; docker mounts the
existing paths read-only and moves one the agent creates into `quarantine/` at the next reap.

## Where the code goes

| Package | Holds |
| --- | --- |
| `contract` | the author surface (`workflow/sandboxes.ts`, `AgentOpenSpec.sandbox`, `WorkflowContext.sandboxes`) and `OutputRecord.sandboxes`; later `Grant` and `CapabilityRef` |
| `sandbox` | `@agentswf/sandbox`: the seam and resolution. `@agentswf/sandbox/srt`, `@agentswf/sandbox/docker`: the providers. `@agentswf/sandbox/testing`: the conformance suite and a fake. Imports contract only |
| `harness` | each harness's sandbox needs; `runProcess` running a sandboxed command; adapters launching through an occupant; the Herdr host's typed start; later, each adapter's grant translation |
| `engine` | a run's sandboxes, homes and write-back, admission and close, the bundled launcher, the record. Only `operator-runtime.ts` imports a provider, to install it |
| `wf` | nothing: it is bundled, not changed |

Providers know nothing about harnesses; harness knows the seam and no provider;
`scripts/check-boundaries.ts` holds both. A provider's unit tests fix its profile or its `docker`
arguments.

## Build order

The first level, in story 004:

1. The seam, the author surface, a fresh home per agent, and the record.
2. The srt provider, headless.
3. The docker provider, its default image, proxy and relay, headless.
4. Pane agents: under srt in the run's Herdr, under docker in the box's own.

Then, in order of need:

- **Credential rotation (X13):** whether a copy's refresh logs the operator out, and whether two
  refreshing copies trip reuse detection. It needs the operator's consent to measure.
- **An operator-replaceable srt toolchain.** It is derived from `PATH` today.
- **The whole workflow in a sandbox, and remote execution** ([[workflow-in-sandbox]]).
- **The unsandboxed child's environment variables as an allowlist** instead of a two-variable
  denylist.
- **The harness level, and `use` for tools and MCP servers.**

## Deliberately not built

- **An operator ceiling and floor over a workflow's own sandboxes.** A sandbox is the workflow
  restricting itself. `awf run --sandbox` replaces them rather than bounding them: one sandbox for
  the run, and none of the workflow's. When a stranger's workflow runs here, a ceiling it can work
  under returns, per provider (open question 7).
- **Passing named environment variables into a sandbox.** A sandbox's environment variables are
  exactly what the provider sets: the home variables, `PATH`, the harness's token and what the
  adapter adds. A variable a workflow names is a credential more often than not, and would need
  the egress list reasoned about with it.
- **A provider that declares what it can hold.** The invariant makes it redundant: `open` rejects,
  and rejecting is an error mode `open` needs anyway.
- **A residual type.** A provider's known leftovers are measured and go in `findings/`.
- **Closing a sandbox before the run ends.**
- **Nested providers.** A per-agent Seatbelt inside a container is a real topology, expressible as
  one provider whose `launch` calls another's. First-class when a workflow needs it.
- **Per-command and per-path rules** like `Bash(git *)`. Three rule languages over different
  things and pi has none; a portable one is a lowest common denominator or a translator with
  silent holes.
- **A sockets axis.** The sockets that matter are each a full escape.
- **Harness-native passthrough on the author surface.** It would make workflows harness-specific.

## Alternatives considered

The story's "Alternatives rejected" covers the sandbox's own shape: its surface, a shared box, the
door, credentials, the default provider and where the providers live. Of the rest:

- **Bake srt in.** Least code. Rejected because a container is tighter beyond reach, and the seam
  is small. Leaving the laptop is running the engine where the agents are
  ([[workflow-in-sandbox]]), not a provider.
- **Harness only.** Three rule languages, pi with none, all of them requests. One mechanism below
  the harness covers every harness.
- **The sandbox inside the session adapter.** Then every adapter reimplements every provider, and
  a tmux adapter learns Seatbelt. One direction of composition keeps both seams small.
- **The sandbox as a process runner.** `sandbox(run: RunProcess): RunProcess` is the same seam for
  a headless agent and no seam at all for a pane, which Herdr starts. A command for a headless turn
  and a terminal for a pane are what both session adapters can apply.
- **Network as a boolean.** Irrelevant once a provider holds the list, and the egress list is what
  makes a credential inside a sandbox acceptable at all.

## Open questions

1. **How a denial surfaces.** The probe evals show the OS refusing each canary in an agent's own
   transcript. Whether a harness reports a denied call as `blocked`, or works around it, is not
   measured.
2. **Mixed sandboxes in one workflow.** Two agents in different sandboxes share the engine and
   nothing else, and the shared-file pattern assumes one tree without detecting it. Provider shared
   tree, workflow rule, or refusal: undecided.
3. **Remote execution runs the engine where the agents are.** Authority today *is* the unix
   socket: the agent is trusted because it opened a file only it can reach, and nothing about that
   crosses a network. So the control plane never does: the engine moves to the remote machine, and
   only the invocation and `output.json` travel ([[workflow-in-sandbox]]).
4. **Harness-level translation loss.** Codex widens domains to a boolean, cursor's rules live in
   files, claude's are argument-scoped. Two adapters before the translation is called a contract.
5. **Sandboxed is not disposable.** The worktree, a shared git object store and a shared package
   cache all outlive the agent, and a worktree's store holds later commits. A private store per
   agent is the cheap win; the history-free fixture repository is [[010-eval-isolation|story 010]]'s.
6. **No shell, no return channel.** `wf result` is a shell command. E2 measured a delimited-line
   channel at full delivery, so a no-shell agent is buildable, but it is a different channel.
7. **A ceiling, and one per provider?** A container and a host sandbox share the host
   differently. Needed once workflows come from someone else.
8. **Per-agent credentials.** A credential inside a sandbox is spendable by everything inside it,
   and under docker readable by every agent in the box. Scoped short-lived tokens are the answer
   for untrusted workflows; nothing mints them.
9. **Outside participants.** A session the engine did not start, per [[composition]], cannot be
   held at all: the least trustworthy peer in every run.
