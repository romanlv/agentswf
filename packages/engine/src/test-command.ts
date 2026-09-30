import { existsSync } from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDuration } from "./duration";

const PRELOAD = fileURLToPath(new URL("./workflow-test-preload.ts", import.meta.url));

export const testUsage = [
  "usage: awf test [paths...] [-t <pattern>] [--watch] [--timeout <duration>]",
  "",
  "Runs a workflow's tests (*.test.ts and *.spec.ts files) under the current directory, or under",
  "each file or directory given, with agentswf/workflow, agentswf/testing and typebox served as",
  "awf run serves them: nothing is installed. -t runs the tests whose names match the pattern;",
  "--watch reruns them on a change; --timeout bounds each test, 5s by default.",
  "",
  "Exits 0 when every test passed, 1 when one failed or none was found, 2 on a usage error. What",
  "it prints is for reading, not parsing.",
].join("\n");

export type TestCommand = { paths: string[]; bunArgs: string[] };

/**
 * Only these flags pass through, so the published command is awf's, not the whole of `bun test`'s,
 * and a later runner can take its place. A path must exist; Bun would take it as a filter.
 */
export function parseTestCommand(argv: readonly string[], cwd: string): TestCommand | "help" {
  const paths: string[] = [];
  const bunArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    const value = argv[index + 1];
    if (option === "-h" || option === "--help") return "help";
    if (option === "--watch") {
      bunArgs.push("--watch");
    } else if (option === "-t") {
      if (value === undefined) throw new Error("-t needs a pattern");
      bunArgs.push("-t", value);
      index += 1;
    } else if (option === "--timeout") {
      if (value === undefined) throw new Error("--timeout needs a duration such as 10s");
      bunArgs.push("--timeout", String(parseDuration(value)));
      index += 1;
    } else if (option.startsWith("-")) {
      throw new Error(`unknown option: ${option}`);
    } else {
      const path = resolve(cwd, option);
      if (!existsSync(path)) throw new Error(`no such file or directory: ${option}`);
      paths.push(path);
    }
  }
  return { paths, bunArgs };
}

/**
 * Runs `bun test` in `cwd` with the author surface preloaded, and resolves to its exit code. When
 * `signal` aborts, as on Ctrl-C to awf alone, the tests are stopped with the same signal.
 */
export async function runWorkflowTests(
  command: TestCommand,
  cwd: string,
  options: {
    signal?: AbortSignal;
    output?: { stdout(text: string): void; stderr(text: string): void };
  } = {},
): Promise<number> {
  const { signal, output } = options;
  const child = Bun.spawn(
    [
      process.execPath,
      // As `awf run`: a `.env` can hold a token that changes how every agent logs in.
      "--no-env-file",
      "test",
      "--preload",
      PRELOAD,
      ...command.bunArgs,
      ...command.paths,
    ],
    {
      cwd,
      stdin: "inherit",
      stdout: output ? "pipe" : "inherit",
      stderr: output ? "pipe" : "inherit",
    },
  );
  const stop = () =>
    child.kill(
      typeof signal?.reason === "string" && signal.reason in constants.signals
        ? (signal.reason as NodeJS.Signals)
        : "SIGTERM",
    );
  if (signal?.aborted) stop();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    if (output) {
      const [out, err] = await Promise.all([
        new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr as ReadableStream).text(),
      ]);
      if (out) output.stdout(out.trimEnd());
      if (err) output.stderr(err.trimEnd());
    }
    const code = await child.exited;
    // Ended by a signal, it exits as a shell reports one: 128 and the signal's number.
    const ended = child.signalCode as keyof typeof constants.signals | null;
    return ended ? 128 + constants.signals[ended] : code;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
}
