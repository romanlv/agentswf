import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { DockerEnvironment } from "@agentswf/contract/workflow";
import { protectedPaths } from "../git";
import { KILL_GROUPS, RECORD_LEADER } from "../groups";
import { onceUnlessFailed } from "../once";
import { panePrelude } from "../pane";
import { contains } from "../resolve";
import type {
  AgentContext,
  Occupant,
  OpenedSandbox,
  PaneHerdr,
  PaneTerminal,
  ResolvedSandbox,
  SandboxContext,
  SandboxedCommand,
  SandboxProvider,
} from "../seam";
import { secretsText } from "../secrets";
import { execArgs, mountArgs } from "./args";

/** The files the default image is built from, and the proxy and relay the provider runs. */
const IMAGE_DIRECTORY = join(import.meta.dir, "..", "..", "docker");

/** How long one docker command of the provider's own may take, beside an agent's. */
const COMMAND_MS = 60_000;
/** How long a daemon may take to answer before the provider says it did not. */
const DAEMON_MS = 5_000;
/** How long killing a box's recorded groups, or removing their files, may take. */
const CLEANUP_MS = 4_000;
/** How long a box outlives its run's deadline, should the engine die before closing it. */
const EXPIRY_GRACE_SECONDS = 600;

/**
 * Moves each path among its arguments after the first into that directory, printing each one it
 * moved: a link as a link, a directory whole. One gone, before or while it is moved, is skipped.
 */
const QUARANTINE = `q=$1; shift; n=0; failed=0; for p in "$@"; do [ -e "$p" ] || [ -L "$p" ] || continue; n=$((n+1)); if mv -- "$p" "$q/$$-$n-$(basename "$p")"; then printf '%s\\n' "$p"; elif [ -e "$p" ] || [ -L "$p" ]; then failed=1; fi; done; exit $failed`;

/** Where the box's recorded groups are: one directory for each agent, and one for its Herdr. */
const BOX_PIDS = "/tmp/awf-pids";
/**
 * The box's own Herdr keeps its socket and state inside the box, off every host mount, `homes/`
 * included: nothing of it need outlive the box, and its panes' sessions land in their homes.
 */
const HERDR_HOME = "/tmp/awf-herdr";
/** The proxy variables every process in a box has, and a pane's `env -i` sets again. */
const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
/** How long the box's Herdr may take to answer after it starts. */
const HERDR_START_MS = 20_000;

export type DockerResult = { stdout: string; stderr: string; exitCode: number };

/** How the provider reaches docker; a test replaces it to see the arguments. */
export type DockerClient = {
  run(
    args: readonly string[],
    options?: { stdin?: string; timeoutMs?: number },
  ): Promise<DockerResult>;
  /** A long-lived `docker` process, for a door's relay. */
  spawn(args: readonly string[]): {
    stdin: { write(line: string): void; end(): void };
    lines: AsyncIterable<string>;
    stderr: AsyncIterable<string>;
    kill(): void;
  };
  /**
   * The `docker` command and the environment the client needs, never an agent's. On the client
   * because an agent's launch is a `docker exec` that `runProcess` runs, not this client.
   */
  command: string;
  environment: Readonly<Record<string, string>>;
};

export type DockerOptions = {
  client: DockerClient;
  /** Built from `packages/sandbox/docker`: the image a spec that names none runs, and the proxy. */
  defaultImage: string;
  /** The operator's uid and gid, which every process in a box runs as. */
  user: string;
};

/**
 * A container per sandbox, its agents processes in it, on an `--internal` network whose one way
 * out is a CONNECT proxy holding the allowlist. Paths are mounted where they are on the host. The
 * daemon is first asked at the first open, so a run with no box never waits on one.
 */
export function createDockerProvider(options: DockerOptions): SandboxProvider<DockerEnvironment> {
  const daemon = onceUnlessFailed(async () => {
    const result = await options.client.run(["version", "--format", "{{.Server.Version}}"], {
      timeoutMs: DAEMON_MS,
    });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      throw new Error(`docker did not answer within ${DAEMON_MS / 1000}s: ${result.stderr.trim()}`);
    }
  });
  return {
    environment(raw) {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("docker settings are an object: docker: { image? }");
      }
      const { image, ...rest } = raw as Record<string, unknown>;
      if (Object.keys(rest).length > 0) {
        throw new Error(`docker takes only an image, not ${Object.keys(rest).join(", ")}`);
      }
      if (image !== undefined && (typeof image !== "string" || image.trim() === "")) {
        throw new Error("docker's image names an image");
      }
      return image === undefined ? {} : { image };
    },
    async open(spec, context) {
      await daemon();
      return openBox(spec, context, options);
    },
  };
}

async function openBox(
  spec: ResolvedSandbox<DockerEnvironment>,
  context: SandboxContext,
  options: DockerOptions,
): Promise<OpenedSandbox> {
  const { client } = options;
  const docker = async (args: readonly string[]) => {
    const result = await client.run(args, { timeoutMs: COMMAND_MS });
    if (result.exitCode !== 0) {
      throw new Error(`docker ${args[0]} failed: ${result.stderr.trim().slice(0, 400)}`);
    }
    return result.stdout.trim();
  };
  const socket = daemonSocket(client.environment);
  for (const path of [spec.cwd, ...spec.read, ...spec.write]) {
    // A box that can reach the daemon can start a container with the host mounted.
    if (socket && contains(path, socket)) throw new Error(`docker: ${path} holds docker's socket`);
  }
  const image = spec.environment.image ?? options.defaultImage;
  for (const needed of new Set([options.defaultImage, image])) {
    if (!(await imageExists(client, needed))) {
      throw new Error(
        needed === options.defaultImage
          ? `docker: the sandbox image ${needed} is not built, and every box's proxy runs on it; build it with: ${imageBuildCommand(needed).join(" ")}`
          : `docker: the image ${needed} is not here; pull it first: docker pull ${needed}`,
      );
    }
  }
  await sweepExpired(client);
  const id = `awf-${randomUUID().slice(0, 12)}`;
  const names = { box: id, proxy: `${id}-proxy`, network: `${id}-net` };
  const expires = Math.ceil(context.deadline.unixMilliseconds / 1000) + EXPIRY_GRACE_SECONDS;
  const labels = ["--label", `awf.sandbox=${id}`, "--label", `awf.expires=${expires}`];
  // Both end on their own past the run's deadline, should the engine die before closing them.
  const lifetime = String(Math.max(1, expires - Math.floor(Date.now() / 1000)));
  const hardened = ["--cap-drop", "ALL", "--security-opt", "no-new-privileges"];
  const allow = join(context.directory, "proxy", "allow");
  let domains = new Set(spec.network);
  await mkdir(dirname(allow), { recursive: true, mode: 0o755 });
  await writeAllowlist(allow, domains);
  const guarded = await protectedPaths(spec);
  // A protected path that exists is mounted read-only over itself, unless it or a directory it
  // is in is a link: a mount would follow it, and expose what it names. Such a link is kept as
  // it is, and moved out if it changes. A mount holds only its own path, and a directory above it
  // can be renamed and made again: a path whose directories are not those it had at open is
  // moved out, as is one that did not exist and appears. The operator's own edit on the host,
  // which replaces a file but not its directories, is left alone.
  const roots = [...spec.write, ...spec.gitdirs.map((gitdir) => gitdir.path)];
  const links = new Map<string, string>();
  const unlinked = new Map<string, { exists: boolean; directories: string }>();
  for (const path of guarded) {
    const link = await linkAt(path, roots);
    if (link) {
      links.set(link, await readlink(link));
      continue;
    }
    const exists = Boolean(await lstat(path).catch(() => undefined));
    unlinked.set(path, { exists, directories: await directoriesOf(path, roots) });
  }
  const existing = [...unlinked].flatMap(([path, { exists }]) => (exists ? [path] : []));
  const quarantine = join(context.directory, "quarantine");
  await mkdir(quarantine, { recursive: true, mode: 0o700 });
  const record: { image?: string; quarantined?: string[] } = {};
  // What to move is found here; the move is made in the box, where a link an agent made can
  // reach nothing its mounts do not, so a race cannot turn it on the operator's files.
  const offending = async (): Promise<string[]> => {
    const found = new Set<string>();
    for (const [link, target] of links) {
      // A higher link made since is moved instead; otherwise one no longer the same link is moved
      // whole, whatever took its place.
      const above = await linkAt(link, roots);
      if (above && above !== link) {
        found.add(above);
        continue;
      }
      if ((await readlink(link).catch(() => undefined)) !== target) {
        if (await lstat(link).catch(() => undefined)) found.add(link);
      }
    }
    for (const [path, was] of unlinked) {
      const link = await linkAt(path, roots);
      if (link) {
        if (!links.has(link)) found.add(link);
        continue;
      }
      if (!(await lstat(path).catch(() => undefined))) continue;
      if (!was.exists || (await directoriesOf(path, roots)) !== was.directories) found.add(path);
    }
    return [...found];
  };
  // One at a time: co-tenants' reaps would otherwise both move the same path, one failing.
  let guarding: Promise<void> = Promise.resolve();
  /**
   * At `last`, everything of the box's uid is stopped first, so nothing writes after the look:
   * stopped, not killed, as the box ends with its `sleep`, and the move with it.
   */
  const guard = (last = false) => {
    const next = guarding.then(async () => {
      const paths = await offending();
      if (paths.length === 0) return;
      const moved = await client.run(
        [
          "exec",
          names.box,
          "sh",
          "-c",
          `${last ? "kill -STOP -1 2>/dev/null; " : ""}${QUARANTINE}`,
          "sh",
          quarantine,
          ...paths,
        ],
        { timeoutMs: COMMAND_MS },
      );
      const done = moved.stdout.split("\n").filter((line) => paths.includes(line));
      if (done.length > 0) record.quarantined = [...(record.quarantined ?? []), ...done];
      if (moved.exitCode !== 0) {
        const left = paths.filter((path) => !done.includes(path));
        throw new Error(
          `docker: ${left.join(", ")}, which a box may not make, not moved out: ${moved.stderr.trim()}`,
        );
      }
    });
    guarding = next.catch(() => undefined);
    return next;
  };
  // Each undo is registered before its step, as a step that fails or times out may have made it;
  // removing what does not exist is harmless. They run last first, one at a time.
  const undo: (() => Promise<unknown>)[] = [];
  const proxy = `http://${names.proxy}:3128`;
  const undoAll = async () => {
    for (const step of undo.splice(0).reverse()) await step().catch(() => undefined);
  };
  try {
    undo.push(() => client.run(["network", "rm", names.network], { timeoutMs: COMMAND_MS }));
    await docker(["network", "create", "--internal", ...labels, names.network]);
    undo.push(() => client.run(["rm", "-f", names.proxy], { timeoutMs: COMMAND_MS }));
    // On the internal network first, where it listens, then the bridge it reaches out through.
    // Its allowlist is in a mounted directory: a single-file mount goes stale when replaced (X8).
    await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      names.proxy,
      ...labels,
      ...hardened,
      "--user",
      options.user,
      "--network",
      names.network,
      "--mount",
      `type=bind,source=${dirname(allow)},target=/proxy,readonly`,
      options.defaultImage,
      "timeout",
      lifetime,
      "node",
      "-e",
      await readFile(join(IMAGE_DIRECTORY, "proxy.js"), "utf8"),
      "/proxy/allow",
      "3128",
    ]);
    await docker(["network", "connect", "bridge", names.proxy]);
    undo.push(() => client.run(["rm", "-f", names.box], { timeoutMs: COMMAND_MS }));
    await docker([
      "run",
      "-d",
      // Gone once it stops, `sleep` expired or killed, with any secret a pane never read.
      "--rm",
      "--init",
      "--name",
      names.box,
      ...labels,
      ...hardened,
      "--user",
      options.user,
      "--network",
      names.network,
      ...PROXY_VARIABLES.flatMap((name) => ["-e", `${name}=${proxy}`]),
      ...mountArgs(spec, context.directory, existing, context.runRoot),
      image,
      "sleep",
      lifetime,
    ]);
    // node and git need the operator's uid to have a name, which the image does not know.
    const [uid = "", gid = ""] = options.user.split(":");
    await docker([
      "exec",
      "-u",
      "0",
      names.box,
      "sh",
      "-c",
      `getent passwd ${uid} >/dev/null || echo 'awf:x:${uid}:${gid}::/tmp:/bin/sh' >> /etc/passwd; getent group ${gid} >/dev/null || echo 'awf:x:${gid}:' >> /etc/group`,
    ]);
  } catch (error) {
    await undoAll();
    throw error;
  }
  const digest = (
    await client.run(["inspect", "--format", "{{.Image}}", names.box], { timeoutMs: COMMAND_MS })
  ).stdout.trim();
  const occupants: Occupant[] = [];
  const box = boxHerdr(names.box, client);
  const panes: BoxPanes = {
    herdr: box.herdr,
    start: box.start,
    proxy: Object.fromEntries(PROXY_VARIABLES.map((name) => [name, proxy])),
  };
  return {
    record: Object.assign(record, { image: digest || image }),
    panes: true,
    async admit(agent) {
      const occupant = await admitAgent(names.box, agent, options, guard, panes);
      try {
        // Kept only once written: an agent refused leaves nothing in the list.
        const next = new Set([...domains, ...agent.harness.domains]);
        await writeAllowlist(allow, next);
        domains = next;
      } catch (error) {
        await occupant.release();
        throw error;
      }
      occupants.push(occupant);
      return occupant;
    },
    async close() {
      await Promise.allSettled(occupants.map((occupant) => occupant.release()));
      // Evidence of what the box asked for and was refused, kept before the proxy goes.
      const log = await client.run(["logs", names.proxy], { timeoutMs: COMMAND_MS });
      await writeFile(join(context.directory, "proxy.log"), log.stdout).catch(() => undefined);
      // In the box, before it goes.
      const guarded = await guard(true).catch((error: unknown) => error);
      await undoAll();
      if (guarded) throw guarded;
    },
  };
}

/** What an occupant needs to open a pane in its box. */
type BoxPanes = {
  herdr: PaneHerdr;
  /** Starts the box's Herdr, once, at the first pane; the box's `PATH`, which a pane sets again. */
  start(): Promise<string>;
  /** The proxy variables every process in the box has, which a pane's `env -i` must set again. */
  proxy: Readonly<Record<string, string>>;
};

/**
 * The box's own Herdr (H2): the host's cannot see an agent behind `docker exec` (H1). Each command
 * is a `docker exec` whose pid is recorded, so a cancelled `agent prompt --wait` is ended in the
 * box too, as killing the client alone would not (X7).
 */
function boxHerdr(
  box: string,
  client: DockerClient,
): { herdr: PaneHerdr; start(): Promise<string> } {
  const pids = `${BOX_PIDS}/herdr`;
  // By name, not the client's path: the operator copies it, or a tab of theirs types it.
  const watch = ["docker", "exec", "-it", "-e", `HOME=${HERDR_HOME}`, box, "herdr"];
  const herdr: PaneHerdr = {
    key: box,
    watch,
    run(args, timeoutMs): SandboxedCommand {
      const pidFile = `${pids}/${randomUUID()}`;
      return {
        argv: [
          client.command,
          ...execArgs({
            box,
            cwd: undefined,
            env: { HOME: HERDR_HOME },
            secrets: [],
            pidFile,
            argv: ["herdr", ...args],
          }),
        ],
        env: { ...client.environment },
        timeoutMs,
        group: true,
        async reap() {
          await killIn(client, box, [pidFile]);
        },
      };
    },
  };
  const start = onceUnlessFailed(async () => {
    const found = await client.run(
      ["exec", box, "sh", "-c", "command -v herdr && command -v zsh"],
      {
        timeoutMs: COMMAND_MS,
      },
    );
    if (found.exitCode !== 0) throw new Error("docker: the image lacks herdr or zsh for panes");
    const home = ["exec", "-e", `HOME=${HERDR_HOME}`, box];
    // Its first-run screen would take the first pane's keys.
    const seeded = await client.run(
      [
        ...home,
        "sh",
        "-c",
        'mkdir -p "$HOME/.config/herdr" && echo "onboarding = false" > "$HOME/.config/herdr/config.toml"',
      ],
      { timeoutMs: COMMAND_MS },
    );
    if (seeded.exitCode !== 0) throw new Error(`docker: seeding Herdr failed: ${seeded.stderr}`);
    // `-d`: the server outlives this command, and ends with the box.
    await client.run(["exec", "-d", "-e", `HOME=${HERDR_HOME}`, box, "herdr", "server"], {
      timeoutMs: COMMAND_MS,
    });
    const by = Date.now() + HERDR_START_MS;
    for (;;) {
      const listed = await client.run([...home, "herdr", "workspace", "list"], {
        timeoutMs: COMMAND_MS,
      });
      if (listed.exitCode === 0) {
        const path = await client.run(["exec", box, "printenv", "PATH"], {
          timeoutMs: COMMAND_MS,
        });
        return path.stdout.trim() || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
      }
      if (Date.now() > by) {
        throw new Error(`docker: the box's Herdr did not start: ${listed.stderr.trim()}`);
      }
      await Bun.sleep(250);
    }
  });
  // One that failed is tried again at the next pane; a server that dies later is not started
  // again: the box's panes fail, and the run with them.
  return { herdr, start };
}

async function admitAgent(
  box: string,
  agent: AgentContext,
  options: DockerOptions,
  guard: () => Promise<void>,
  panes: BoxPanes,
): Promise<Occupant> {
  const { client } = options;
  const asRoot = async (args: readonly string[], stdin?: string) => {
    const result = await client.run(["exec", "-i", "-u", "0", box, ...args], {
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: COMMAND_MS,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `docker: making the door failed in the box: ${result.stderr.trim().slice(0, 300)}`,
      );
    }
  };
  for (const needed of [agent.harness.command, "bun", "node"]) {
    const found = await client.run(["exec", box, "sh", "-c", 'command -v "$0"', needed], {
      timeoutMs: COMMAND_MS,
    });
    if (found.exitCode !== 0) throw new Error(`docker: the image lacks ${needed}`);
  }
  // A box has no `/private`, and the agent must not write its door: root makes both.
  const doorDirectory = dirname(agent.door.launcher);
  await asRoot(["sh", "-c", 'mkdir -p "$0" && chmod 755 "$0"', doorDirectory]);
  await asRoot(
    ["sh", "-c", 'cat > "$0" && chmod 644 "$0"', agent.door.bundle],
    await readFile(agent.door.bundle, "utf8"),
  );
  await asRoot(
    ["sh", "-c", 'cat > "$0" && chmod 755 "$0"', agent.door.launcher],
    agent.door.boxScript,
  );
  const agentId = randomUUID();
  const relay = await startRelay(client, box, agent.door.endpoint, `/run/awf-relay/${agentId}`);
  const pids = `${BOX_PIDS}/${agentId}`;
  const env: Record<string, string> = { HOME: agent.home, ...agent.harness.env };
  const clientEnvironment = { ...client.environment, ...agent.harness.secrets };
  let released: Promise<void> | undefined;
  const unread: string[] = [];
  return {
    async pane(): Promise<PaneTerminal> {
      if (released) throw new Error("docker: this agent was released");
      const path = await panes.start();
      // Written by the agent's own uid through stdin, so the token is in no argv: the box drops
      // every capability, `chown` included. Its co-tenants share that uid (the trust boundary).
      const secretsFile = `/tmp/awf-secrets/${randomUUID()}`;
      const written = await client.run(
        [
          "exec",
          "-i",
          box,
          "sh",
          "-c",
          'umask 077 && mkdir -p "$(dirname "$0")" && cat > "$0"',
          secretsFile,
        ],
        { stdin: secretsText(agent.harness.secrets), timeoutMs: COMMAND_MS },
      );
      if (written.exitCode !== 0) {
        throw new Error(`docker: writing the pane's secret failed: ${written.stderr.trim()}`);
      }
      unread.push(secretsFile);
      return {
        herdr: panes.herdr,
        ...panePrelude({
          environment: { ...panes.proxy, PATH: path, SHELL: "/bin/bash", ...env },
          pidFile: `${pids}/${randomUUID()}`,
          secretsFile,
          through: [],
        }),
        harness: agent.harness.command,
      };
    },
    launch(root): SandboxedCommand {
      if (released) throw new Error("docker: this agent was released");
      const pidFile = `${pids}/${randomUUID()}`;
      return {
        ...root,
        argv: [
          client.command,
          ...execArgs({
            box,
            cwd: root.cwd,
            env: { ...env, ...root.env },
            secrets: Object.keys(agent.harness.secrets),
            pidFile,
            argv: root.argv,
          }),
        ],
        env: clientEnvironment,
        group: true,
        // Killing the `docker exec` client leaves its processes running in the box (X7).
        async reap() {
          await killIn(client, box, [pidFile]);
          await guard();
        },
      };
    },
    release() {
      released ??= (async () => {
        await relay.stop();
        await killIn(client, box, [pids]);
        if (unread.length > 0) {
          await client.run(["exec", box, "rm", "-f", ...unread], { timeoutMs: CLEANUP_MS });
        }
        await guard();
      })();
      return released;
    },
  };
}

/**
 * The door in a box: a listener at the endpoint's path inside, run by root over `docker exec -i`,
 * whose connections this side carries to the engine's socket (X6: a host socket does not connect
 * from a container). Its pid is recorded where only root writes, so stopping it ends it inside
 * too, as killing the client alone would not (X7).
 */
async function startRelay(
  client: DockerClient,
  box: string,
  endpoint: string,
  pidFile: string,
): Promise<{ stop(): Promise<void> }> {
  const relay = client.spawn([
    "exec",
    "-i",
    "-u",
    "0",
    box,
    "sh",
    "-c",
    RECORD_LEADER,
    pidFile,
    "node",
    "-e",
    await readFile(join(IMAGE_DIRECTORY, "relay.js"), "utf8"),
    endpoint,
  ]);
  const ready = (async () => {
    for await (const line of relay.stderr) if (line.trim() === "ready") return;
    throw new Error("docker: the door's relay ended before it listened");
  })();
  void (async () => {
    for await (const line of relay.lines) {
      let request: { id: number; b64: string };
      try {
        request = JSON.parse(line);
      } catch {
        continue;
      }
      const reply: Buffer[] = [];
      const socket = createConnection(endpoint, () =>
        socket.end(Buffer.from(request.b64, "base64")),
      );
      socket.on("data", (chunk: Buffer) => reply.push(chunk));
      const answer = () =>
        relay.stdin.write(
          `${JSON.stringify({ id: request.id, b64: Buffer.concat(reply).toString("base64") })}\n`,
        );
      socket.on("end", answer);
      socket.on("error", answer);
    }
  })().catch(() => undefined);
  const stop = async () => {
    relay.stdin.end();
    relay.kill();
    await killIn(client, box, [pidFile], "0");
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("docker: the door's relay did not start")),
          20_000,
        );
      }),
    ]);
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { stop };
}

/** Written beside and renamed over, so the proxy never reads half a list. */
async function writeAllowlist(path: string, domains: Iterable<string>): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, [...domains].map((domain) => `${domain}\n`).join(""), {
    mode: 0o644,
  });
  await rename(temporary, path);
}

async function imageExists(client: DockerClient, image: string): Promise<boolean> {
  const result = await client.run(["image", "inspect", "--format", "{{.Id}}", image], {
    timeoutMs: COMMAND_MS,
  });
  return result.exitCode === 0;
}

/**
 * Removes what a run that died before closing left, once past its deadline and grace: only what
 * carries both of a box's labels.
 */
async function sweepExpired(client: DockerClient): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  // A container's name is `.Names`, a network's `.Name`.
  const expired = async (list: readonly string[], name: string) => {
    const listed = await client.run(
      [
        ...list,
        "--filter",
        "label=awf.sandbox",
        "--filter",
        "label=awf.expires",
        "--format",
        `{{${name}}} {{.Label "awf.expires"}}`,
      ],
      { timeoutMs: COMMAND_MS },
    );
    return listed.stdout
      .split("\n")
      .map((line) => line.trim().replace(/^\//, "").split(" "))
      .filter(([name, at]) => name && Number(at) < now)
      .map(([name]) => name!);
  };
  const containers = await expired(["ps", "-a"], ".Names");
  if (containers.length > 0) {
    await client.run(["rm", "-f", ...containers], { timeoutMs: COMMAND_MS });
  }
  const networks = await expired(["network", "ls"], ".Name");
  if (networks.length > 0) {
    await client.run(["network", "rm", ...networks], { timeoutMs: COMMAND_MS });
  }
}

/** The daemon's socket on this host, which no box may mount. */
function daemonSocket(environment: Readonly<Record<string, string>>): string | undefined {
  const host = environment.DOCKER_HOST;
  if (host?.startsWith("unix://")) return host.slice("unix://".length);
  return host === undefined ? "/var/run/docker.sock" : undefined;
}

/**
 * The default image's tag: a hash of its Dockerfile, whose every input is pinned there, so a
 * change to it is a new image rather than a stale one run under the old name.
 */
export async function defaultImage(): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(join(IMAGE_DIRECTORY, "Dockerfile")));
  return `awf-agent:${hash.digest("hex").slice(0, 12)}`;
}

/** The command that builds the default image. */
export function imageBuildCommand(tag: string): string[] {
  return ["docker", "build", "-t", tag, IMAGE_DIRECTORY];
}

/**
 * docker on this machine: its CLI on `PATH`. The daemon is not asked here, so a run that opens no
 * box never waits on one that hangs; the provider asks it at its first open.
 */
export async function findDocker(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<DockerOptions | undefined> {
  const command = Bun.which("docker", { PATH: environment.PATH ?? "" });
  if (!command) return undefined;
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  return {
    client: dockerClient(command, environment),
    defaultImage: await defaultImage(),
    user: `${uid}:${gid}`,
  };
}

/** The real client: `docker`, with only what it needs of the engine's environment. */
function dockerClient(
  command: string,
  environment: Readonly<Record<string, string | undefined>>,
): DockerClient {
  const own = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (entry[0] === "PATH" || entry[0] === "HOME" || entry[0].startsWith("DOCKER_")),
    ),
  );
  return {
    command,
    environment: own,
    async run(args, options = {}) {
      // Its own group, killed whole: a hung daemon leaves the client's helpers holding its pipes.
      const child = Bun.spawn({
        cmd: [command, ...args],
        env: own,
        detached: true,
        stdin: options.stdin === undefined ? "ignore" : new TextEncoder().encode(options.stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<"expired">((resolve) => {
        timer = setTimeout(() => resolve("expired"), options.timeoutMs ?? COMMAND_MS);
      });
      const exited = await Promise.race([child.exited, expired]);
      clearTimeout(timer);
      if (exited === "expired") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
        return { stdout: "", stderr: `docker ${args[0]} did not answer in time`, exitCode: 124 };
      }
      const [stdout, stderr] = await output;
      return { stdout, stderr, exitCode: exited };
    },
    spawn(args) {
      const child = Bun.spawn({
        cmd: [command, ...args],
        env: own,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const linesOf = (stream: ReadableStream<Uint8Array>) =>
        createInterface({ input: Readable.fromWeb(stream as never) });
      return {
        stdin: {
          write: (line) => {
            child.stdin.write(line);
            child.stdin.flush();
          },
          end: () => void child.stdin.end(),
        },
        lines: linesOf(child.stdout),
        stderr: linesOf(child.stderr),
        kill: () => child.kill("SIGKILL"),
      };
    },
  };
}

/** Kills the groups `files` name inside the box: pid files, or directories of them. */
function killIn(client: DockerClient, box: string, files: readonly string[], user?: string) {
  return client.run(
    ["exec", ...(user ? ["-u", user] : []), box, "sh", "-c", KILL_GROUPS, "sh", ...files],
    { timeoutMs: CLEANUP_MS },
  );
}

/**
 * The highest link among `path` and the directories it is in below the deepest of `roots` holding
 * it: where a host process following `path` would leave the reach. Undefined when there is none,
 * or no root holds it.
 */
async function linkAt(path: string, roots: readonly string[]): Promise<string | undefined> {
  const root = roots.filter((root) => contains(root, path)).sort((a, b) => b.length - a.length)[0];
  if (root === undefined) return undefined;
  let highest: string | undefined;
  for (let at = path; at !== root && contains(root, at); at = dirname(at)) {
    if ((await lstat(at).catch(() => undefined))?.isSymbolicLink()) highest = at;
  }
  return highest;
}

/** Which directories `path` is in below the deepest of `roots` holding it, by their identity. */
async function directoriesOf(path: string, roots: readonly string[]): Promise<string> {
  const root = roots.filter((root) => contains(root, path)).sort((a, b) => b.length - a.length)[0];
  const identities: string[] = [];
  for (
    let at = dirname(path);
    root !== undefined && at !== root && contains(root, at);
    at = dirname(at)
  ) {
    const found = await lstat(at).catch(() => undefined);
    identities.push(found ? `${found.dev}:${found.ino}` : "-");
  }
  return identities.join("/");
}
