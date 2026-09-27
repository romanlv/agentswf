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

/** The environments contract names, each the key of its settings in a spec and of its provider. */
export const SANDBOX_ENVIRONMENTS = ["srt", "docker"] as const;
export type SandboxEnvironmentKey = (typeof SANDBOX_ENVIRONMENTS)[number];

/** At most one environment. Naming one pins the provider; naming none uses the operator's default. */
export type SandboxEnvironment =
  | { srt: SrtEnvironment; docker?: never }
  | { docker: DockerEnvironment; srt?: never }
  | { srt?: never; docker?: never };

export type SandboxSpec = SandboxReach & SandboxEnvironment;

/**
 * A git directory the sandbox's `cwd` or a reach path belongs to, found when it opens: a
 * repository's `.git`, a worktree's own gitdir and its common one, or a repository's nested in a
 * writable path. Readable inside. Writable when the worktree it serves is, so a writable worktree
 * can commit under every provider; what the host's git runs or follows in it never is.
 */
export type Gitdir = {
  path: string;
  writable: boolean;
  /**
   * Writable only through a linked worktree: the main worktree's `index` and `HEAD` in it stay
   * read-only, so an agent cannot stage what the operator commits next.
   */
  linked?: true;
};

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
  /** Grows as providers are added: never switch over it exhaustively. */
  readonly provider: SandboxEnvironmentKey;
}

/** A spec given inline to one agent: a private sandbox. It cannot carry a ref's or an open spec's fields. */
export type InlineSandboxSpec = SandboxSpec & { key?: never; cwd?: never; provider?: never };

export interface SandboxDirectory {
  /** Opens a sandbox for this run. It closes when the run does, after every agent in it. */
  open(spec: SandboxOpenSpec): Promise<SandboxRef>;
}
