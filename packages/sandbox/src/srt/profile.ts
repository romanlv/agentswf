import { dirname, join } from "node:path";
import { contains, KEY_DIRECTORIES } from "../resolve";
import type { AgentContext, ResolvedSandbox, SandboxContext } from "../seam";

/** srt's settings file, as much of it as a sandbox uses. */
export type SrtSettings = {
  enableWeakerNetworkIsolation: true;
  /** A pane's only: zsh cannot take the terminal without it, and nothing is detected (H6). */
  allowPty?: true;
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowUnixSockets: string[];
  };
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
};

/** What srt needs to know of the host, found once when the provider is made. */
export type SrtHost = {
  /** The operator's home, real. */
  home: string;
  /** The operator's harness state, which no allowed path may overlap. */
  harnessState: readonly string[];
  /** What the project's tools under `~` need (X19): their `bin` directories and install trees. */
  toolchain: readonly string[];
  /**
   * macOS's `xcrun` cache, in the operator's temp directory, which `/usr/bin/git` reads on every
   * call: without it each call starts `xcodebuild`, 1.2 s instead of 0.1 s (story 019). It holds
   * tool paths only, and is read, never written.
   */
  xcrunCache?: string;
};

/** Regions no agent reads, besides `~`, before a sandbox re-allows its own paths inside them. */
export const DENIED = [
  "/Users",
  "/home",
  "/Volumes",
  "/tmp",
  "/private/tmp",
  "/private/var/folders",
  "/private/var/tmp",
];

/**
 * A sandbox's base: reach and the toolchain readable, `write`, homes and its temp writable, and
 * nothing of the network but `network`. `enableWeakerNetworkIsolation` is the one trustd lookup
 * codex's TLS needs (Task 0); `allowLocalBinding` stays off.
 */
export function baseProfile(
  spec: ResolvedSandbox<unknown>,
  context: SandboxContext,
  host: SrtHost,
  temp: string,
  /** What the host runs or follows, which no agent writes: `protectedPaths`. */
  protectedGit: readonly string[],
): SrtSettings {
  const gitdirs = spec.gitdirs.map((gitdir) => gitdir.path);
  return {
    enableWeakerNetworkIsolation: true,
    network: { allowedDomains: [...spec.network], deniedDomains: [], allowUnixSockets: [] },
    filesystem: {
      denyRead: unique([host.home, ...DENIED, context.runRoot]),
      allowRead: unique([
        spec.cwd,
        ...spec.read,
        ...spec.write,
        ...gitdirs,
        context.directory,
        ...host.toolchain,
        ...(host.xcrunCache ? [host.xcrunCache] : []),
      ]),
      allowWrite: unique([
        ...spec.write,
        ...spec.gitdirs.filter((gitdir) => gitdir.writable).map((gitdir) => gitdir.path),
        join(context.directory, "homes"),
        temp,
      ]),
      // What the host's git runs or follows, and a `read` path inside a `write` one, which the more
      // specific path makes read-only.
      denyWrite: unique([
        ...protectedGit,
        ...spec.read.filter((path) =>
          spec.write.some((root) => root !== path && contains(root, path)),
        ),
      ]),
    },
  };
}

/**
 * One agent's profile: the base, its harness's model domains and install tree, its executable,
 * and its door: the launcher's directory readable and never writable, and its own socket alone.
 */
export function agentProfile(
  base: SrtSettings,
  agent: AgentContext,
  /** The agent's short directory, which it alone reads, writes and binds sockets in. */
  short?: string,
): SrtSettings {
  const writes = [...(short ? [short] : []), ...(agent.harness.sharedWrites ?? [])];
  // A harness that names a shared directory through `/tmp`, as cursor does, follows that link,
  // which srt denies with the rest of `/tmp`; the link alone opens nothing behind it (story 019).
  const tmpLink = (agent.harness.sharedWrites ?? []).some((path) => contains("/private/tmp", path))
    ? ["/tmp"]
    : [];
  const launcherDirectory = dirname(agent.door.launcher);
  return {
    ...base,
    network: {
      ...base.network,
      allowedDomains: unique([...base.network.allowedDomains, ...agent.harness.domains]),
      allowUnixSockets: [agent.door.endpoint, ...(short ? [short] : [])],
    },
    filesystem: {
      ...base.filesystem,
      allowRead: unique([
        ...base.filesystem.allowRead,
        ...agent.harness.reads,
        agent.harness.executable,
        ...agent.door.reads,
        launcherDirectory,
        ...writes,
        ...tmpLink,
      ]),
      allowWrite: unique([...base.filesystem.allowWrite, ...writes]),
      denyWrite: unique([...base.filesystem.denyWrite, launcherDirectory]),
    },
  };
}

/**
 * The pure check every profile passes before srt sees it: `~` and the run root denied, and no
 * allowed path exposing either, reaching into the run root outside this sandbox's directory, or
 * overlapping the operator's harness state. A harness's install tree may lie inside its state
 * (codex's `~/.codex/packages`), never contain it.
 */
export function checkProfile(settings: SrtSettings, host: SrtHost, context: SandboxContext): void {
  const { denyRead, allowRead, allowWrite } = settings.filesystem;
  for (const denied of [host.home, context.runRoot]) {
    if (!denyRead.includes(denied)) throw new Error(`srt profile does not deny ${denied}`);
  }
  for (const path of [...allowRead, ...allowWrite]) {
    if (contains(path, host.home)) throw new Error(`srt profile would expose ~ through ${path}`);
    if (contains(path, context.runRoot)) {
      throw new Error(`srt profile would expose the run root through ${path}`);
    }
    if (contains(context.runRoot, path) && !contains(context.directory, path)) {
      throw new Error(`srt profile reaches into the run root at ${path}`);
    }
    const state = host.harnessState.find((root) => contains(path, root));
    if (state) throw new Error(`srt profile would expose harness state ${state} through ${path}`);
    const keys = KEY_DIRECTORIES.map((name) => join(host.home, name)).find(
      (root) => contains(path, root) || contains(root, path),
    );
    if (keys) throw new Error(`srt profile would expose ${keys} through ${path}`);
  }
  for (const path of allowWrite) {
    const state = host.harnessState.find((root) => contains(root, path));
    if (state) throw new Error(`srt profile would let ${path} in harness state be written`);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
