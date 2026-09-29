import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SrtEnvironment } from "@agentswf/contract/workflow";
import { protectedPaths } from "../git";
import { LaunchedGroups } from "../groups";
import { onceUnlessFailed } from "../once";
import { panePrelude } from "../pane";
import { contains, repositoryOf } from "../resolve";
import type {
  OpenedSandbox,
  PaneTerminal,
  SandboxContext,
  SandboxedCommand,
  SandboxProvider,
} from "../seam";
import { removeSecrets, shellQuote, writeSecrets } from "../secrets";
import {
  agentProfile,
  baseProfile,
  checkProfile,
  DENIED,
  type SrtHost,
  type SrtSettings,
} from "./profile";

export type SrtOptions = SrtHost & {
  /** What runs srt: node and srt's `cli.js`, by real paths, as an agent's `PATH` may lack both. */
  command: readonly string[];
  /** An agent's `PATH` before the system's: the toolchain's `bin` directories and the like. */
  path: readonly string[];
  /** Runs the probe on the first open; a test of profiles alone turns it off. */
  probe?: boolean;
};

/** The system's own directories, last on every agent's `PATH`; srt needs `bash` there (H6). */
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * Anthropic's sandbox-runtime on this machine. A sandbox is a base profile; each admitted agent
 * gets a profile file built from it, and every process it runs is `srt -s {file} -- {command}`,
 * with exactly the environment the provider sets.
 */
export function createSrtProvider(options: SrtOptions): SandboxProvider<SrtEnvironment> {
  // Only a probe that passed is kept: a transient failure is tried again at the next open.
  const probed = onceUnlessFailed((context: SandboxContext) => probe(options, context));
  return {
    environment(raw) {
      if (
        typeof raw !== "object" ||
        raw === null ||
        Array.isArray(raw) ||
        Object.keys(raw).length > 0
      ) {
        throw new Error("srt takes no settings: name it as srt: {}");
      }
      return {};
    },
    async open(spec, context) {
      // srt applies every allow, then every deny: a `write` inside a `read` inside a `write`
      // would be denied, narrower than the spec says.
      for (const path of spec.write) {
        const read = spec.read.find((root) => root !== path && contains(root, path));
        if (read && spec.write.some((root) => root !== read && contains(root, read))) {
          throw new Error(
            `srt cannot make ${path} writable inside ${read}, read-only inside a write`,
          );
        }
      }
      const temp = join(context.directory, "tmp");
      const base = baseProfile(spec, context, options, temp, await protectedPaths(spec));
      checkProfile(base, options, context);
      if (options.probe !== false) await probed(context);
      await mkdir(join(temp, "npm"), { recursive: true, mode: 0o700 });
      await mkdir(join(context.directory, "profiles"), { recursive: true, mode: 0o700 });
      return openSandbox(context, options, base, temp);
    },
  };
}

function openSandbox(
  context: SandboxContext,
  options: SrtOptions,
  base: SrtSettings,
  temp: string,
): OpenedSandbox {
  const profiles = join(context.directory, "profiles");
  const launched: LaunchedGroups[] = [];
  return {
    record: { toolchain: [...options.toolchain] },
    panes: true,
    async admit(agent) {
      if (!contains(context.directory, agent.home)) {
        throw new Error(`srt: ${agent.home} is not one of this sandbox's homes`);
      }
      const settings = agentProfile(base, agent);
      checkProfile(settings, options, context);
      const profile = join(profiles, `${randomUUID()}.json`);
      await writeFile(profile, JSON.stringify(settings, null, 2), { mode: 0o600 });
      // git refuses an unreadable `~/.gitconfig`; this one is empty (X4). Made anew, never through
      // a link a co-tenant planted in the home.
      const gitconfig = join(agent.home, "gitconfig");
      await (
        await open(
          gitconfig,
          constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
          0o600,
        )
      ).close();
      // The agent's whole environment: nothing of the engine's reaches it (X20).
      const environment: Record<string, string> = {
        HOME: options.home,
        PATH: [...options.path, ...SYSTEM_PATH].join(":"),
        CLAUDE_CODE_TMPDIR: temp,
        // The `wf result <<'WF_JSON'` every prompt asks for needs a heredoc's temp file. zsh
        // writes it under `TMPPREFIX`, `/tmp/zsh` by default, which is denied; macOS's bash 3.2
        // writes it in `/var/tmp` whatever `TMPDIR` says, which is denied too (X22). So the
        // harnesses' shell is zsh, its heredocs in the sandbox's temp.
        SHELL: "/bin/zsh",
        TMPPREFIX: join(temp, "zsh"),
        GIT_CONFIG_GLOBAL: gitconfig,
        npm_config_cache: join(temp, "npm"),
        ...agent.harness.env,
      };
      const agentId = randomUUID();
      const groups = new LaunchedGroups(join(context.directory, "pids", agentId));
      launched.push(groups);
      let released = false;
      const unread: string[] = [];
      return {
        launch(root): SandboxedCommand {
          if (released) throw new Error("srt: this agent was released");
          const [first, ...rest] = root.argv;
          // `~/.local/bin` and its links are denied, so the harness runs by its real path; `--`
          // keeps srt from reading the harness's flags as its own (Task 0).
          const command = first === agent.harness.command ? agent.harness.executable : first!;
          const wrapped = groups.wrap([...options.command, "-s", profile, "--", command, ...rest]);
          return {
            ...root,
            argv: wrapped.argv,
            env: { ...environment, ...agent.harness.secrets, ...root.env },
            group: true,
            // Killing the group ends srt and everything it started (X1); this forgets it.
            reap: () => groups.kill(wrapped.pidFile),
          };
        },
        async pane(): Promise<PaneTerminal> {
          if (released) throw new Error("srt: this agent was released");
          // The harness by its name, which a person could type: a link in a directory of its own.
          const bin = join(context.directory, "bin", agentId);
          await mkdir(bin, { recursive: true, mode: 0o700 });
          await symlink(agent.harness.executable, join(bin, agent.harness.command)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "EEXIST") throw error;
            },
          );
          const paneProfile = join(profiles, `${agentId}-pane.json`);
          await writeFile(paneProfile, JSON.stringify({ ...settings, allowPty: true }, null, 2), {
            mode: 0o600,
          });
          const secretsFile = await writeSecrets(context, randomUUID(), agent.harness.secrets);
          unread.push(secretsFile);
          return {
            herdr: "run",
            // zsh, as srt's bash drops `PS1`.
            ...panePrelude({
              environment: {
                ...environment,
                PATH: [bin, ...options.path, ...SYSTEM_PATH].join(":"),
              },
              pidFile: await groups.pidFile(),
              secretsFile,
              through: [...options.command, "-s", paneProfile, "--"],
            }),
            harness: agent.harness.command,
          };
        },
        async release() {
          released = true;
          await groups.killAll();
          // A pane whose shell never took its prelude.
          await Promise.all(unread.map((path) => rm(path, { force: true })));
        },
      };
    },
    async close() {
      await Promise.all(launched.map((groups) => groups.killAll()));
      await Promise.all([
        rm(join(context.directory, "pids"), { recursive: true, force: true }),
        rm(profiles, { recursive: true, force: true }),
        rm(temp, { recursive: true, force: true }),
        rm(join(context.directory, "bin"), { recursive: true, force: true }),
        removeSecrets(context),
      ]);
    },
  };
}

/** A host the probe reaches for, from the host and from inside. */
const PROBE_URL = "https://registry.npmjs.org";

/**
 * The first open in a process proves srt confines on this machine: a canary in the run root is
 * unreadable, and a domain not allowed is unreachable, where the host reaches it at all (offline,
 * a refusal proves nothing, and the network half is skipped). Bound by the sandbox's deadline.
 */
async function probe(options: SrtOptions, context: SandboxContext): Promise<void> {
  const canary = join(context.runRoot, `.srt-probe-${randomUUID()}`);
  const token = randomUUID();
  const profile = join(context.directory, `.srt-probe-${randomUUID()}.json`);
  const settings = baseProfile(
    {
      key: "probe",
      cwd: context.directory,
      read: [],
      write: [],
      network: [],
      gitdirs: [],
      environment: {},
    },
    context,
    options,
    join(context.directory, "tmp"),
    [],
  );
  await writeFile(canary, token, { mode: 0o600 });
  await writeFile(profile, JSON.stringify(settings), { mode: 0o600 });
  const reachable =
    (await Bun.spawn(["/usr/bin/curl", "-s", "-m", "5", "-o", "/dev/null", PROBE_URL]).exited) ===
    0;
  try {
    const child = Bun.spawn({
      cmd: [
        ...options.command,
        "-s",
        profile,
        "--",
        "/bin/sh",
        "-c",
        `echo ran; cat ${shellQuote(canary)} 2>/dev/null; ${reachable ? `/usr/bin/curl -s -m 5 -o /dev/null ${PROBE_URL} && echo reached` : "true"}`,
      ],
      cwd: context.directory,
      env: { PATH: SYSTEM_PATH.join(":"), HOME: options.home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      // A timer overflows past 2^31 - 1 ms, and would fire at once.
      Math.min(Math.max(0, context.deadline.unixMilliseconds - Date.now()), 2_147_483_647),
    );
    const [output, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).finally(() => clearTimeout(timer));
    // srt failing to start is no proof of confinement either.
    if (!output.startsWith("ran")) {
      throw new Error(`srt's probe did not run: ${stderr.trim().slice(0, 300)}`);
    }
    if (output.includes(token) || output.includes("reached")) {
      throw new Error(
        "srt does not confine on this machine: its probe read a denied file or domain",
      );
    }
  } finally {
    await Promise.all([rm(canary, { force: true }), rm(profile, { force: true })]);
  }
}

/**
 * srt as installed on this machine: 1.0.0 or later on `PATH`. `undefined` when absent. The
 * toolchain is what `PATH`'s executables under `~` need: their `bin` directories, and each one's
 * install tree (X19): a node package's root, a `bin/` beside a `lib/` (a node or a Python venv),
 * or the executable alone. Never a whole parent of `bin`: `~/.local` holds `state/` and
 * credentials, and `~/.orbstack` an SSH key.
 */
export async function findSrt(
  environment: Readonly<Record<string, string | undefined>>,
  harnessState: readonly string[],
): Promise<SrtOptions | undefined> {
  const home = await realpath(environment.HOME ?? homedir());
  const state = await Promise.all(harnessState.map((root) => realpath(root).catch(() => root)));
  const path = (environment.PATH ?? "").split(":").filter(Boolean);
  const cli = await firstExecutable("srt", path);
  const node = await firstExecutable("node", path);
  if (!cli || !node) return undefined;
  const version = Bun.spawnSync({ cmd: [node, cli, "--version"], stdout: "pipe", stderr: "pipe" });
  const [major] = version.stdout.toString().trim().split(".").map(Number);
  if (version.exitCode !== 0 || major === undefined || !(major >= 1)) return undefined;
  const real = [
    ...new Set(
      (await Promise.all(path.map((entry) => realpath(entry).catch(() => undefined)))).filter(
        (entry): entry is string => entry !== undefined,
      ),
    ),
  ];
  const overlapsState = (root: string) =>
    state.some((entry) => contains(root, entry) || contains(entry, root));
  const bins = real.filter(
    (entry) => contains(home, entry) && entry !== home && !overlapsState(entry),
  );
  const trees = new Set<string>();
  for (const bin of bins) {
    for (const name of await readdir(bin).catch(() => [])) {
      const target = await realpath(join(bin, name)).catch(() => undefined);
      // Outside `~` it is readable anyway; inside a repository it is that repository's source,
      // a link on `PATH` to a script under development, not an install.
      if (
        !target ||
        !contains(home, target) ||
        (await repositoryOf(target, home).catch(() => true))
      )
        continue;
      const tree = await installTree(target);
      if (tree !== home && !contains(tree, home) && !overlapsState(tree)) trees.add(tree);
    }
  }
  // The rest of `PATH` that a sandbox can read: outside `~` and the temp directories.
  const outside = real.filter((entry) => !DENIED.some((root) => contains(root, entry)));
  return {
    command: [node, cli],
    home,
    harnessState: state,
    toolchain: outermost([...bins, ...trees]),
    path: [...bins, ...outside].filter((entry) => !SYSTEM_PATH.includes(entry)),
  };
}

/** Each path once, and none inside another. */
function outermost(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((path) => !unique.some((other) => other !== path && contains(other, path)));
}

/** What an executable needs to run besides itself, by where it lies. */
async function installTree(executable: string): Promise<string> {
  const parts = executable.split("/");
  const modules = parts.lastIndexOf("node_modules");
  if (modules >= 0 && modules + 1 < parts.length) {
    const scoped = parts[modules + 1]!.startsWith("@");
    return parts.slice(0, modules + (scoped ? 3 : 2)).join("/");
  }
  const parent = dirname(executable);
  if (
    basename(parent) === "bin" &&
    (await stat(join(dirname(parent), "lib")).catch(() => undefined))
  ) {
    return dirname(parent);
  }
  return executable;
}

async function firstExecutable(name: string, path: readonly string[]): Promise<string | undefined> {
  for (const directory of path) {
    const candidate = join(directory, name);
    const found = await stat(candidate).catch(() => undefined);
    if (found?.isFile() && (found.mode & 0o111) !== 0) return realpath(candidate);
  }
  return undefined;
}
