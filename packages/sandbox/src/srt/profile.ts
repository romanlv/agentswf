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
      denyRead: unique([host.home, ...DENIED, context.runRoot, ...spec.hidden]),
      allowRead: unique([
        spec.cwd,
        ...spec.read,
        ...spec.write,
        ...gitdirs,
        context.directory,
        ...host.toolchain,
      ]),
      allowWrite: unique([
        ...spec.write,
        ...spec.gitdirs.filter((gitdir) => gitdir.writable).map((gitdir) => gitdir.path),
        join(context.directory, "homes"),
        temp,
      ]),
      // What is hidden, which srt denies though an allowed path holds it: it applies a deny nested
      // in an allowed path after the allow. What the host's git runs or follows, and a `read` path
      // inside a `write` one, which the more specific path makes read-only.
      denyWrite: unique([
        ...spec.hidden,
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
export function agentProfile(base: SrtSettings, agent: AgentContext): SrtSettings {
  const launcherDirectory = dirname(agent.door.launcher);
  return {
    ...base,
    network: {
      ...base.network,
      allowedDomains: unique([...base.network.allowedDomains, ...agent.harness.domains]),
      allowUnixSockets: [agent.door.endpoint],
    },
    filesystem: {
      ...base.filesystem,
      allowRead: unique([
        ...base.filesystem.allowRead,
        ...agent.harness.reads,
        agent.harness.executable,
        ...agent.door.reads,
        launcherDirectory,
      ]),
      denyWrite: unique([...base.filesystem.denyWrite, launcherDirectory]),
    },
  };
}

/**
 * The pure check every profile passes before srt sees it, against the spec it was made from: `~`
 * and the run root denied, each `hidden` path denied for reads and writes, and no allowed path exposing `~` or the run root,
 * reaching into the run root outside this sandbox's directory, or overlapping the operator's
 * harness state. A harness's install tree may lie inside its state (codex's `~/.codex/packages`),
 * never contain it. An allowed path may hold the run root only when it is hidden.
 */
export function checkProfile(
  settings: SrtSettings,
  host: SrtHost,
  context: SandboxContext,
  { hidden }: Pick<ResolvedSandbox<unknown>, "hidden">,
): void {
  const { denyRead, allowRead, allowWrite, denyWrite } = settings.filesystem;
  for (const denied of [host.home, context.runRoot]) {
    if (!denyRead.includes(denied)) throw new Error(`srt profile does not deny ${denied}`);
  }
  for (const path of hidden) {
    if (!denyRead.includes(path) || !denyWrite.includes(path)) {
      throw new Error(`srt profile does not hide ${path}`);
    }
    // srt's deny, applied after every allow, would hide this sandbox's own directory with it.
    if (contains(path, context.directory)) {
      throw new Error(`srt profile would hide its own directory ${context.directory} in ${path}`);
    }
  }
  for (const path of [...allowRead, ...allowWrite]) {
    if (contains(path, host.home)) throw new Error(`srt profile would expose ~ through ${path}`);
    if (
      path === context.runRoot ||
      (contains(path, context.runRoot) && !hidden.includes(context.runRoot))
    ) {
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
