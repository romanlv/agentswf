import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { type AgentDoor, shellQuote } from "@wf/sandbox";

/** bun loads the `.env` of the directory it starts in: an agent's, which is none of `wf`'s. */
const NO_ENV = "--no-env-file";

/**
 * The agent is given a path to run, and nothing else. Every other channel we could deliver a
 * return address on has turned out to be a harness's private business: a Codex pane executes its
 * tool commands in a different process from the one Herdr launched, so neither the environment nor
 * the `PATH` of that pane reaches them. A prompt does reach them, because carrying prompts is the
 * one thing every harness must do.
 *
 * The launcher holds the socket, so nothing secret has to survive that trip, and the connection
 * is what identifies the agent — no id it types can claim to be somebody else. It is not
 * isolation: every agent runs as the same user as the engine, so one that goes looking for a
 * sibling's socket can still find it. Separating those needs a uid per agent.
 */
export async function installAgentLauncher(
  directory: string,
  endpoint: string,
  /**
   * The variable naming the native session, passed on with every call. The harness sets it in the
   * shell that runs the agent's tool call, which the pane's own environment never reaches.
   */
  sessionEnv?: string,
): Promise<string> {
  const command = await resolveAgentCommand();
  return writeLauncher(directory, [process.execPath, NO_ENV, command], endpoint, sessionEnv);
}

/**
 * A sandboxed agent's door: the same launcher, running the bundled `wf` with the host's bun by
 * its real path, since a sandbox reads neither the workspace's sources nor bun's links under `~`.
 * A box copies `boxScript` to the launcher's path, which runs the bundle with the box's own bun.
 */
export async function installSandboxedDoor(
  directory: string,
  endpoint: string,
  /** The bundled `wf`'s source, written beside the launcher. */
  source: string,
  sessionEnv?: string,
): Promise<AgentDoor> {
  const bun = await realpath(process.execPath);
  await mkdir(directory, { recursive: true });
  // Real paths, as a sandbox's rules match them: `/tmp` is `/private/tmp` on macOS.
  const real = await realpath(directory);
  const socket = join(real, basename(endpoint));
  // In the agent's own directory: bun will not load a module from the control plane's, which is
  // not listable so that no agent can find another's socket.
  const bundle = join(real, "wf.js");
  await writeFile(bundle, source, { mode: 0o500 });
  const launcher = await writeLauncher(real, [bun, NO_ENV, bundle], socket, sessionEnv);
  return {
    endpoint: socket,
    launcher,
    boxScript: launcherScript(["bun", NO_ENV, bundle], socket, sessionEnv),
    bundle,
    reads: [bun, bundle],
  };
}

/**
 * `wf` as one file's source, which a sandbox can read where it cannot read this workspace. Built by
 * a `bun build` of its own: in process, the bundler resolved packages against the test runner's
 * state and missed the workspace's links.
 */
export async function buildAgentBundle(): Promise<string> {
  const entry = await resolveAgentCommand();
  const built = Bun.spawn({
    cmd: [process.execPath, "build", entry, "--target=bun"],
    cwd: dirname(entry),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, bundle, stderr] = await Promise.all([
    built.exited,
    new Response(built.stdout).text(),
    new Response(built.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`could not bundle wf: ${stderr.trim().slice(0, 400)}`);
  return bundle;
}

async function writeLauncher(
  directory: string,
  command: readonly string[],
  endpoint: string,
  sessionEnv: string | undefined,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o700);
  const path = join(directory, "wf");
  await writeFile(path, launcherScript(command, endpoint, sessionEnv), { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

function launcherScript(
  command: readonly string[],
  endpoint: string,
  sessionEnv: string | undefined,
): string {
  if (sessionEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sessionEnv)) {
    throw new Error(`not an environment variable name: ${sessionEnv}`);
  }
  const session = sessionEnv ? ` --session "\${${sessionEnv}:-}"` : "";
  return `#!/bin/sh\nexec ${command.map(shellQuote).join(" ")} --at ${shellQuote(endpoint)}${session} "$@"\n`;
}

async function resolveAgentCommand(): Promise<string> {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@wf/cli-agent/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const relative = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.wf;
  if (!relative) throw new Error("@wf/cli-agent does not publish the wf command");
  return resolve(dirname(manifestPath), relative);
}
