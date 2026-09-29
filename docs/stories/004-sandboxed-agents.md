---
id: "004"
title: Run agents inside sandboxes the workflow opens
summary: A workflow opens a sandbox, giving what it can reach and, optionally, which provider runs it, then opens headless or pane agents inside it or in a private one; srt and docker are the first providers.
type: story
status: done
discovered_in: "eval-isolation planning, 2026-09-24"
depends_on: []
---

# Run agents inside sandboxes the workflow opens

## Outcome

A workflow opens a sandbox as an object and puts agents in it:

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

// A spec instead of a sandbox: a private sandbox for this agent alone, on the default provider.
const reviewer = await workflow.agents.open({ key: "reviewer", runtime: codex, ...headless, sandbox: {} });

// srt: the host's own toolchain instead of an image. Only the environment key differs.
const local = await workflow.sandboxes.open({ key: "lint", write: ["."], srt: {} });
const linter = await workflow.agents.open({ key: "linter", runtime: pi, ...headless, sandbox: local });

// A pane in the box: an interactive TUI in the box's own Herdr session.
const lead = await workflow.agents.open({ key: "lead", runtime: claude, placement: "pane", sandbox: box });
```

- **The coder and the tester share one container.** They write the working directory, reach npm
  and their models, and see nothing else of the host.
- **The reviewer gets a private sandbox on the default provider, srt.** It reads its working
  directory, writes nothing, reaches only its model, and sees nothing else under the operator's
  home, temp directories or harness state.
- **The lead is a pane in the box.** Its TUI runs in a Herdr session inside the container, and
  `awf run` prints the command that shows it: `docker exec -it {box} herdr`. A pane in an srt
  sandbox opens in the run's own Herdr workspace, confined like any other agent there.
- **Each sandboxed agent gets a fresh harness home**, holding nothing but its credential file,
  if it has one. The workflow never declares it.
- **Every agent answers through `wf result` and is accounted for.** `output.json` lists each
  sandbox, its provider and its agents. An agent opened without `sandbox` runs as it does today.

Why now: an autoresearch loop replays merged MRs and scores how many known defects a review
variant finds. Today an agent can read review ledgers that hold the answers, past transcripts of
the same review, and GitLab. [[eval-isolation]] needs this story before
any score means anything.

## Three abstractions

1. **Reach**: which host paths the agents see, and which domains they reach. It is common to
   every provider and means the same under each; srt enforces it by re-allowing a path, docker
   by mounting it.
2. **Environment**: the base the agents start from, under a key named for the provider: the host
   and its toolchain for `srt`, an image for `docker`. Naming the key pins the provider; leaving
   it out uses the operator's default.
3. **The sandbox instance**: an object with a key and a lifetime. Sharing it is how agents share a
   box. A spec given inline to one agent is shorthand for a private instance.

**A sandbox is a trust boundary.** Agents in one sandbox share its files and may reach each
other's homes, temp directories and doors; an agent could post a result as its sibling, as any two
agents under one uid can today. Agents in different sandboxes reach none of each other's. **So
agents whose outputs must be independent go in separate sandboxes**: replay variants, and a judge
and what it judges. An inline spec, the easy path, is already private.

## Scope

In scope:

- **Experiments** that settle what srt and docker can hold (Task 0, done except X13).
- **The author surface**: `SandboxSpec`, `workflow.sandboxes.open` returning a `SandboxRef`,
  `AgentOpenSpec.sandbox`, and one grammar for domains.
- **The provider seam in `packages/sandbox`**: a provider opens a sandbox, and a sandbox admits agents.
- **A fresh harness home per sandboxed agent**, seeded with its credential. Accounting reads it.
- **The cli-agent bundled into one file**, so a launcher runs in any sandbox that has bun.
- **The srt provider, and the docker provider with a default image.**
- **A clean environment for every sandboxed process**: only what the provider sets.
- **Each harness's sandbox needs**, in `spec.ts`, including the flags that turn off model-side
  web search.
- **Headless turns through the sandbox**, each sandboxed process killed as a group and reaped.
- **Pane agents in a sandbox**, under both providers: srt in the run's Herdr, docker in the box's
  own Herdr.
- **`output.json` recording sandboxes and their agents.**
- **A live eval under both providers**, private and shared.

Out of scope:

- **The whole workflow in a sandbox, and remote execution**
  ([[workflow-in-sandbox]]). The engine's host is the operator's
  concern, and with the engine remote the control plane never crosses a network.
- **More than one operation per pane agent.** Sandboxed panes inherit today's limit
  ([[herdr-pane-settlement]]).
- **Closing a sandbox before the run ends.**
- **`permissions.md`'s operator ceiling and floor, harness-level isolation, and `HeldGrant`**
  ([[#What this reverses]]).
- **Git history in the working directory.** A worktree's object store holds later commits,
  including the merged fix a replay scores against. The history-free fixture repository stays in
  `eval-isolation`.
- **Other providers.** Apple's `container` (a VM per container) would be one more environment key
  and would need the same relay door as docker; its only host-socket forward is ssh-agent's.

## Context and evidence

### The engine today

- An agent inherits the engine's whole environment and filesystem. `childEnvironment` in
  `packages/harness/src/command.ts` removes only `WF_RUN` and `WF_CALL`.
- `WorkflowContext` exposes directories (`agents`, `participants`) whose `open` takes a keyed spec
  and returns a ref. A sandbox directory follows the same pattern.
- The agent's `wf` is a shell script that runs the host's bun (`process.execPath`, under `~`) on
  the `@agentswf/wf` source, against a per-agent unix socket. Launcher and socket share one
  directory under `/tmp` (`installAgentLauncher`, `CONTROL_PLANE_ROOT`). The prompt names the
  launcher. The wire is one JSON request and one reply per connection; the client half-closes.
- The runner opens the result channel and the harness session concurrently (`openAgent` in
  `workflow-runner.ts`).
- Accounting reads usage from the engine's `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
  `PI_CODING_AGENT_DIR`, and billing runs the host's `claude auth status` and `codex login status`.
- `runProcess` writes the prompt to stdin, closes it, and ends a turn with `child.kill("SIGKILL")`
  on the one process it started.
- The operator's harness state holds code the host runs: `~/.codex/packages/…/bin/codex` is the
  codex binary, and `~/.claude` and `~/.pi/agent` hold hooks, plugins, skills and extensions. Write
  access is host code execution; read access exposes past transcripts.
- `/tmp/claude-501/` holds the operator's Claude Code task outputs, and `$TMPDIR` eval work.
- Runs live at `{runRoot}/invocation-{uuid}/`, with `--run-root` defaulting under `~/.awf`. A run
  root can be anywhere.

### What the experiments showed

Task 0 ran on 2026-09-25: [[sandbox-providers]]. What changed the design:

- **Killing the launched process is not enough under either provider.** `srt`'s child survives
  (X1); a process-group kill ends it. `docker exec`'s processes survive in the box (X7); a
  recorded in-box pid and a group kill end them, and `--init` reaps them.
- **srt needs four things:** `--` before the command, or it reads the harness's flags as its own;
  the command's real path, as `~/.local/bin` is denied; `enableWeakerNetworkIsolation`, the one
  trustd lookup codex's TLS needs; and `GIT_CONFIG_GLOBAL`, as git refuses an unreadable
  `~/.gitconfig`.
- **A host socket is not connectable from a container** on OrbStack (X6). TCP to the host is
  unreachable from an internal network, and a FIFO does not cross the VM. A stdio relay over
  `docker exec -i` carried 50 concurrent calls in 24 ms, and keeps the socket's authority. A
  file-drop mailbox also works (about 50 ms), but would add a transport to the cli-agent and the
  control plane.
- **Headless claude, codex and pi need only their credential,** under both providers (X5, X9,
  X10): no trust, onboarding or bypass answers. claude runs on `CLAUDE_CODE_OAUTH_TOKEN` alone.
- **Model-side web search escapes egress** under srt (X15). codex's `-c web_search="disabled"` and
  claude's `--disallowed-tools WebSearch WebFetch` remove it; codex's `tools.web_search=false`
  does not.
- **Minimal model domains:** claude `api.anthropic.com`; codex, and pi on a ChatGPT login,
  `chatgpt.com` and `*.chatgpt.com`. pi's domains follow its provider.
- **srt's keychain residual did not reproduce** (X14): `security` cannot read the login keychain.
  The data-protection keychain was not probed.
- **The project's toolchain needs its install roots readable under srt** (X19): PATH directories
  alone break `npm`, whose library sits beside `bin/`.
- **All three harnesses run headless under srt with a clean environment** (X20): `HOME`, a `PATH`
  of the harness link and the toolchain, the home variables and the token. Nothing else of the
  engine's environment, such as another harness's token, needs to reach an agent.
- **A private docker sandbox costs 0.65 s to open and 0.3 s to close** (X12).
- **Panes work under both providers, one way each** (H1–H6). Herdr detects agents from the
  processes it can see, and `agent start` accepts only a pane whose root process is a shell.
  - A host pane running `docker exec` fails: Herdr sees only `docker` (H1).
  - Herdr's own server inside the box, driven by `docker exec {box} herdr …`, runs claude, codex and
    pi TUIs through `agent start`, `prompt` and `read`; the operator watches with
    `docker exec -it {box} herdr` (H2, H3).
  - An srt pane (`exec srt … zsh` as its root) is refused by `agent start`, but a harness typed in
    with `pane run` is detected and adopted with `agent rename`, then prompts and reads normally
    (H4). The same typed start works in the box (H5).
  - Closing the tab ends the agent's processes under both (H5, H6).
  - An adopted agent under a non-default home gets no `agent_session` from Herdr (H6).
  - TUIs need first-run answers that headless does not: claude's onboarding, trust and bypass, and
    codex's folder trust, without which the first prompt is lost (H3). pi needs none.

### What this reverses

[[permissions]] designs a sandbox seam. The user directed
these changes on 2026-09-24 and 2026-09-25; Task 6 updates `permissions.md`.

1. **The workflow opens sandboxes and chooses their reach.** `permissions.md` had the workflow name
   an isolation level per agent, and the operator bind a provider to an alias. The reach vocabulary
   survives as `SandboxReach`, on a sandbox. Settings stay off the alias, because `AgentExecution`
   flows into every `OperationRecord`.
2. **Absent means no sandbox.** `permissions.md` made a sandboxed reader the default; here the
   reader is `sandbox: {}`.
3. **No operator ceiling.** A sandbox is the workflow restricting itself: it makes agents safe from
   their inputs, not a stranger's workflow safe to run. A ceiling can return later, per provider
   (`permissions.md` open question 7).
4. **Agents in one sandbox trust each other.**
5. **No `residual` type.** A provider's known leftovers go in `findings/`; none is measured.

### Constraints

- `contract` is pure, and `WorkflowContext` and `AgentOpenSpec` are published types. A new
  environment key or optional field is additive; changing what a reach field means is not.
- The core names no provider. The engine opens sandboxes and admits agents through the seam; adapters
  only launch through what they are handed; providers live in `packages/sandbox`
  ([[#Where it lives]]).

## Proposed design

### The author surface

```ts
export type SandboxKey = string;

/**
 * A host name: exact (`registry.npmjs.org`), or `*.` and a name for its subdomains only
 * (`*.npmjs.org`, which does not match `npmjs.org`). No scheme, port, path or IP address.
 */
export type Domain = string;

/** What the agents inside see and reach. Every provider enforces it; each does so its own way. */
export type SandboxReach = {
  /** Host paths visible at the same path, read-only, beyond the sandbox's working directory. */
  read?: readonly string[];
  /** Host paths visible at the same path and writable. `"."` makes the working directory writable. */
  write?: readonly string[];
  /** Domains reachable beyond each harness's model API. */
  network?: readonly Domain[];
};

/** Anthropic's sandbox-runtime on this machine: the host system and the operator's toolchain. */
export type SrtEnvironment = Record<string, never>;

/** A container from `image`, running as the operator's uid. Absent image: the operator's default. */
export type DockerEnvironment = { image?: string };

/** At most one environment. Naming one pins the provider; naming none uses the operator's default. */
export type SandboxEnvironment =
  | { srt: SrtEnvironment; docker?: never }
  | { docker: DockerEnvironment; srt?: never }
  | { srt?: never; docker?: never };

export type SandboxSpec = SandboxReach & SandboxEnvironment;

export type SandboxOpenSpec = SandboxSpec & {
  key: SandboxKey;
  /** Defaults to the workflow's working directory. Always readable inside. */
  cwd?: string;
};

declare const sandboxRef: unique symbol;

/** A sandbox this run opened. Only the engine makes one; a look-alike object is not a ref. */
export interface SandboxRef {
  readonly [sandboxRef]: true;
  readonly key: SandboxKey;
  /** `"srt"` or `"docker"`. */
  readonly provider: string;
}

/** A spec given inline to one agent: a private sandbox. It cannot carry a ref's or an open spec's fields. */
export type InlineSandboxSpec = SandboxSpec & { key?: never; cwd?: never; provider?: never };

export interface SandboxDirectory {
  /** Opens a sandbox for this run. It closes when the run does, after every agent in it. */
  open(spec: SandboxOpenSpec): Promise<SandboxRef>;
}

// WorkflowContext gains:  readonly sandboxes: SandboxDirectory;
// AgentOpenSpec gains:    sandbox?: SandboxRef | InlineSandboxSpec;
```

**Reach:**
- A `read` or `write` path is visible at the same path; `write` implies read, and a path in both
  is writable. When they nest, the most specific path wins: `write: ["/a"]` with `read: ["/a/b"]`
  leaves `/a/b` read-only.
- With every field omitted, the agents read the sandbox's working directory, write nothing, and
  reach only their models: the **reader** a replayed reviewer needs.
- Beyond reach, each environment has its own base. srt's is the host outside the denied regions,
  so `/usr`, `/opt` and `/Library` stay readable. docker's is the image. Confidentiality beyond
  reach is stronger under docker.
- Paths resolve when the sandbox opens, against its working directory, with `~` expanded. Inline,
  the sandbox's working directory is the agent's. An empty or unresolvable path is rejected.
- Gitdirs are resolved at open for the working directory and every reach path.

**Rejected at open, each naming its cause:**
- two environments (tested with `!== undefined`, since `{ srt: undefined }` compiles);
- an unknown key, since a `const` spec loses excess-property checks (`satisfies SandboxSpec`
  helps authors);
- a `Domain` outside the grammar, and a path that re-allows `~` or the run root;
- a second `sandboxes.open` with a key already open;
- a ref the engine did not return (refs are tracked in a `WeakSet`), and a spec carrying `key`,
  `cwd` or `provider`;
- an agent whose working directory lies outside the sandbox's working directory and reach, or
  whose gitdir does, since a running box cannot gain mounts.

**Why this shape:**
- **Plain data plus one object.** A spec is a reusable `const`; a ref is how agents share a box,
  like `AgentRef`.
- **Common reach flat, the environment nested.** Provider settings cannot land in the wrong
  sandbox, and moving between providers changes one key.
- **Additive growth**, through environment keys and optional reach fields.
- **Eager, `async` opening.** A wrong image fails at `open`, and a box lives from `open` to the
  end of the run.
- **Keys scoped by call path**, like agent keys. A child workflow opens its own sandboxes, as a ref
  cannot pass through JSON arguments.

**The default provider is srt when installed, else docker.** srt runs the project's own toolchain
([[#The srt provider]]), which a default image lacks, and macOS `node_modules` do not run in a Linux
box. A workflow that wants docker's tighter base names `docker`.

### A fresh harness home per sandboxed agent

A sandboxed agent never sees the operator's harness state. Protecting individual files cannot be
complete: the executable files change with every harness release, and transcripts sit beside them.

- The engine creates the home under the sandbox's directory and copies in the credential. It mints
  directory names rather than deriving them from keys, which may contain `/` or `..`.
- **Credentials:** codex and pi get a copy of `auth.json`. claude gets nothing on disk and runs on
  `CLAUDE_CODE_OAUTH_TOKEN` from the engine's environment; without it, a sandboxed claude is
  refused at open.
- **A refreshed credential is written back.** A copy that refreshes may rotate the refresh token
  and invalidate the operator's (X13). After each turn, if the home's `auth.json` parses and its
  hash differs from the copy's, and the operator's file still hashes as it did when copied, the
  engine replaces the operator's file by an atomic rename, mode `0600`, and the written value
  becomes the new baseline. Several copies of one refresh token can still trip reuse detection
  when two of them refresh; X13 decides whether that needs more.
- The harness finds its home through `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `PI_CODING_AGENT_DIR`.
  Docker also sets `HOME`. srt keeps the operator's `HOME`, but `~` is denied, so what a tool needs
  under it must be in the toolchain.
- `homes/` exists before the sandbox opens, so a docker box mounts it once and later agents'
  homes appear inside (X17).
- Accounting reads usage from the home. Billing still asks the host's status commands about the
  operator's login, which the seed copies. Homes stay in the run directory as evidence.
- Skills, `AGENTS.md` and memory from the operator's home are absent, which is right for a replay.
  Mounting them read-only from an operator-controlled root is a later setting.

### Where it lives

Sandboxing is one package, `packages/sandbox`, so harness and engine hold no provider's code.
Contract names the providers on purpose: a workflow chooses one, so the author surface knows each
environment and its settings, and a new provider adds a key there.

| Entry | Owns |
| --- | --- |
| `@agentswf/sandbox` | the seam's types, and path and gitdir resolution |
| `@agentswf/sandbox/testing` | the conformance suite and its fake provider |
| `@agentswf/sandbox/srt` | `createSrtProvider`: profiles, the pure check, the first-open probe |
| `@agentswf/sandbox/docker` | `createDockerProvider`: the image, the proxy, the relay, the reaper, the box's Herdr |

- **The package imports contract only.**
- **harness imports only `@agentswf/sandbox`:** adapters launch through an `Occupant`, `runProcess` runs
  a `SandboxedCommand`, `spec.ts` returns `HarnessSandboxNeeds`, and the Herdr host takes a
  `PaneTerminal`.
- **engine imports `@agentswf/sandbox`** for resolution, the registry and admission. Only the
  composition root, `operator-runtime.ts`, imports a provider, to install it.
- **A provider imports the seam, never another provider.**
- `check-boundaries.ts` gains these rules.
- **The seam depends on nothing in harness.** `SandboxedCommand` declares the process fields it
  carries, and `runProcess` accepts it.

### The seam

```ts
export interface SandboxProvider<E> {
  /** Validates the raw environment settings, so untyped workflows are checked at run time. */
  environment(raw: unknown): E;
  /**
   * Holds the whole spec, or rejects naming what it cannot hold. Never opens narrower. The engine
   * calls `admit` on one sandbox at a time, `release` once per occupant, and `close` once, after
   * every release.
   */
  open(spec: ResolvedSandbox<E>, context: SandboxContext): Promise<OpenedSandbox>;
}

/** The providers an operator installed, keyed by the environment name a spec uses for each. */
export type SandboxProviders = {
  readonly installed: Readonly<Partial<Record<SandboxEnvironmentKey, SandboxProvider<unknown>>>>;
  readonly default?: SandboxEnvironmentKey;
};

/** The spec resolved: every reach field present, paths absolute and real, domains lowercased. */
export type ResolvedSandbox<E> = { readonly [K in keyof SandboxReach]-?: NonNullable<SandboxReach[K]> } & {
  key: SandboxKey;
  cwd: string;
  gitdirs: readonly Gitdir[];
  environment: E;
};

/**
 * A git directory `cwd` or a reach path belongs to. Readable inside; writable when a path it
 * serves is, so a writable worktree commits under every provider. Never its `hooks`, `config` or
 * `modules`, which the host's git would run.
 */
export type Gitdir = { path: string; writable: boolean };

/** How long `runProcess` waits for `reap`; a provider's must finish well within it. */
export const REAP_GRACE_MS = 5_000;

export type SandboxContext = {
  /** Every run's directory. Denied inside, except this sandbox's own directory. */
  runRoot: string;
  /** This sandbox's directory, holding `homes/`. */
  directory: string;
  deadline: AbsoluteDeadline;
};

export interface OpenedSandbox {
  /** Readies the sandbox for one agent, or rejects: a cwd outside reach, a harness the image lacks. */
  admit(agent: AgentContext): Promise<Occupant>;
  /** Ends everything started inside and removes what `open` made, except `homes/`. */
  close(): Promise<void>;
  /** What only the provider knows, for the run's record's `provided`: docker's image, srt's toolchain. */
  readonly record?: JsonObject;
}

export type AgentContext = {
  cwd: string;
  /** This agent's seeded home, under `directory/homes/`. */
  home: string;
  harness: HarnessSandboxNeeds;
  door: AgentDoor;
};

export interface Occupant {
  /**
   * The host command that runs `root` inside, for this agent. `root.env` is the adapter's overlay;
   * the command's `env` is the whole environment. `stdin`, `timeoutMs` and `signal` pass through.
   */
  launch(root: SandboxProcess): SandboxedCommand;
  /** Stops this agent's processes and its route to the door. Never the engine's channel. */
  release(): Promise<void>;
}

/** The process fields the seam carries, which harness's `runProcess` accepts. */
export type SandboxProcess = {
  argv: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

/** Run by `runProcess` as its own process group with exactly `env`, inheriting nothing. */
export type SandboxedCommand = SandboxProcess & {
  group: true;
  /** Ends what the command left running inside, after `runProcess` has killed its group. */
  reap?(): Promise<void>;
};

/** The agent's one way back to the engine. */
export type AgentDoor = {
  endpoint: string;
  /** The path the prompt names. It must run at this path inside and reach `endpoint`. */
  launcher: string;
  /** The launcher's contents for a box, copied to `launcher` inside it: `bundle` run by `bun` from `PATH`. */
  boxScript: string;
  /** The bundled cli-agent, a host file copied to the same path inside a box. */
  bundle: string;
  /** Host paths the host launcher reads: its interpreter and the bundle. */
  reads: readonly string[];
};

export type HarnessSandboxNeeds = {
  /** Variables pointing the harness at its home. */
  env: Readonly<Record<string, string>>;
  /** Credential files copied into the home, and written back when a turn refreshes them. */
  seed: readonly { from: string; to: string }[];
  /**
   * Config files written fresh into the home for a pane: claude's onboarding, trust and bypass
   * answers, codex's folder trust. Headless needs none (X5, H3).
   */
  defaults(cwd: string): readonly { path: string; contents: string }[];
  /**
   * Credentials passed in the environment instead of a file, by variable: claude's
   * `CLAUDE_CODE_OAUTH_TOKEN`, read from the engine's. Never on a command line.
   */
  secrets: Readonly<Record<string, string>>;
  /** Model domains, for this agent's model and provider. */
  domains: readonly Domain[];
  /** The executable's name: `launch` receives it as `argv[0]`. Docker finds it on the image's `PATH`. */
  command: string;
  /** Its real path, which srt runs in `command`'s place, found on the `PATH` srt gives the agent. */
  executable: string;
  /**
   * Host paths srt must allow for the command to run: its install tree and interpreter. Never a
   * harness state root, though an install tree may lie inside one (codex's `~/.codex/packages/…`).
   */
  reads: readonly string[];
};
```

The engine keeps the installed providers, keyed by environment name, and the default. Adapters see
only an `Occupant`.

- **`runProcess` runs a `SandboxedCommand` as its own process group, with exactly its `env`.** The
  engine's environment never reaches an agent, so a codex agent never holds claude's token. srt
  sets the agent's whole environment (X20); docker's `env` is what its client needs, and the box
  receives only the variables named with `-e`. On timeout, abort and
  normal exit alike, it kills the group, then awaits `reap` within the deadline; a failed reap is
  logged and never changes the turn's result. That covers srt (X1) and docker (X7). Unsandboxed
  processes run as today. The operator CLI already turns SIGINT and SIGTERM into cancelled turns.
- **`admit` is serialized per sandbox.** srt writes a profile per agent; docker grows its proxy's
  allowlist, and the record keeps the final one.
- **A private sandbox is closed at once when its agent fails to open,** so a retry can reuse the
  key.
- **Close order:** the host closes sessions, each occupant is released, the engine closes each
  channel, then each sandbox closes. Teardown took 0.3 s (X12), inside the 5 s cleanup grace. A
  `sandboxes.open` still in flight at close is closed when it lands.
- **Reopening an agent:** an omitted `sandbox` means unchanged. A different ref, or an inline spec
  that resolves differently, is a conflict.

**Every provider holds seven invariants,** each with a conformance test against a fake provider and
a local test for each real one:

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
6. **A killed turn leaves nothing running,** so the next turn resumes a session nothing else writes.
7. **Nothing outlives `close`,** except `homes/`.

### Panes

A pane agent needs a terminal the operator can watch and Herdr can drive. What differs between
providers is which Herdr it lives in, what runs in the pane before the harness, and how the
harness is named there, so that is what an occupant describes:

```ts
export interface OpenedSandbox {
  // … admit, close, record, as above; `record.watch` shows the operator the sandbox's own Herdr
  /**
   * Whether it hosts pane agents. A sandbox-level fact, so a pane in one that does not is refused
   * before the agent's channel opens, as an occupant exists only after admission.
   */
  readonly panes?: true;
}

export interface Occupant {
  // … launch, release, as above
  /** The terminal a pane agent runs in; present when the sandbox has `panes`. */
  pane?(): Promise<PaneTerminal>;
}

export type PaneTerminal = {
  herdr: PaneHerdr;
  /**
   * Typed into the new pane's shell. It sets the pane's whole environment, loads the agent's
   * secret from a file it then deletes, so no token is on a command line, and `exec`s the confined
   * shell that becomes the pane's root process.
   */
  prelude: string;
  /**
   * What the confined shell's prompt shows, and the typed prelude cannot: the one proof that the
   * pane's shell is the sandbox's, not the operator's, before the harness is typed into it.
   */
  ready: string;
  /** How the harness is named in the confined shell: a per-agent link under srt. */
  harness: string;
};

/** The run's Herdr, or one inside the sandbox, keyed so a host keeps one workspace per box. */
export type PaneHerdr =
  | "run"
  | { key: string; run(args: readonly string[], timeoutMs: number): SandboxedCommand };
```

**A sandboxed harness is typed, then adopted**, by a helper beside today's `startAgent`. `agent
start` refuses an srt pane, whose root process is srt, not a shell (H4), and one path for both
providers is simpler than two. The helper:

1. waits, at most 10 s, for the pane's screen to settle, then types `prelude`. The operator's
   prompt is whatever their rc files draw, so nothing is matched in it;
2. waits for `ready` at the end of the screen's last line, then types `harness` and the harness's
   arguments with its `sandboxedArgs`, each shell-quoted. A prelude the login shell swallowed
   never shows `ready`, so the harness is never typed into the operator's shell;
3. polls `agent rename` until Herdr has detected the agent. `agent_not_found` means not yet;
   detection took about 1 s (H6). At the deadline it reports the screen and closes the tab;
4. answers startup blocks with `answerStartupBlocks`, which works by name, then waits for `idle`
   before the first prompt, since a prompt sent early is lost even after `agent start` (H6).

**The Herdr host** sends each Herdr's commands through one function, as today, keyed by
`PaneHerdr.key`, and opens a workspace on a sandbox's Herdr the first time an agent needs it. It closes
them all with the run, and treats a sandbox's Herdr whose box is gone as closed. A sandbox's
commands run as `SandboxedCommand`s, so a cancelled `agent prompt --wait` in a box is reaped. An
unsandboxed pane runs exactly as today.

**Secrets and sessions:**
- The provider writes the harness's `token` to a file of its own beside the sandbox's directory,
  `{directory}.secrets/{id}`: every agent in a sandbox reads that directory, and none reads the
  run root around it. The directory is `0700` and the file is created new, `0600`, following no
  link (`writeSecrets` in `@agentswf/sandbox`). The prelude sources it and deletes it before confining
  its shell; `release` deletes one never read, and `close` the directory. No token crosses any
  argv (H5, H6).
- Herdr reports no `agent_session` for an adopted agent whose home is not the default (H6). A
  sandboxed agent's sessions are instead every session file in its home, which is private to it,
  so accounting and the adapter read them there.

The providers:

- **srt:** `herdr: "run"`. `pane()` links the harness's real path into a per-agent `bin/`, and
  `harness` names the link. `prelude` is `exec /usr/bin/env -i {agent environment} TERM={term}
  PROMPT={nonce prompt} /bin/sh -c 'echo $$ > {pid file}; set -a; . {secrets}; set +a; rm -f
  {secrets}; exec {node} {srt} -s {pane file} -- /bin/zsh -f +m'`, with the agent's environment
  from [[#The srt provider]] less its token, which comes from the secrets file so it is in no argv.
  zsh takes `PROMPT` from its environment (srt's bash drops `PS1`), typed as `awf-%%-{nonce}%# `
  and drawn as `awf-%-{nonce}% `, which is `ready`. Job control is off (`+m`), so every job the
  harness leaves stays in the leader's process group, and `release` ends them all by it. So nothing from the operator's
  login shell reaches the agent: the confined environment held only what the prelude set and
  srt's proxy variables (H6). srt needs `sandbox-exec` in `/usr/bin`. The profile adds `allowPty`,
  without which zsh cannot take the terminal and the harness is never detected (H6). The `exec`
  matters: when the confined shell exits the pane closes, leaving no unconfined shell behind
  (H6). The run's Herdr socket stays unreachable, being under the denied `~` (H6).
- **docker:** at the first pane, once however many ask at once, the provider starts
  `herdr server` in the box with `HOME` at `/tmp/awf-herdr`, inside the box and off every host
  mount, and `onboarding = false` seeded. `watch` is `docker exec -it -e HOME=/tmp/awf-herdr {box}
  herdr`, printed at the sandbox's first pane agent. `herdr` is `{ key: {box}, run }`: each command
  a `docker exec` whose pid is recorded, so a cancelled one is ended in the box too (X7). The
  prelude is srt's shape: `env -i` with the agent's `HOME`, its harness's `env`, the box's `PATH`
  and proxy variables, then its secret, sourced and deleted, and `exec /bin/zsh -f +m` with the
  nonce prompt. The secret is written into the box's `/tmp/awf-secrets/{id}` by the agent's own
  uid through stdin, as the box drops `CAP_CHOWN`; a co-tenant shares that uid and could read it
  in the second before it is deleted, within the trust boundary. The image pins Herdr by release
  and checksum to `HERDR_VERSION` in the adapter, and the adapter refuses a box whose Herdr
  answers otherwise, naming both. Agents in one box can prompt and read each other through its
  Herdr, within the trust boundary, and reach nothing outside it.

Closing the tab ended srt, its children and the harness (H6), and the harness in a box (H5);
`release` still runs after it, and the box's removal ends anything left.

### The srt provider

`createSrtProvider({ toolchain })`. srt has no persistent box: a sandbox is a base profile, and each
admitted agent gets a profile file built from it.

**The toolchain** is the host paths the project's tools need: by default, the parent of each `bin`
directory on the engine's `PATH` under `~` (on this machine `~/.bun`, `~/.local`, a mise node
install and `~/.orbstack`), which X19 showed runs bun, node and npm. The operator can replace it.
It is recorded with each sandbox. Caches under `~` stay denied, so the provider points the ones it
knows at the sandbox temp (npm's `npm_config_cache`).

- **The base:**
  - `denyRead`: `~`, `/Users`, `/home`, `/Volumes`, `/tmp`, `/private/tmp`, `/private/var/folders`
    and `runRoot`;
  - `allowRead`: `cwd`, `read`, `write`, the resolved gitdirs, the sandbox's `directory`, and the
    toolchain;
  - `allowWrite`: `write`, `homes/`, and a sandbox temp directory;
  - `denyWrite`: the gitdirs' `hooks`, `config` and `modules`, and `read` paths nested in `write`;
  - `allowedDomains`: `network`;
  - `enableWeakerNetworkIsolation: true`, and no `allowLocalBinding`.
- **`admit`** writes the agent's file: the base, plus its harness's `domains` and `reads`, the
  command's real path, `door.reads`, the launcher's directory readable but not writable, and
  `door.endpoint` in `allowUnixSockets`. Each file lists only its own socket.
- **The agent's environment**, for its turns and its pane alike, is only: `HOME`; `PATH` of the
  per-agent `bin/`, the toolchain's `bin` directories and `/usr/bin:/bin:/usr/sbin:/sbin` (srt
  needs `bash` on it); `CLAUDE_CODE_TMPDIR` (srt makes it `TMPDIR`); `GIT_CONFIG_GLOBAL`, an empty
  file in the home; the caches pointed at the temp; the harness's `env` and token; and the
  adapter's overlay (X20). `HOME` stays the operator's, which is denied.
- **`launch`** is `srt -s {agent_file} -- {command_real_path} {args}`, with that environment.
- **A pure check on every `open` and `admit`:** `~` and `runRoot` are denied; no allowed path
  equals or contains either, or reaches into `runRoot` outside `directory`; and none equals or
  contains a harness state root (`~/.claude`, `~/.codex`, `~/.pi`).
- **The first `open` in a process runs a live probe:** a canary read in the denied region, and a
  request to a domain that is not allowed.
- **`close`** deletes the files and the temp directory.

### The docker provider

`createDockerProvider({ defaultImage })`. A sandbox is one container; agents are processes in it.

- **`open`:**
  - an `--internal` network, and a proxy container on it and on the default network. The proxy
    is a small CONNECT-only filter shipped in the default image. Its allowlist starts as `network`
    and grows as agents are admitted. It lives in a mounted directory, since a single-file mount
    goes stale when the file is replaced;
  - the box: `docker run -d --init --user {uid}:{gid} --network {internal}`, with `HTTPS_PROXY`
    and nothing else of the host environment;
  - mounts at identical paths, rejecting any that contains `runRoot`: `cwd` and `read` read-only,
    `write` read-write, `homes/`, and the gitdirs read-only. A writable worktree's gitdir is
    read-write, with `hooks` re-mounted read-only and `config` read-only as a single file, which
    the host does not rewrite during a run.
- **`admit`:**
  - probes the image for the harness's `command`;
  - as root, makes the launcher's and the bundle's directories at their host paths (a box has no
    `/private`), and copies `door.boxScript` to `door.launcher` and `door.bundle` to its own path
    with `docker cp`, read-only to the agent's uid;
  - starts the agent's relay: `docker exec -i` of a small listener at `door.endpoint`'s path in the
    box, whose connections the host side carries to the real socket (X6).
- **`launch`:** `docker exec -i -w {cwd} -e {NAME}… {box} setsid sh -c 'echo $$ > {pid_file};
  exec {argv}'`, with a fresh pid file per launch. Variables pass by name, their values set in the
  client's environment, so the token never appears in the host's `ps`. Its `reap` kills the group
  in the pid file and deletes the file (X7); a file not yet written is left for `release`.
- **`release`** kills the group of every pid file the agent still has, and its relay. **`close`** removes the box, the proxy and
  the network.
- **The default image**, from `packages/sandbox/docker/Dockerfile`: node 22, bun, git,
  claude, codex and pi, Herdr at the version the adapter supports, a user with the operator's uid, and
  the proxy.

### The record

```ts
export type SandboxRecord = {
  callPath: string[];
  /** `agent:<key>` for a private sandbox, a namespace explicit keys cannot use. */
  key: SandboxKey;
  /** An environment key; more come with new providers, so a reader never switches on it exhaustively. */
  provider: SandboxEnvironmentKey;
  /** Absolute paths: `~` expanded and `.` resolved. */
  spec: SandboxSpec & { cwd: string };
  /** The engine-minted directory holding its homes. */
  directory: string;
  /**
   * The git directories its paths belong to: reach beyond `spec`, writable where the worktree is,
   * `linked` when only through a linked worktree.
   */
  gitdirs: Gitdir[];
  /** Every domain reachable in the end: `network` plus the admitted harnesses' model domains. */
  domains: Domain[];
  /**
   * What only its provider knew, in its own shape, as `spec` holds its settings under its key:
   * docker's `image`, the digest the box ran; srt's `toolchain`, the host paths it re-allowed.
   */
  provided?: JsonObject;
  /** Every agent admitted, including one whose turns never completed. */
  agents: { callPath: string[]; agent: string; home: string }[];
};
```

- `OutputRecord.sandboxes` lists each sandbox once. Membership lives here, not in
  `RunAccounting.byAgent`, which is built from usage records and would miss an agent that failed
  before its first operation.
- A contamination audit reads the homes listed here.
- `OUTPUT_RECORD_VERSION` stays 2: the field is optional, and nothing reads it yet. Readers must not
  switch exhaustively over `provider`.

### What is fixed, and what is provisional

The experiments showed each mechanism works, not that it is the cleanest. A task keeps the author
surface, the record, the seam and the seven invariants. It may replace a mechanism below when a
cleaner one holds the same invariants under the same tests, recording why in its implementation
notes, and in `findings/` when it measured something:

- **The typed pane start.** Herdr has `pane wait-output`, which may replace polling the screen for
  prompts, and `pane report-agent-session`, which may give an adopted agent its session instead of
  reading the home. Neither was tried.
- **The pane's secret file**, sourced and deleted by the pane's shell to keep the token out of argv.
- **The docker reaper:** `setsid`, a pid file, and a group kill.
- **The docker door's stdio relay**, and **the proxy**, twenty lines of node that a maintained
  filtering proxy could replace.
- **The srt pane's `env -i` prelude and per-agent `bin/` link.**

### Alternatives rejected

- **A union on `provider` with flattened settings.** Common reach would repeat in every branch.
- **A per-provider reach vocabulary.** srt's re-allow and docker's mount mean the same thing.
- **Sandboxes opened lazily by their first agent.** Image errors would surface in an agent's open.
- **Per-agent isolation inside a shared sandbox.** docker would need a box per agent, which is a
  private sandbox.
- **Protecting files in the operator's harness state.** The list of executables is open-ended.
- **A host socket mounted into the box, or TCP to the host.** Neither connects (X6, Y1), and TCP
  would trade the socket's authority for a token.
- **A file-drop mailbox for docker's door.** It works, but adds a transport to the cli-agent and
  the control plane; the relay changes neither.
- **Credentials mounted read-only.** A refresh inside would fail mid-run once a token expires.
- **Docker as the default provider.** Its image lacks the project's toolchain.
- **Providers inside harness.** The harness would carry docker's image and proxy and srt's
  profiles, and a new provider would edit a core package.
- **A package per provider, for now.** Two providers do not justify three packages. A provider
  moves out when it brings dependencies of its own; its entry point already isolates it.

## Code map

- **contract:**
  - `workflow/sandboxes.ts` (new): the author-surface types;
  - `workflow/workflow.ts`: `WorkflowContext.sandboxes`;
  - `workflow/agents.ts`: `AgentOpenSpec.sandbox`;
  - `records.ts`: `OutputRecord.sandboxes`.
- **sandbox** (new):
  - `src/seam.ts`, the seam's types, `ResolvedSandbox` and `REAP_GRACE_MS`;
  - `src/resolve.ts`, paths and a working directory's real gitdir;
  - `src/testing/`, the conformance suite and the fake provider;
  - `src/srt/`: profiles, the pure check and the probe;
  - `src/docker/`: the provider, the relay's host half and the reaper;
  - `docker/`: the Dockerfile, the proxy and the relay's box half.
- **harness:**
  - `sandbox-needs.ts` (planned for `spec.ts`): `sandboxNeeds(harness, home, model)` for claude, codex and pi. Their `sandboxedArgs` are
    `-c web_search="disabled"` and `--disallowed-tools WebSearch,WebFetch`, one argument each so
    nothing variadic swallows what follows. cursor has none and is refused;
  - `usage/*.ts`, and `SessionAccounting.read`: take the agent's home when it has one, and for a
    sandboxed pane find its sessions there;
  - `adapter.ts`: `HarnessActivation.occupant`;
  - `adapters/direct-process.ts`: every turn goes through `occupant.launch`;
  - `adapters/herdr.ts`: a Herdr per argv prefix, and the typed start with `agent rename` for an
    occupant's pane;
  - `command.ts`: `runProcess` accepting a `SandboxedCommand`: its group, its exact `env`, `reap`.
- **engine:**
  - `workflow-runner.ts`: `sandboxes.open`; `openAgent` refusing a missing provider, or a pane in a
    sandbox whose provider hosts none, before the channel opens; private sandboxes from inline specs; homes, admission,
    release, closing; the reopen rule; the record;
  - `agent-launcher.ts`: the bundled cli-agent and `AgentDoor`;
  - `operator-runtime.ts`, the only importer of a provider: installs srt (CLI 1.0.0 or later, on `PATH`) with its toolchain, and
    docker (when a daemon answers), and picks the default;
  - `operator-cli.ts`: `sandboxes` in `output.json`, and each box's `watch` command printed;
  - credential write-back after each turn.
- **scripts:** `check-boundaries.ts`, the sandbox rules.
- **examples and docs:** `examples/sandbox-probe/`; `permissions.md`, `foundation.md`'s layout,
  `AGENTS.md`'s package table, `status.md`, `testing.md`, `eval-isolation.md`.

## Tasks at a glance

- [ ] 0. Experiments: what srt and docker can hold (all but X13 done)
- [x] 1. The seam
  - [x] 1a. The package, the author surface and the process
  - [x] 1b. The harness side: sandbox needs, usage from a home, the occupant
  - [x] 1c. The engine: opening, homes, admission, close, the record
- [x] 2. The srt provider
- [x] 3. The docker provider, its image, proxy and relay
- [x] 4. The probe example, and a live eval under both providers, private and shared
- [x] 5. Panes in sandboxes, under both providers
- [x] 6. Docs

## Open questions

- **X13: does a copy's refresh log the operator out, and do two refreshing copies trip reuse
  detection?** Tokens do expire within a run's reach: codex's access token lives 10 days, and pi's
  Anthropic token had expired the day before. Measuring it means forcing refreshes on copies and
  writing the result back to the operator's file, which needs the operator's consent. If two
  copies cannot both refresh, the engine refreshes on the host before a run whose deadline crosses
  an expiry, so no copy has to.
- **How a setup-token `claude -p` turn is billed.** It reports a cost either way, which may be the
  subscription's. It stays `metered`, as `meteredHeadless` records it, until the account's usage
  shows otherwise.
- **Which provider eval-isolation uses.** Recommended: decide after Task 4, with both providers'
  results in hand.

## Task execution rule

Process one task at a time, each with this checklist:

- [ ] Plan: inspect the relevant code and tests; record the module, seam, invariants, failure
  behaviour and focused proof, and material alternatives, before coding.
- [ ] Implement: only this task's change, with focused tests.
- [ ] Review: two read-only subagents review the actual diff and test output, one for
  architecture and scope, one for correctness and proof.
- [ ] Resolve: fix or disposition every finding; re-review if a fix changes the architecture.
- [ ] Verify: run the focused checks and meet every `Done when` item before checking the task.

After all tasks, run story-level verification and request human review.

## Task details

### 0. Experiments

Done 2026-09-25, except X13 ([[#Open questions]]). X19, the toolchain, Y1, other routes for
docker's door, and X20, a clean environment, were added after review. Every result is in
[[sandbox-providers]] with its script. The design
above follows them. A read-only subagent checked the story against them; its findings are resolved
in this revision.

### 1. The seam

Outcome: a workflow opens sandboxes and agents into them, or gives an agent a private one. The
engine seeds homes, admits and releases agents, and closes sandboxes at run end. Headless turns
launch through the occupant, and `output.json` records the sandboxes.

It is three slices, each through the four gates before the next begins, so each review reads one
package's change. Planned 2026-09-25 against the code; the decisions below are what the story
above left open.

#### 1a. The package, the author surface and the process

Work: `packages/sandbox` with `seam.ts` and `resolve.ts`; the contract types and a type test
(`workflow/sandboxes.typecheck.ts`, beside `deadlines.typecheck.ts`); `runProcess` taking a
`SandboxedCommand`; the boundary rules.

- **`runProcess` tells the two apart by `group: true`.** A `SandboxedCommand` spawns with Bun's
  `detached: true` (`setsid`), with exactly its `env`. On timeout, abort and exit alike it sends
  SIGKILL to `-pid`, then awaits `reap` within a fixed 5 s grace. Checked on Bun 1.4.0: killing
  `-pid` ends a backgrounded grandchild. `ProcessInput` and `withholding` are unchanged, and
  `withholding`'s unset names are harmless on an exact `env`.
- **Resolution reads, and runs nothing:** `realpath`, `~`, and a `.git` file's `gitdir:` and
  `commondir`. No `git` process.
- **The conformance suite and the fake provider go in `@agentswf/sandbox/testing`**, not the main entry,
  as `@agentswf/harness/testing` does: the main entry must not import `bun:test`. The suite is a
  function a provider's test calls with a factory; it runs `sh` through `launch` and checks the
  invariants a fake can hold, and Tasks 2 and 3 call it with the real providers.

Done when:
- the type test shows two environments fail to compile, and so do a look-alike ref and an open
  spec passed inline;
- `runProcess` kills a sandboxed command's grandchild with it, passes it exactly its `env`, and a
  failing `reap` leaves the result unchanged; an unsandboxed process runs exactly as before;
- resolution tests: `~`, relative paths, a worktree's gitdir and its common dir, an empty or
  missing path rejected;
- `check-boundaries.ts` rejects a provider import from harness or engine outside the composition
  root, the package importing harness or engine, and one provider importing another.

#### 1b. The harness side

Work: `sandboxNeeds` in `spec.ts`; usage reads that take a home; the occupant through
`HarnessActivation`; the headless adapter launching through it.

- **The occupant reaches an adapter as `HarnessActivation.occupant`, with `home`.** The placement
  host passes both through. The headless adapter sends every turn, resumed ones included, through
  `occupant.launch`, appending `sandboxedArgs`. The Herdr adapter refuses an occupant until Task
  5.
- **Usage readers take a home instead of reading `process.env`.**
  `claudeProjectsDirectory`, `codexSessionsDirectory` and `piAgentDirectory` take it as a
  parameter, and `SessionAccounting.read` gains `home?`. Billing is unchanged: it asks the host.
- **`sandboxNeeds(home, model)` is a function beside `HARNESSES`**, not a field on every
  `HarnessSpec`: cursor has none and is refused.

Done when:
- unit tests fix each harness's `sandboxNeeds`, including `sandboxedArgs`
  (`-c web_search="disabled"`; `--disallowed-tools WebSearch,WebFetch`) and domains per model;
- the headless adapter's tests show a first and a resumed turn through `launch`, with
  `sandboxedArgs`, and an unsandboxed agent unchanged;
- a usage read with a home reads that home.

#### 1c. The engine

Work: the registry and default; `sandboxes.open`, private sandboxes and the reopen rule; the
bundled launcher and `AgentDoor`; homes, seeding and write-back; admission, release and close;
the record.

- **The registry is a run option, not runtime config.** `RunWorkflowOptions.sandboxes` holds the
  installed providers by environment key and the default; `installOperatorRuntime` returns it
  beside `config`. `AgentRuntimeConfig` is harness's, and no host needs the providers.
- **A sandboxed agent opens in order:** its sandbox (a private one opened now), its channel, its
  door, its home and seed, `admit`, then `host.openAgent` with the occupant. An unsandboxed agent
  keeps today's concurrent open of channel and session.
- **The bundle is built once per run** with `Bun.build` (in process, about 9 KB, checked) into
  the control plane's directory. A sandboxed agent's launcher is `exec {bun real path} {bundle}
  --at {endpoint}`, and `door.reads` names both. An unsandboxed launcher is unchanged.
- **Close gains two steps in `WorkflowOwner.close`:** after the host closes and in-flight work
  settles, each occupant is released, then channels close, then sandboxes close.
- **Homes and write-back live in a new `engine/src/sandbox-homes.ts`**, called after each settled
  operation.
- **The record** is built from the engine's registry of opened sandboxes, carried on `SettledRun`
  and written by `operator-cli.ts`.

Done when:
- the conformance test shows every headless process, including a resumed turn, carrying its
  occupant's marker, and every turn reaped, whether killed or finished;
- each rejection in [[#The author surface]] is refused before a channel opens, naming its cause,
  and so are a missing provider and a pane under a provider with no `pane()`;
- engine tests show two agents in one sandbox; release after the session, after a failed open, and
  on cancel; a private sandbox closed when its agent fails to open; sandboxes closed at run end
  after their agents;
- a refreshed seed is written back only when it parses and the operator's file is unchanged since
  the copy, atomically and with mode `0600`, and the baseline moves;
- `output.json` lists each sandbox with its members and homes;
- an agent without `sandbox` behaves and records exactly as before.

### 2. The srt provider

Outcome: srt sandboxes hold invariants 1–7 on this machine, private and shared.

Work: `@agentswf/sandbox/srt`, `createSrtProvider`: the base and per-agent profiles, the pure check, the temp directory,
the first-open probe, and `launch`.

Done when:

- unit tests fix the profile for each harness and reach field, with every key srt requires, the
  most specific of nested `read` and `write` winning, and
  the launch form `srt -s {file} -- {real_path}`, with a harness flag such as `--version` reaching
  the harness;
- the pure check rejects a profile that re-allows `~` or reaches into `runRoot`;
- a local test, which runs no agents and is skipped without srt, runs `sh` for two agents in one
  sandbox and one in another:
  - **environment:** only the variables the provider set, and srt's own;
  - **allowed:** `cwd` and a `read` path readable, a `write` path writable, `git status` in `cwd`,
    `bun`, `node` and `npm` from the toolchain, each agent's own socket;
  - **denied reads:** canaries under `~`, in the operator's harness state, `/tmp` and `$TMPDIR`,
    and the other sandbox's home;
  - **denied writes and sockets:** the gitdir's `hooks`, any launcher, the other sandbox's socket;
  - **denied network:** a localhost listener, a non-allowed domain, a raw IP;
- a cancelled sandboxed `sleep` with a child leaves no process (`pgrep`).

### 3. The docker provider, its image, proxy and relay

Outcome: docker sandboxes hold invariants 1–7, private and shared, and the default image runs all
three harnesses headless.

Work: `@agentswf/sandbox/docker`; the Dockerfile; the proxy; the relay's two halves;
`createDockerProvider` with the network,
box, mounts and gitdir rule, admission, `launch` and `reap`, `release` and `close`.

Done when:

- unit tests fix the `docker run` and `docker exec` arguments for each harness and reach field,
  including nested `read` and `write`, and no token value in any argument;
- a local test, which runs no agents and is skipped without a daemon or the image, runs `sh` for
  two agents in one box and one in another:
  - **the srt test's allowed and denied cases,** where they apply;
  - **network:** going around the proxy, DNS and raw TCP refused; the proxy log shows the refused
    domain; an allowlist grown at admission takes effect;
  - **mounts:** a host path outside reach absent; `cwd` read-only unless in `write`;
  - **doors:** the launcher directory root-made, the launcher and bundle unwritable, each `wf`
    round-tripping through its relay and not reaching the other box's;
  - **cancellation:** a killed turn's in-box group gone, and no zombie;
  - **cleanup:** no container, network or proxy left after `close`.

### 4. The probe example and a live eval

Outcome: real agents are denied under each provider, in a private and a shared sandbox, reach
what they are allowed, answer, and are accounted for. The proof does not rest on an agent's word.

Work: `examples/sandbox-probe/`, with the environment as a parameter: one shared sandbox with two
agents and one private sandbox. Each agent runs a fixed list of shell commands and reports each
output through `wf result`:

- **positive controls:** read an allowed file with random contents, and fetch an allowed domain;
- **canaries**, each a random token: a file under `~`, a fake transcript in the operator's harness
  state, files in `/tmp` and `$TMPDIR`, the other sandbox's home, a localhost listener;
- **actions:** fetch a non-allowed URL, write the working directory, write a git hook, and ask for
  a web search.

The two shared agents cooperate: one writes a file the other must read. `sandbox.eval.ts` runs it
with claude, codex and pi on their cheapest models, under srt and docker, each skipped when its
provider is not installed. The host checks:

- no canary token in any transcript or result;
- no web-search call in any transcript;
- the working directory and hooks unchanged;
- no connection at the localhost listener;
- under docker, the refused domain in the proxy's log.

Done when both providers pass every check, every result arrived through `wf result`, and
`output.json` lists both sandboxes with their members and homes, with nonzero tokens for every
agent. Its time and cost go in `testing.md`: it now runs claude, metered, automatically.

### 5. Panes in sandboxes

Outcome: a pane agent runs in an srt sandbox in the run's Herdr, and in a docker sandbox in the
box's Herdr, answers through `wf result`, and is accounted for. The operator can watch both.

Work: `Occupant.pane` and `OpenedSandbox.watch` for both providers; the Herdr host's per-prefix
workspaces and the typed-start helper; the pane's secret file; sessions from the home; `defaults` for claude
and codex; the box's Herdr server and its version check; the `watch` command in the record and in
`awf run`'s output.

Done when:

- unit tests fix each provider's `PaneTerminal`, the shell quoting of typed arguments, and that
  no token appears in any argv;
- the Herdr host's fake-CLI tests show a workspace per prefix, the typed start and rename, and an
  unsandboxed pane unchanged;
- a live check, once per provider, runs a claude and a codex pane that answer through
  `wf result`, with a canary read denied, the run's Herdr socket refused (`herdr pane list`
  fails inside), their sessions read from their homes with nonzero tokens, the secret gone after
  release, and nothing left running after close;
- the box's Herdr version is the one the adapter supports, or the provider refuses panes naming
  both.

### 6. Docs

Outcome: the design documents describe what exists.

Work: `permissions.md` (the reversals, the three abstractions, the invariants, the harness home,
the build order); `foundation.md`'s layout and `AGENTS.md`'s package table; `status.md`; `testing.md`; `eval-isolation.md`, whose fresh-home item is done
here; and a check that `workflow-in-sandbox.md` still describes what is left.

Done when `permissions.md` describes sandboxes as the workflow's objects and `status.md` lists
sandboxed headless agents under "What runs today".

## Verification

Automated:

- [x] The conformance test, the type test, and the srt and docker unit tests.
- [x] The local srt and docker tests (no agents; each skipped without its provider): both pass,
  docker's on the image with Herdr pinned and the review's fixes.
- [x] `bun test`, `bunx tsc --noEmit`, `bun run scripts/check-boundaries.ts`, `bun run check`:
  651 pass, 8 skip, 0 fail; check clean.

Live:

- [ ] `bun run eval`, including `sandbox.eval.ts` under both providers: 2026-09-26, 5 passed and
  `sandbox-docker` skipped (daemon not answering), 6m 13s, ~$0.58.
- [x] The pane checks from Task 5, once per provider: `sandbox-panes-srt` passed in 2m 40s,
  ~$0.29; `sandbox-panes-docker`, on the final code, in 3m 07s, ~$0.31.
- [x] `sandbox-docker`, on the final code, passed in 2m 48s, ~$0.31, of which $0.09 charged. No
  box was left behind. OrbStack stopped answering twice while several agents drove it at once;
  it has answered since.

## Review record

### Planning

Eight read-only subagent reviews and one of the whole story, 2026-09-24 and 2026-09-25. Each finding is fixed in the design
above; the full lists are in git history (`git log -p docs/stories/004-sandboxed-agents.md`).

1. **Architecture and contract:** a docker launcher, the `Domain` grammar, reopen semantics.
2. **Correctness and feasibility:** writable harness state was host code execution, readable
   `/tmp`, model-side tools, and proof resting on an agent's word.
3. **Targeted re-review:** the run root denied, `boxScript` as data.
4. **The 2026-09-25 redesign:** a branded ref, membership in `SandboxRecord`, per-environment
   bases, private keys, the independence rule, the door's single owner, serialized admission.
5. **The whole draft:** examples missing `placement: "headless"`, the bundle's way into a box,
   duplicate keys.
6. **Against the experiments:** a kill hook for docker (`reap`), harness `reads`, both web-search
   flags, the credential decision, the default provider, concrete Done-when lists, and the cuts
   that shortened this document.
7. **The shortened document:** the dropped srt toolchain (now X19 and a derived default), closing a
   failed private sandbox, groups only for sandboxed commands, the reaper's pid-file races, a safe
   write-back, `ProcessInput` for `CommandSpec`, where `sandboxedArgs` go, the token kept out of
   `ps`, and the recorded domains and toolchain.
8. **Panes:** readiness and typing races in the typed start, the srt pane's inherited environment,
   who owns the per-agent `bin/`, the box Herdr's `HOME`, `.secrets` outliving the run, the run's
   Herdr socket, sessions for adopted agents, `watch` on the sandbox, quoting, and cancellation in a
   box. H6 measured the open ones.
9. **The whole story against code and scripts:** srt's headless agents inherited the engine's
   environment while its panes did not (X20 measured the fix), the pane `PATH` lacked the
   toolchain, the box's Herdr `HOME` pointed outside its mounts, the docker prelude set no harness
   variables, and the Herdr pin named the host instead of the adapter.

### Tasks

#### 1a

Two read-only subagents, 2026-09-26.

**Architecture and scope** checked the package layout and entries, the contract types against the
author surface, the type test, the engine stub, `runProcess`'s two paths, resolution's placement,
and whether the fake and the suite fit Tasks 1c, 2 and 3. Findings and resolutions:

1. The seam changed without the story: fixed, the seam block above is `seam.ts`, and the
   deviations are in the implementation notes.
2. The boundary rules missed the seam or `testing` importing a provider, and a provider without
   an `index.ts`: fixed, every directory under `src` but `testing` is a provider, and path imports
   into one are refused from anywhere else. The fixture test covers each case.
3. A flat `gitdirs` list lost writability, so a writable worktree would commit under docker and
   not srt: fixed, `Gitdir` carries `writable`, set when a path it serves is.
4. A failed reap was lost on a successful turn: fixed, `ProcessResult.reapFailed`, and `stderr`
   untouched. 1b carries it to the run's log.
5. The suite's runner did not bound `reap`: fixed, `REAP_GRACE_MS` is in the seam, `runProcess`
   uses it and the suite fails a reap that runs over it.
6. Harness tests could not use the fake: fixed, harness and engine tests may import
   `@agentswf/sandbox/testing`, and engine production code may not.
7. Who serializes `admit`, and how often `release` and `close` run: stated on
   `SandboxProvider.open`; the engine does.
8. `ResolvedSandbox` no longer tied to `SandboxReach`: fixed, derived from it.
9. Environment keys copied outside contract: fixed, contract exports `SANDBOX_ENVIRONMENTS`.
10. The fake's marker named only the sandbox: fixed, `AWF_FAKE_OCCUPANT` names the agent's home.
11. The suite's close test proves nothing for docker: kept, documented; Task 3's local test owns it.
12. Gitdirs skipped the exposure checks: fixed, as the correctness review's first finding.
13. Out-of-task changes (`bunfig.toml`, `.gitignore`) belong to Task 0: noted for the commit.
14. The suite leaked its door directories: fixed.

**Correctness and proof** ran the type test with each `@ts-expect-error` removed (each fails for
its reason), probed resolution, the group kill and the boundary checker with scratch scripts.
Findings and resolutions:

1. Blocking: a crafted `.git` file could make `~`, the run root or `/` a readable gitdir, and a
   dotfiles repository at `~` was found by walking up: fixed, every gitdir goes through the same
   checks as a reach path, and the walk stops below `~` and the run root. Tests for each.
2. `runProcess` could hang past its timeout when a process left the group holding stdout, and
   `reap` never ran: fixed, output drains for 1 s once the group is dead, then the read is
   cancelled and `reap` runs. A test with a `setsid` escapee fails on the old code.
3. `reap` called unbound: fixed. Early returns (abort before spawn, spawn failure) do not reap, as
   a `launch` starts nothing until its command runs.
4. `withholding` dropped `group` and `reap` from a prototype: fixed, fields are copied by name.
5. Door directories leaked: fixed. 6. The release test asked about the wrong agent: fixed.
7. The suite's runner drifted from `runProcess`: fixed, it drains and bounds `reap` the same way,
   and marker sleeps last under an hour.
8. Pid reuse after a group empties: documented at the fake's group kill.
9. Boundary holes: fixed, as the architecture review's second finding.
10. Harness tests and the fake: fixed, as above.
11. `*.com` and `0x7f000001` were domains: fixed, both refused.
12. Test gaps: added a path inside the run root, `~user`, harness state, and each crafted gitdir.
    Resolution now also refuses any path overlapping `~/.claude`, `~/.codex` or `~/.pi`.
13. `{ ...ref }` type-checks as a ref: by design; the engine's `WeakSet` refuses it at run time.

**Targeted re-review** of the seam and boundary changes. Findings and resolutions:

1. Provider tests could not reach the conformance suite: fixed, a provider's `*.test.ts` may import
   `src/testing`, and its other files may not.
2. `write: ["out"]` made the repository's whole `.git` writable: fixed, a gitdir is writable only
   when its worktree's root is, the most specific of `read` and `write` deciding. Tests for each.
3. A run root inside the repository hid its gitdir: fixed, the walk stops only below `~`, and the
   run-root check judges the gitdir it finds.
4. `SandboxRef.provider` is a closed union: documented as growing, never to switch over.
5. `SandboxEnvironment` and `SANDBOX_ENVIRONMENTS` could drift: a type-level check in
   `sandboxes.typecheck.ts`, shown to fail when a key is added to one only.
6. `withholding` would drop a future field: its copy is typed over every `SandboxedCommand` key.
7. Moved harness state: `ResolveOptions.harnessState`, which the engine fills in 1c.

#### 1b

Two read-only subagents, 2026-09-26.

**Architecture and scope** checked the dependency direction, where each flag sits in every plan,
that resumed turns run inside, the legacy driver, the usage and billing paths, and the tests'
isolation. Findings and resolutions:

1. A reap failure on the turn's outcome reached the engine on some paths only: fixed, the field is
   gone from the outcome; 1c wraps each occupant's `reap` and logs a failure where it happens.
2. pi's domains came from the operator's settings, which a fresh home never sees: fixed, a
   sandboxed pi needs its model as `provider/model`.
3. The operator's harness state was worked out in three places: fixed, `harnessState(environment)`
   in `state.ts`, which the usage readers default to and 1c passes to resolution.
4. `HarnessSandboxNeeds.sandboxedArgs` had no reader in any provider: removed from the seam; the
   flags are harness data, `sandboxedArgs(harness)`.
5. `HarnessActivation.home` had no reader: removed; the engine hands the home to accounting.
6. `spec.ts` gained file-system lookups: moved to `sandbox-needs.ts`.
7. `argv[0]` swapped for `executable` only by implication: documented on the seam, with the
   `PATH` it was found on.
8. The pane refusal came after the provider's work: the placement host now refuses a sandboxed
   pane before its pane side opens, and 1c refuses it before the channel. The session-core option
   is renamed `launchesInSandbox`.
9. The refusal was tested only on an adapter no production path builds: tested on the run host.

**Correctness and proof** generated all eight sandboxed argvs, compared every unsandboxed plan with
`HEAD` (24 plans, no difference), ran `sandboxNeeds` against this machine's real harnesses, and
read pi's model resolver. Findings and resolutions:

1. pi resolves a bare model from its catalogue, not the operator's default provider: fixed, as
   above.
2. No domain let a credential refresh: `auth.openai.com` added for a ChatGPT login, and pi's
   anthropic refresh hosts; both unmeasured, marked so, and left to X13 and Task 4.
3. A sandboxed pane was refused after Herdr made a workspace: fixed, as above.
4. `findExecutable` accepted a directory: fixed, a regular file with an execute bit, as a shell
   finds it. Tested with a directory and a non-executable file earlier on `PATH`.
5. `reads` assumed one layout per harness, and a version manager's shim resolved to the manager:
   fixed, the layout is found (a package above it, a `bin/` directory, or a single binary), and a
   shim is refused.
6. A prototype key passed the provider lookup: fixed, `Object.hasOwn`.
7. A whitespace token passed: fixed, trimmed. The comma form of `--disallowed-tools` and codex's
   `-c` on `exec resume` rest on `--help`; Task 4's live eval measures both.
8. pi's web access could come from an extension: `--no-extensions` on every sandboxed pi turn.

#### 1c

Two read-only subagents, 2026-09-26.

**Architecture and scope** checked that the engine holds no provider's code, that run-directory
I/O stays in the engine, the open and close orders, that unsandboxed runs are unchanged, the
record's shape, and the fit for Tasks 2, 3 and 5. Findings and resolutions:

1. An abandoned private sandbox vanished from the record, its home with it: fixed, the record is
   every sandbox that opened, a closed-early one included. Tested.
2. The seam had no way to report `image`, `toolchain` or `watch`: fixed, `OpenedSandbox.record`.
3. The overrun path closed sandboxes before releasing their agents: fixed, it releases, then closes.
4. Task 5 could not refuse a pane before the channel with `pane()` on the occupant: decided,
   `OpenedSandbox.panes`, recorded in the Panes design above.
5. The reopen rule leaked into the runner: fixed, one `RunSandboxes.same`.
6. `Seat.needs` had no reader: removed. 7. Defaults repeated: normalized in the constructor.
8. Two `runRoot`s in one options object: kept, as `SandboxContext.runRoot` means the same; each
   is documented where it is declared.
9. `OperatorRuntimeInstallation.sandboxes` optional: kept optional, since a test's runtime has no
   providers and the CLI defaults to none.
10. The recorded settings are the provider's `environment()` value: documented on the seam as the
    contract's JSON shape; gitdirs are now recorded.
11. The run directory has writers besides the engine: noted in `packages/engine/AGENTS.md`.

**Correctness and proof** ran scratch probes against each failure path. Findings and resolutions:

1. A provider `open` that never settled hung the run in `records()`: fixed, the record is built from
   sandboxes that landed, with no wait.
2. Failure cleanup closed the sandbox before the channel, and a close that failed masked the cause
   and left the socket open: fixed, the channel closes first, `abandon` never rejects (it logs),
   and the original error is rethrown.
3. Paths handed to providers were not real (`/var/folders`, `/tmp`): fixed, the sandbox's
   directory and the door's endpoint, launcher and bundle are real paths. Tested.
4. A reopen after a failed private open reported a conflict: fixed, it gives the agent's failure.
5. An admitted agent of an abandoned private sandbox was not recorded: fixed, as above.
6. Overrun cleanup broke close-after-release: fixed, as above.
7. A failed bundle build was cached for the run: fixed, the next agent tries again.
8. No deadline check between steps: fixed, the deadline and scope are checked before admission.
9. The test named for the bundle checked only the home: rewritten to check the door.

Test gaps closed: a killed turn reaped before release and close, a failing reap logged, each
agent's marker, write-back through a turn, a gitdir resolved too late, a claude without its token,
empty and missing paths, the run root, and gitdirs in `output.json`. "Refused before a channel
opens" rests on the order in `openSandboxedAgent`: every refusal is in `seat`.

#### 2

Two read-only subagents, 2026-09-26. The correctness reviewer probed real srt from scratch scripts.

**Architecture and scope** checked the boundary, the provider's surface, the profile against the
design, the pid-file groups, and the fit for docker and srt panes. Findings and resolutions:

1. The toolchain cannot be replaced by the operator: recorded in the implementation notes.
2. `groups.ts` fits only host processes; docker needs `setsid` in the box and a kill through `docker
   exec`: Task 3 gives it its own reaper, as the design has.
3. Panes will need `allowPty` in a pane's profile only, the environment without the token, and pane
   processes tracked: noted for Task 5.
4. The probe could not tell denied from unreachable, ignored the deadline, and cached a failure:
   fixed, it checks the host reaches the domain first, is killed at the deadline, and only a pass
   is kept.
5. A stale pid file could name a reused pid: its file goes at each reap; the window is the turn.
6. The denied regions were listed twice: fixed. `@agentswf/sandbox/srt` exported its profile builders:
   fixed. `findSrt` says nothing when it finds no srt: kept; an unpinned spec falls back, a pinned
   one fails naming the missing provider.
7. The engine test installs srt at load: kept, with a comment on why that is safe. The fake's
   comment and the local test's harness state: fixed.

**Correctness and proof.** Findings and resolutions:

1. High: the toolchain exposed secrets under `~` (it read OrbStack's SSH key): fixed, as the
   implementation notes say. The local test's canaries now include `~/.claude`.
2. High: a writable gitdir let an agent write `commondir`, which the host's git follows to a
   config it runs: fixed, every such file is denied, tested for `commondir`, `config.worktree` and
   `info/` beside `hooks` and `config`, with a commit still working.
3. A `setsid` process survives the group kill: measured (X21), recorded as srt's residual; macOS
   `ps` shows no environment, so no marker can find it.
4. Done-when items without a test: added a `read` path, another sandbox's socket reached with the
   agent's own bundle (refused), and a turn cancelled by its signal.
5. The probe passed vacuously offline: fixed, as above.
6. `/opt/homebrew/bin` is readable because srt does not deny it, not because the profile allows
   it: noted.
7. Write-back followed a link the agent could plant in its home: fixed, the copy is read through
   one `O_NOFOLLOW` handle. Tested.

#### 3

Two read-only subagents, 2026-09-26, reading only: the daemon was hung.

**Architecture and scope.** Findings and resolutions:

1. High: other worktrees' pointers were unguarded under docker, as they were under srt before
   Task 2's fix: fixed, one `protectedGitPaths` for both providers.
2. The guard deleted what the operator might make, and leaves a window: it moves instead, and the
   window is recorded as a residual.
3. `findDocker` ran on every run: fixed, the daemon is asked at the first open.
4. The image tag did not identify its contents: fixed, every input pinned but Herdr's.
5. The operator's uid had no name in the box: fixed, a passwd entry at open.
6. The local test could not pass, and had gaps: fixed, below.
7. Implementation notes and the package table: added.
8. Image assets found through `import.meta.dir`: kept; nothing bundles the engine. The build
   command is named in the refusal. Writability duplicated resolution: fixed, `writableIn`.
9. The kill script took `kill -9 -1`: fixed, a pid must be a number above 1.
10. Task 5: `record` is fixed at open, a box's Herdr commands need the client's environment,
    and a pane's processes need a pid file: noted for Task 5.

**Correctness and proof.** Findings and resolutions:

1. Blocking: teardown ran concurrently, so the network outlived its containers: fixed, one step
   at a time, last made first. Tested.
2. Blocking: `setsid` forked under `docker exec`, losing the exit code: fixed, removed; the local
   test checks an exit code of 3 comes back.
3. Blocking: the local test's setup threw: fixed.
4. Reach could contain the engine's doors, letting an agent rewrite another's launcher: fixed in
   resolution, for both providers. Tested.
5. A failed step leaked what it made: fixed, each undo registered before its step.
6. Nothing cleaned up after a crash: fixed, boxes expire and are swept.
7. Minor: the relay outlived `release` (fixed), the proxy took any port and listened on the
   bridge (fixed), the allowlist was written in place (fixed, renamed over), `-v` made missing
   sources (fixed, `--mount`), a spec's image was pulled (fixed, refused), no hardening (fixed),
   the daemon's socket mountable (fixed, refused), and a shared box is weaker than srt (recorded).

Not demonstrated at the time: every local and conformance case, which waited for a daemon. They
passed once it answered, as the Task 3 notes say.

#### 4

Two read-only subagents, 2026-09-26; the correctness reviewer read every transcript of a passing
live run and probed srt profiles by hand.

**Architecture and scope.** Findings and resolutions:

1. High: making `/var/tmp` writable, for bash 3.2's heredocs, opened a channel between sandboxes
   and let agents plant files and links on the host: fixed at the harness layer, as the notes say;
   no sandbox writes `/var/tmp`.
2. `testing.md` contradicted itself on cost: fixed, with the evals, their time and claude's charge.
3. One eval for both providers let a hung daemon hide srt: fixed, split.
4. No canary in another sandbox's home: added; the reviewer tries every home under the run root.
5. docker's hook and write checks rested on what was left after quarantine: fixed, an output of
   `wrote-hook` or the reviewer's `wrote-note` fails.
6. The eval's logic was untested: fixed, `problems` is pure and unit-tested.
7. Smaller: the example's environment lost its typing (fixed), its plan was not validated (fixed,
   TypeBox), accounting did not count agents (fixed), a missing cost read as $0 (fixed), the
   examples README was stale (fixed), a killed eval could leave its canary transcript (kept; it is
   under a fresh name each run).

**Correctness and proof.** Findings and resolutions:

1. High: the `/var/tmp` rule, as above; the reviewer measured overwrites, renames and links.
2. The bash heredoc test passed from a writable directory, where bash falls back to it: replaced
   by a zsh heredoc from a read-only one, and a test that `/var/tmp` cannot be read or written.
3. The canary, listener and hook checks could pass if an agent never ran them: fixed, each agent's
   transcript must hold the OS's refusal of each canary and of the hook.
4. claude's harness, not srt, refused the hook write: fixed, it goes through `sh -c`.
5. Under docker the listener on the box's loopback proved nothing: fixed, it listens on every
   address and boxed agents try the host's names.
6. The web-search check was narrow: widened to codex's code-mode calls and claude's request count.
7. Homes, the working tree and leftovers: homes are checked to hold transcripts, the whole tree and
   the protected git paths are compared, and a passing run removes its copies of the credentials.
8. The toolchain held repository files (`operator-cli.ts`, a script in another repository): fixed,
   an executable inside a repository is not an install.

#### 5

The srt half. Two read-only subagents, 2026-09-26. The correctness reviewer ran the real prelude
through a pipe and in a pty, with `/bin/sh` for a harness, and read the retained runs of the
failed pane attempts.

**Architecture and scope.** Findings and resolutions:

1. High: `.secrets` sat in the agent's home, which every agent in the sandbox can write, and the
   prelude sourced it unconfined: a co-tenant could replace it with commands the operator's shell
   would run. Fixed: the secret is written beside the sandbox's directory, where no agent reads,
   as a new file that follows no link, and the prelude deletes it once read.
2. The pane's pid file had no directory, so `release` ended nothing: fixed, as below.
3. A prompt matched by shape could be the operator's: fixed, `ready` carries a nonce.
4. `PaneTerminal.herdr` had no identity for a host to key a box's workspace by: fixed,
   `{ key, run }`; `command` is renamed `harness`, and the seam text in this story follows.
5. `defaults` written headless too: kept, and recorded with its effect on a headless codex.
6. The probe's codex moved to sol headless too: tried luna headless again, and it declined every
   command ("I did not run the listed commands"), so sol stays for both, as the notes say.
7. Smaller: the placement host's pane refusal duplicates the engine's (kept: the harness used alone
   would otherwise make a workspace to refuse in, as the 1b note now says); the story said the
   engine writes the secret (fixed); `close` left `bin/` (fixed); three `shellQuote`s (srt's and
   the adapter's are now one, in `@agentswf/sandbox`, and tested; the engine's launcher keeps its own);
   home session reads followed links (fixed, `ownFiles`).

**Correctness and proof.** Findings and resolutions:

1. High: `release` ended nothing in a pane, as the pid file's directory did not exist. Fixed,
   and more was needed: with job control, a job the harness left in the background had a group
   of its own and outlived both the group kill and the tab's close. The confined zsh now runs
   `+m`, and a local test in a real pty shows a background and a foreground job both ended by
   `release`; it fails with job control on. The eval found leftovers by argv, which a pane's
   processes do not carry: it now reads each process's environment.
2. High in impact: a harness could be typed into the operator's login shell. Its prompt, like the
   confined zsh's, ends in `%`, and the echo of the typed prelude always satisfied "the screen
   moved on". Fixed: the confined shell's prompt is `awf-%-{nonce}% `, typed as `%%`, which the
   echo cannot show. srt's bash drops `PS1`, so it rides as `PROMPT`. A fake-CLI test swallows
   the prelude and shows that the harness is never typed.
3. A co-tenant could plant a link at `.secrets`, and the engine would write the token through it:
   fixed, as architecture 1, and tested against a planted link, a linked directory and an open one.
4. Each Herdr call during the typed start was bounded only by the whole deadline, and so was
   `agent wait`: fixed, the command timeout and the 60 s step bound. A blocked start without trust
   accepted now says so.
5. `LOGIN_PROMPT` failed on a right prompt or a theme: dropped. The prelude is typed once the
   screen settles, at most 10 s, and `ready` alone is the gate. Herdr's `tab create` takes no
   command, so the login shell cannot be skipped.
6. codex's home sessions were in listing order, so a subagent could count as the agent's own:
   fixed, start order, tested.
7. Smaller: the `never detects` test passed with the tab open (fixed, it checks); the adapter's
   quoting left `=word` bare, which zsh expands (fixed, every word quoted); the prelude lands in
   the operator's shell history (kept: it holds paths, no token); no `LANG` in the pane (kept:
   only the prelude's ASCII passes through zsh's line editor; prompts reach the harness through
   Herdr).

**The docker half**, two more read-only subagents; the correctness reviewer drove real boxes,
panes and cancellations with `sh` for a harness, and mutated the code to test the tests.

Architecture and scope:

1. A box already removed was closed at the workspace but not its tabs, so the host's close
   failed on the engine's deadline path: fixed, a box's tab close cannot fail the host, tested.
2. No version was named: the check compared the box with the host's install. Fixed:
   `HERDR_VERSION` in the adapter, the image pinned to it, and a test that holds them equal.
3. The story's text lagged the build: fixed, the Panes section and the notes.
4. Smaller, fixed: `watch` and `PaneHerdr`'s key described exactly in the seam; two comments;
   one proxy variable list; the box's `PATH` read once; the Dockerfile's version no build argument.
   Kept: `PaneHerdr` on each terminal, as the harness sees an occupant, not a sandbox.

Correctness and proof:

1. Nothing tested that a cancel reaches a box's Herdr command, or two agents' panes opening at
   once: both tested now, and each test fails under the mutation the reviewer made. The behaviour
   was sound live: ten aborts left no process or pid file in the box.
2. A removed box failing the host's close: as architecture 1.
3. A box's Herdr that dies is not restarted: recorded.
4. An unread secret could outlive a dead engine in a stopped box: fixed, the box runs `--rm`.
5. Found sound: no token on any argv or in `/proc`; values with quotes, `$` and newlines intact;
   the pane's environment exactly the prelude's; `release` ending `&`, subshell and `nohup` jobs,
   only a `setsid` one left to the box's removal (X21); tab close ending every job; the box's pid
   files reaped on every exit; unsandboxed panes unchanged.

#### 6

Two read-only subagents, 2026-09-26, checked every changed document against the code, the
findings and the implementation notes.

**Architecture and scope.** Findings and resolutions, all fixed: the rewrite dropped the designed
harness-level grant (`Grant`, `CapabilityRef`, `use`) while still naming it, so it is restored as
unbuilt; the dropped `env` axis is recorded as deliberately not built, and "environment" meaning
variables says so; remote execution means the engine running where the agents are, in
`permissions.md` and `foundation.md` §10; `eval-isolation.md` marks every leak a sandbox closes;
state moved out of `permissions.md` into `status.md`; "record what it applied" contradicted "does
not report which parts it held"; `permissions.md` now states it is the canonical design and links
the story's rejected alternatives rather than repeating them; a stale "not otherwise separated";
the dependency graph, "all four packages", and Markdown links in `foundation.md`.

**Correctness and proof.** Findings and resolutions, all fixed: invariants 6 and 7 were stated
for every provider, and now carry srt's `setsid` escape (X21) and docker's process that leaves
its group; what the conformance suite checks was overstated (4 and 5 are skipped against the
fake, 1 and the network are not in it); "sees only the paths and domains it names" and "a home
holding only its credential" were narrower than the truth; git's protected paths under docker
are quarantined, not read-only; a door's authority holds between sandboxes, not within a shared
box; the skills root and a box's Herdr are designed, not built; srt runs the harness's real path;
`foundation.md` and `AGENTS.md` now list the same seven boundaries as the script; the eval totals
were a sum never measured, and are now a measured run.

## Readiness

- [x] Outcome and boundaries are concrete.
- [x] Relevant implementation, callers, and tests are mapped.
- [x] Evidence and research support the proposed design (Task 0; X13 changes only whether
  write-back is needed).
- [ ] Expensive interface, record-format, and stage-gate decisions are settled: awaiting the
  user's review of the author surface, the seam, the package and the default provider.
- [x] Tasks are ordered, coherent, and independently verifiable.
- [ ] Open questions are resolved or explicitly moved out of scope.

## Implementation notes

### 1a

- **`ResolvedSandbox` has every reach field and `gitdirs: Gitdir[]`.** Providers need the
  gitdirs and whether each is writable; resolving them once keeps srt and docker from drifting.
- **`HarnessSandboxNeeds.token` carries the value**, not only the variable's name, so a provider
  never reads the engine's environment, and a sandboxed claude without its token is refused where
  its needs are built.
- **`SandboxProviders` and `REAP_GRACE_MS` are in the seam**; contract exports
  `SANDBOX_ENVIRONMENTS`, the keys a spec, a ref and the registry share.
- **Resolution refuses any path overlapping the operator's harness state**, not only srt's pure
  check, so the rule is the same under both providers.
- **The conformance suite has its own small runner** with `runProcess`'s group contract, as the
  sandbox package cannot import harness. A provider imports the seam by relative path: Bun's
  isolated linker gives a package no link to itself.
- **A failed reap is `ProcessResult.reapFailed`**, leaving the result's other fields alone.
- **`check-boundaries.ts` exports `boundaryProblems(root)`**, so a test runs it on a fixture tree.

### 1b

- **`sandboxNeeds(harness, home, model, environment)` is in `sandbox-needs.ts`**, not `spec.ts`:
  it finds the executable on `PATH` and its install tree, which is file-system work the table
  does not do. `HarnessSandboxNeeds.executable` is the real path srt runs; docker runs `command`.
- **The web-search flags are harness data** (`sandboxedArgs(harness)`), inserted by each plan
  where they swallow nothing, not a seam field.
- **A sandboxed pi names its provider in its model**, and runs with `--no-extensions`.
- **The pane refusal** is in the placement host and in session-core (`launchesInSandbox`). Since
  Task 5 the engine also refuses a pane in a sandbox without `panes` before the agent's channel
  opens; the placement host's check stays, so the harness used alone never makes the operator a
  Herdr workspace only to refuse the agent in it.
- **`defaults(cwd)` returns nothing** until Task 5 writes a pane's first-run answers.

### 1c

- **The run's sandboxes live in `engine/src/sandboxes.ts`** (`RunSandboxes`), not in
  `workflow-runner.ts`: resolution, opening, private sandboxes, seats, serialized admission,
  release, close and the record. The runner calls it in the order the story gives.
- **`RunWorkflowOptions.sandboxes` is `{ providers, runRoot }`**: the operator CLI passes the
  `--run-root`, so every run under it is denied, not only this invocation's directory.
  `installOperatorRuntime` returns the providers; none are installed until Task 2.
- **The bundle is built by a `bun build` subprocess and written beside each agent's launcher.** In
  process, `Bun.build` resolved packages against the test runner's state and failed; and bun will
  not load a module from the control plane's directory, which is deliberately not listable.
- **A reap that fails or overruns is logged by the engine's wrapper around each occupant's
  `reap`**, on every path a turn can end by.
- **A sandboxed agent's reopen compares its inline spec by resolving it again.** A ref compares by
  identity.
- **Cleanup that overruns its grace still closes the sandboxes**, on a grace of its own.
- **`SandboxRecord.gitdirs`** records the git directories resolution added to reach, so an audit
  sees all of it; `OpenedSandbox.record` carries what only the provider knows.
- **A pane's capability is the sandbox's (`OpenedSandbox.panes`)**, decided now for Task 5: an
  occupant exists only after admission, which comes after the channel.
- **A private sandbox closed after its agent failed stays in the record**, with any agent it
  admitted, as its home is evidence. A reopen of that agent gives its own failure, not a conflict.
- **Write-back is per operator file and serialized.** When two agents share a credential and one
  writes back, the other's baseline no longer matches, so its later refresh is not written: X13
  decides whether that matters.

### 2

- **`createSrtProvider(options)` takes the host as found once** by `findSrt(environment,
  harnessState)`: srt's CLI and node by real paths (an agent's `PATH` may lack both), the
  toolchain, and the agent's `PATH`. `installOperatorRuntime` calls it; the engine passes the
  harness's state roots, which the sandbox package cannot import.
- **An agent's `PATH` also keeps the engine's `PATH` directories outside the denied regions**,
  such as `/opt/homebrew/bin`: a node or git installed there is readable and would otherwise be
  missing. The story listed only the toolchain's `bin` directories and the system's.
- **Each launch records its group's leader in a pid file** (`groups.ts`, shared with the fake),
  so `release` ends what an agent still runs, a turn left finishing included. The design had srt
  with nothing to reap; the conformance suite's release test showed a turn would outlive it.
- **The probe reaches for `registry.npmjs.org`**: `example.com` does not resolve on this machine,
  so a refusal to reach it proved nothing. The local test learned the same.
- **The per-agent `bin/` link is left to Task 5**, where a pane types the harness's name.
- **Profiles live in the sandbox's `profiles/`**, readable inside, as they hold no secret.
- **The toolchain is not the parent of each `bin` under `~`**, as X19 and the design had it: that
  made `~/.local` (its `state/`, tools' credentials) and `~/.orbstack` (an SSH key) readable. It is
  the `bin` directories and each executable's install tree: a node package's root, a `bin/` beside
  a `lib/`, or the executable alone. The pure check also refuses `~/.ssh`, `~/.gnupg`, `~/.aws`,
  `~/.docker` and `~/.kube`.
- **A writable gitdir keeps read-only everything the host's git runs or follows**: `hooks`,
  `config`, `config.worktree`, `commondir`, `gitdir`, `modules` and `info`, in each gitdir and in
  every other worktree's under it. Commits still work.
- **A process that starts its own session survives the group kill under srt** (X21), confined but
  running until it exits. Invariant 6 holds for everything else; docker's box removal ends one.
- **The gitdir rule is one list, `protectedGitPaths` in `src/git.ts`**, which both providers
  hold: srt denies each path; docker cannot mount a path that does not exist read-only, so it
  moves one an agent makes into the sandbox's `quarantine/` at every reap and at close.
- **The operator cannot replace the toolchain yet**: `findSrt` derives it, and nothing overrides
  it. The story's `createSrtProvider({ toolchain })` became `createSrtProvider(findSrt(…))`.

### 3

The local test and the conformance suite passed against docker on 2026-09-26, once the daemon
answered again; they found one fault, in the suite: its release case counted processes through
the agent it had just released, which a released agent refuses. It counts through a co-tenant.

- **`createDockerProvider({ client, defaultImage, user })`**: the client is the seam a test
  replaces, and `findDocker` finds only the CLI. The daemon is first asked at the first open,
  bounded to 5 s, so a run that opens no box never waits on a daemon that hangs.
- **The door's files go in as root through `docker exec -i … cat`**, not `docker cp`, and the
  proxy and the relay run from their sources by `node -e`, so neither needs a rebuilt image.
- **No `setsid` in a launch**: runc makes the exec'd shell a session leader, and `setsid` would
  fork and lose the turn's exit code. The shell records its pid; the reap kills its group.
- **The relay's pid is recorded where only root writes**, so `release` ends it in the box.
- **The default image's tag is a hash of its Dockerfile**, whose every input is pinned there,
  Herdr by release and checksum since Task 5. An unbuilt
  default image, or a spec's image not pulled, is refused at open, naming the command.
- **Boxes and proxies run with `--cap-drop ALL` and `no-new-privileges`**, end on their own past
  the run's deadline, and an expired one a crashed run left is swept at the next open.
- **The operator's uid gets a passwd entry in the box**, as the image has no user for it.
- **The proxy listens on the sandbox's internal network only, and allows port 443 only.**
- **Resolution refuses the engine's doors** (`controlRoot`): no reach may contain `/tmp` or lie
  in a run's `awf-*` directory, where an agent could rewrite another agent's launcher.
- **Docker is the default when srt is not installed**, which "Alternatives rejected" did not
  foresee: with one provider, it is the one there is.
- **Residuals.** Agents in one box share its uid, so each can read another's environment, token
  included, and reach its door; srt gives each only its own socket. A protected gitdir path an
  agent creates lives until the next reap. A process that leaves its group lives until close.

### 4

- **`examples/sandbox-probe` takes its plan as one JSON argument**: the host plants the canaries
  and writes each agent's commands, since a workflow file does no I/O. The eval checks from the
  agents' own session files, its listener and the working directory, not their word.
- **The eval found the door failing under srt** (X22): zsh and macOS's bash 3.2 write a heredoc's
  temp file where srt denies it, so codex's and pi's `wf result` failed while claude's worked. srt
  sets `SHELL=/bin/zsh` and `TMPPREFIX` in the sandbox's temp, and pi's seeded `settings.json`
  names zsh as its shell; `defaults` are now written for every sandboxed agent, not only panes.
  The docker image carries zsh. `/var/tmp`, which had been readable by every agent, is denied.
- **Two evals, `sandbox-srt` and `sandbox-docker`**, over one module whose checks are a pure,
  unit-tested function: a hung daemon cannot hide a passing srt run, and docker reports itself
  skipped, saying why. Each check rests on the agents' transcripts, not their reports: every
  canary and the hook must show the OS's refusal there.
- **codex runs with its apps and plugins off** (X23): they act through the login on the
  operator's ChatGPT account, as web search reaches past egress.
- **The probe's prompt says the test is the operator's**: codex's cheapest model otherwise
  declined to run commands that read outside its reach.
- **`sandbox-docker` passed on its first live run**, 2026-09-26, in 2m 39s, ~$0.29, once the
  daemon answered again.

### 5

Both halves verified live: `sandbox-panes-srt` and `sandbox-panes-docker`.

- **`PaneTerminal.herdr` is `"run"` or a keyed `run(args)`** that builds a `SandboxedCommand` for
  the box's own Herdr, rather than an argv prefix: the docker client needs its environment, a
  cancelled command in a box must be reaped, and the key tells the host which Herdr it is.
- **`PaneTerminal.ready` is the proof of confinement.** The confined zsh's prompt carries a nonce
  the typed prelude cannot contain, and the harness is typed only once the screen's last line
  ends with it. Matching the operator's prompt by its shape was dropped: a right prompt or a
  theme broke it, and a swallowed prelude left a login prompt shaped like the confined one.
- **The typed start is `adoptAgent`, beside `startAgent`**: a settled screen, the prelude,
  `ready`, the harness and its arguments with the web-search flags, `agent rename` polled until
  detected, then `agent wait --until idle` and any startup blocks. Each Herdr call is bounded by
  the command timeout and each step by 60 s. `herdr pane wait-output` and
  `report-agent-session` were not needed.
- **The provider writes the pane's secret, not the engine**, beside the sandbox's directory rather
  than in the agent's home, which its co-tenants can write. `writeSecrets` in `@agentswf/sandbox` holds
  the rules every provider needs: a private directory, a new file, no link followed. The prelude
  deletes the file once read, so the token outlives the pane's start by about a second.
- **The confined shell runs without job control** (`zsh -f +m`): with it, a job the harness left
  in the background had a group of its own, and outlived both `release` and the tab's close.
  Its pid file's directory now exists before the prelude writes it.
- **A sandboxed agent's sessions are also every session in its own home** (`homeSessions`): a
  pane's harness names its session to nobody until it calls `wf`, and one that never does was
  unaccounted for. Codex's are read in start order, so a root is counted before its subagents,
  and none is read through a link in the home.
- **`defaults` are written for every sandboxed agent**: claude's and codex's first-run answers
  serve both placements from one home, and pi's shell (X22) is needed headless. A trusted folder
  lets a headless codex read the repository's `.codex/config.toml`, which runs confined, and whose
  settings the `-c` flags override.
- **The probe's codex is `gpt-5.6-sol`**: luna declined its commands in a pane however framed,
  and headless in one run of two.

- **docker's pane is built as the Panes section now says.** Where it departs from the design:
  the box's Herdr keeps its home in the box, not under `homes/`, as nothing of it need reach the
  host; the adapter, not the provider, checks the box's version, against `HERDR_VERSION`, which a
  test holds equal to the Dockerfile's; the secret is written by the agent's uid through stdin,
  not by `writeSecrets`, which is srt's; and `watch` is recorded at open and printed at the first
  pane agent. The Herdr host keeps one workspace per box key, and a box already removed counts
  its tabs and workspace as closed.
- **A box's Herdr that dies is not started again**: its panes fail, and the run with them.
- **A box runs `--rm`**, so one that stops on its own takes any unread secret with it.

### During human review

- **`examples/sandboxes`**: three codex agents headed in one docker box, then pi headless under
  srt reading what they wrote. Run live, and interrupted twice with Ctrl-C.
- **Ctrl-C through `bun awf` left a box, its proxy and network running.** The terminal signals
  the whole process group, and `bun awf` forwards SIGINT once more; `awf run` handled only the
  first, so the second killed it mid-cleanup. It now handles every SIGINT, SIGTERM and SIGHUP
  (`cancelOnSignals`), the first cancelling, and exits `128 +` the signal's number. The evals had
  the same `once` and have it no more. A repeat more than a second later is the operator's
  second Ctrl-C, which stops `awf` at once, as its usage says. Verified live by signalling the process group of
  `bun awf run` 15 s and 30 s into `examples/sandboxes`: exit 130 after 11 s, and no container,
  network, `docker exec` client or Herdr workspace left. An engine killed outright still leaves
  its boxes until their deadline and grace, when the next docker open removes them.
- **A run whose panes were all in a box opened an empty workspace in the operator's Herdr.** The
  run's workspace now opens at the first tab it needs, and at a box's first pane agent the host
  types the box's `watch` command, now on the keyed `PaneHerdr`, into that workspace's first pane,
  labelled `sandbox {key}`: the box's Herdr, with its agents' panes, shows beside the run's. On by
  default; `awf run --no-watch` leaves it out, and no workspace opens for such a run. Best
  effort, as the engine prints the same command. Verified live with `examples/sandboxes` both ways.
- **The sandbox evals no longer skip.** Each fails, saying why, where its provider is not installed
  or docker's daemon does not answer within 30 s, and `sandbox-docker` builds the default image when
  it is missing, so `bun run eval` always exercises real srt and docker.
- **A review for slop and design, then three for correctness** (sandbox package, harness, engine
  with CLI), all read-only, over the whole story's diff. What changed:
  - **The docker sweep never removed a container**: `docker ps` has `.Names`, not `.Name`, so its
    template failed and nothing was swept; a proxy, which had no expiry of its own, outlived every
    crashed run. Fixed, with both labels required; the proxy runs under `timeout` with `--rm`, as
    the box runs `sleep`; a unit test answers as docker does.
  - **What the host's git follows outside a gitdir**: a linked worktree's or a submodule's `.git`
    pointer, rewritten, points the host's git at a gitdir an agent made. `protectedPaths` (was
    `protectedGitPaths`) guards them, a repository nested in a writable path (found by a scan,
    refused beyond 100,000 directories), and a common gitdir's `index` and `HEAD` when it is
    writable only through a linked worktree (`Gitdir.linked`). docker also guards what srt denies
    by its own list, plus claude's project settings, at each writable root.
  - **Key directories refused for every provider**, not only srt's toolchain: docker could mount
    `~/.ssh`. `~/.orbstack/ssh` joins them.
  - **A co-tenant could plant a link where a home is seeded**, and the unconfined engine would write
    through it: a home is built in the sandbox's `staging/`, which no agent writes, then moved
    into `homes/`. **Write-back took any JSON**: an agent could swap in another account for the
    operator's. Only a copy that differs in the fields a refresh rewrites goes back (`refreshes`
    on each seed: codex's tokens and `last_refresh`, pi's `access`, `refresh` and `expires`), so
    an account the file names stays; pi's anthropic entry names none. A copy refused is logged.
  - **Accounting read sessions an agent named**, which a link could make the operator's: a
    sandboxed agent's usage is its own home's sessions only.
  - **Lifecycle**: `close` waits for a sandbox still opening, so it is recorded and closed; no agent
    is admitted once release starts; a reopened agent is compared with a private sandbox still
    opening; a provider that fails to set up fails only the specs that name it.
  - **Harness**: a pane start after a failed one gets a fresh terminal (the prelude consumes its
    secret); `runProcess` reaps on every path and alone bounds a reap (`reapFailed`, never read, is
    gone); the watch tab is cancelled when the host closes.
  - **Smaller**: under srt, a stale pane pid file no longer kills a group whose pid a newer
    process holds (a box's pids are its own);
    docker's guard falls back to copy and remove across volumes, and fails if it cannot; a refused
    agent's domains stay out of the proxy's list; srt refuses a write inside a read inside a write,
    which it would deny; the srt probe's timer is clamped.
  - **Design**: the record keeps a provider's facts as `provided`, in its own shape, not a field
    per provider, with `provider` typed and `Gitdir` in the contract; the watch command has one
    source, `PaneHerdr.watch`; one pane prelude, one in-box kill script taking its files as
    arguments, one `shellQuote`; `token` is a `secrets` record; the harness's state directories are
    a record by harness, and the engine uses one operator environment for them and for `PATH`; the
    runner's two agent-open paths share their registration; the pane check lives in the engine
    alone; the seam exports only what others use.
- **A second review, of those fixes**, found what they opened:
  - **The nested-repository scan could widen reach**: a `.git` an earlier agent wrote in a writable
    path, naming another repository, had that gitdir mounted writable. One whose gitdir lies
    outside `write` is refused; one whose gitdir is gone is skipped.
  - **docker's guard followed links**: an agent that made `.claude` a link to the operator's had
    `~/.claude/settings.json` moved into quarantine at the next reap, and a protected path already
    a link was mounted, exposing what it named. A link among protected paths, or above one, is
    not mounted or followed: it is kept while unchanged and moved as a link otherwise. What the
    guard moves is recorded in `provided.quarantined`.
  - srt made the agent's `gitconfig` after the home was in place, through any link a co-tenant
    planted: it is created exclusively, never through a link. A failed seed removes what it
    staged. A reopened agent is compared by its spec alone, as its own clone adds a gitdir. A
    refused write-back is logged once, with the path that differs; `refreshes` checks only a
    file's own keys. Another worktree's `index` and `HEAD` are protected like the main one's, and
    a clone's root gets the host-run list. srt that cannot be set up stays the default, so a spec
    naming none fails saying why.
- **A third review** found docker's guard trusting a protected file's read-only mount, though a
  directory above it can be renamed and made again with the agent's own file in it: a protected
  path whose directories are not those it had at open is moved out, while the operator's own edit
  on the host, which replaces a file in place, stays. Submodules are committed in under neither
  provider now: under docker a submodule's gitdir had been mounted writable over the read-only
  `modules`, where srt denied it. A refused write-back no longer stops the other seeds'.
- **A fourth review** found the guard could still be turned: a link made above a link kept at
  open had the guard move the operator's file it then named, and any move on the host races an
  agent swapping a directory for a link. The guard now only finds what to move; the move is made
  in the box, into a `quarantine/` it mounts, where a link names nothing the mounts do not, and
  a failure no longer stops the rest. A submodule's gitdir is read-only however it is reached,
  an agent working in it included. `core.hooksPath` hooks in a writable path are protected, as
  is what a protected path that is a link names in one: this repository's `.githooks` was
  writable. The operator's own `git checkout` on the host during a run, which makes a protected
  file's directory anew, has that file moved at the next reap: the guard cannot tell it from an
  agent's.
- **A fifth review** found a kept link that an agent replaced with a directory of its own went
  unnoticed; `core.hooksPath` taken against the main worktree's root only, though git takes it
  against the one committed in; and a link whose protected path did not exist yet left what it
  would name unguarded. Fixed, with tests. The last guard, at close, first ends everything of
  the box's uid, so nothing that escaped its group writes after the look; guards run one at a
  time; a path gone while being moved is not a failure; and a failure names what was left.
- **A sixth review, adversarial, found what paths cannot close.** Accepted at human review as
  future work, in [[sandbox-host-protection]]:
  - **docker's read-only file mounts do not hold on macOS**: the host's disk ignores case, and a
    mount covers only the name it was made at. Verified: in a box, appending to `.git/CONFIG`
    wrote the host's read-only `.git/config`. Directory mounts such as `hooks` likely fall the
    same way. The guard sees an unchanged path and moves nothing. srt denies every case variant.
  - **Hooks run what the worktree holds**: a protected `pre-commit` that runs
    `node_modules/.bin/biome`, husky's scripts, `lefthook.yml`, `.pre-commit-config.yaml`. No
    list of paths closes this.
  - **A repository made during a run is not guarded**, under srt too: `git init
    --separate-git-dir` with a planted `core.fsmonitor` ran on the host's next `git status` there.
    Host-run config below a writable root (`packages/foo/.claude/settings.json`) is unguarded.
  - **docker's guard lives only as long as the engine**: after a crash, a planted file stays.
  - **srt refuses `mkdir .claude`** where none exists, as it blocks creating the ancestors of a
    denied path; docker allows it.
  The last guard now stops the box's processes rather than killing them, which would have ended
  the box and the move with it.

## Human review

- [x] Every task is complete and story-level verification passes.
- [x] Set the story status to `awaiting-human-review` and present the outcome, architecture
  decisions, task-level subagent findings and dispositions, exact verification results, deviations,
  and remaining risks.
- [x] 2026-09-26: the human asked for the experiments removed, an example of both modes, clean
  Ctrl-C, a watch of a box's Herdr, real docker in `bun run eval`, and reviews for slop and
  correctness until clean; each is recorded under "During human review". The sixth review's
  limits were accepted as future work ([[sandbox-host-protection]]), and the story approved.
- [x] Changes requested were made, reviewed and verified above: `bun test` 704 pass, `bun run
  eval` 7 of 7 with docker, and the sandbox evals again on the final code.
- [x] Marked `done`, and `Stories at a glance` updated.
