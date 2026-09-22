import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

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
): Promise<string> {
  const command = await resolveAgentCommand();
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o700);
  const path = join(directory, "wf");
  const script = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(command)} --at ${shellQuote(endpoint)} "$@"\n`;
  await writeFile(path, script, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
