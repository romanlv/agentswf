import type {
  AbsoluteDeadline,
  Domain,
  Gitdir,
  JsonObject,
  SandboxEnvironmentKey,
  SandboxKey,
  SandboxReach,
} from "@agentswf/contract/workflow";

/**
 * How long `runProcess` waits for a `SandboxedCommand`'s `reap` once its group is killed. A reap
 * that takes longer is abandoned, so a provider's must finish well within it.
 */
export const REAP_GRACE_MS = 5_000;

export interface SandboxProvider<E> {
  /**
   * Validates the raw environment settings, so untyped workflows are checked at run time. What it
   * returns is recorded as the spec's settings: plain JSON, in the contract's shape for its key.
   */
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
  /** The environment a spec that names none runs in; absent when nothing is installed. */
  readonly default?: SandboxEnvironmentKey;
  /** Why a provider this machine has could not be set up: said when a spec names it. */
  readonly unavailable?: Readonly<Partial<Record<SandboxEnvironmentKey, string>>>;
};

/**
 * The spec with its paths resolved: absolute, real, `~` expanded, domains lowercased, and a path
 * in both lists only in `write`. Every reach field is present, so a new one is a compile error in
 * each provider rather than a field it silently ignores.
 */
export type ResolvedSandbox<E> = {
  readonly [K in keyof SandboxReach]-?: NonNullable<SandboxReach[K]>;
} & {
  key: SandboxKey;
  cwd: string;
  /**
   * Paths inside reach that no agent reads or writes, which the provider hides: the run root,
   * when an allowed path holds it, as a project holds `.awf/runs`.
   */
  hidden: readonly string[];
  gitdirs: readonly Gitdir[];
  environment: E;
};

export type { Gitdir };

export type SandboxContext = {
  /** Every run's directory. Denied inside, and in the spec's `hidden` when an allowed path holds it. */
  runRoot: string;
  /** This sandbox's directory, holding `homes/`; outside the run root when the engine makes it. */
  directory: string;
  deadline: AbsoluteDeadline;
};

export interface OpenedSandbox {
  /** Readies the sandbox for one agent, or rejects: a cwd outside reach, a harness the image lacks. */
  admit(agent: AgentContext): Promise<Occupant>;
  /** Ends everything started inside and removes what `open` made, except `homes/`. */
  close(): Promise<void>;
  /** What only the provider knows about how it runs this sandbox: the record's `provided`. */
  readonly record?: JsonObject;
  /**
   * It hosts pane agents: each occupant's `pane()` gives one its terminal. A sandbox-level fact,
   * so a pane in one that does not is refused before the agent's channel opens.
   */
  readonly panes?: true;
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
  /** The terminal a pane agent runs in; present where the sandbox has `panes`. */
  pane?(): Promise<PaneTerminal>;
}

/** Where a pane agent runs, and what is typed to start it there (story 004, "Panes"). */
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
  /** How the harness is named in the confined shell, before its arguments. */
  harness: string;
};

/**
 * The Herdr a pane opens in: the run's own, or one inside the sandbox, whose commands run through
 * `run` so a cancelled one is reaped. Every terminal of one sandbox gives the same `key`, by which
 * a host keeps one workspace in it, driven by the first `run` it was given.
 */
export type PaneHerdr =
  | "run"
  | {
      key: string;
      run(args: readonly string[], timeoutMs: number): SandboxedCommand;
      /** What shows this Herdr's panes when run in a terminal on the host. */
      watch?: readonly string[];
    };

/** The process fields the seam carries, which harness's `runProcess` accepts. */
export type SandboxProcess = {
  argv: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

/**
 * Run by `runProcess` as its own process group with exactly `env`, inheriting nothing. Plain data,
 * own properties only, so a spread copies it whole: `reap` needs no `this`.
 */
export type SandboxedCommand = SandboxProcess & {
  group: true;
  /** Ends what the command left running inside, after `runProcess` has killed its group. */
  reap?: () => Promise<void>;
};

/** The agent's one way back to the engine. */
export type AgentDoor = {
  endpoint: string;
  /** The path the prompt names. It must run at this path inside and reach `endpoint`. */
  launcher: string;
  /** The launcher's contents for a box, copied to `launcher` inside it: `bundle` run by `bun` from `PATH`. */
  boxScript: string;
  /** The bundled `wf` command, a host file copied to the same path inside a box. */
  bundle: string;
  /** Host paths the host launcher reads: its interpreter and the bundle. */
  reads: readonly string[];
};

export type HarnessSandboxNeeds = {
  /** Variables pointing the harness at its home. */
  env: Readonly<Record<string, string>>;
  /**
   * Credential files copied into the home, and written back when a turn refreshes them: only the
   * JSON fields `refreshes` names may differ, a `*` standing for any one key.
   */
  seed: readonly { from: string; to: string; refreshes: readonly string[] }[];
  /**
   * Config files written fresh into the home: pi's shell (X22), and for a pane claude's
   * onboarding, trust and bypass answers and codex's folder trust (H3).
   */
  defaults(cwd: string): readonly { path: string; contents: string }[];
  /**
   * Credentials passed in the environment instead of a file, by variable: claude's
   * `CLAUDE_CODE_OAUTH_TOKEN`, read from the engine's. Never on a command line.
   */
  secrets: Readonly<Record<string, string>>;
  /** Model domains, for this agent's model and provider. */
  domains: readonly Domain[];
  /**
   * A variable the provider sets to a directory of this agent's alone whose path is short, for a
   * harness that binds a socket under it: a socket's path holds at most 104 bytes, and a sandbox's
   * homes lie deep. cursor's worker binds one there.
   */
  shortDirectory?: string;
  /**
   * Host directories this agent writes outside its sandbox's own, shared with whatever else uses
   * them: cursor's resume locks, at a path its code fixes in `/tmp`. The provider makes each, 0700,
   * where it is missing. A box's `/tmp` is its own, so docker needs none of them.
   */
  sharedWrites?: readonly string[];
  /**
   * The executable's name: `launch` receives it as `argv[0]`. Docker finds it on the image's `PATH`.
   */
  command: string;
  /**
   * Its real path on the host, which srt runs in `command`'s place: `~/.local/bin` and its links
   * are denied. Found on the engine's `PATH`, which srt gives the agent too.
   */
  executable: string;
  /**
   * Host paths srt must allow for the command to run: its install tree and interpreter. Never a
   * harness state root, though an install tree may lie inside one (codex's `~/.codex/packages/…`).
   */
  reads: readonly string[];
};
