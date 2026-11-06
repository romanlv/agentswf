import { existsSync, statSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Out } from "./command-line";
import { parseDuration } from "./duration";
import { messageOf } from "./errors";
import help from "./help/test.txt" with { type: "text" };
import { checkProjectEngine } from "./project-engine";
import { NO_JSON, printRefusal } from "./refusals";

const PRELOAD = fileURLToPath(new URL("./workflow-test-preload.ts", import.meta.url));

export const testUsage = help.trimEnd();

type TestCommand = { paths: string[]; bunArgs: string[] };

/**
 * `awf test`: the workflow tests under the given paths, with Bun's test runner. Their output goes
 * to `io.output` when given, else straight to this process's.
 */
export async function testCommand(
  argv: readonly string[],
  cwd: string,
  io: Out & { output?: Out; signal?: AbortSignal },
): Promise<number> {
  let tests: TestCommand;
  try {
    tests = parseTestCommand(argv, cwd);
  } catch (error) {
    printRefusal(io, NO_JSON, error, "usage", testUsage);
    return 2;
  }
  try {
    // Each test's workflow gets this engine's author surface: its project, and each path's, must
    // run on it (ADR 0015).
    // The paths given, or, with none, everything under here: bun test loads no other.
    for (const place of tests.paths.length > 0 ? tests.paths : [cwd]) {
      const isDir = statSync(resolve(cwd, place), { throwIfNoEntry: false })?.isDirectory();
      const dir = resolve(cwd, isDir ? place : dirname(place));
      // In a workspace whose packages each install agentswf, the tests' files name the engine.
      checkProjectEngine(dir, { files: isDir ? testFiles(dir) : [resolve(cwd, place)] });
    }
  } catch (error) {
    io.stderr(`awf: ${messageOf(error)}`);
    return 2;
  }
  return runWorkflowTests(tests, cwd, {
    ...(io.signal ? { signal: io.signal } : {}),
    ...(io.output ? { output: io.output } : {}),
  });
}

/**
 * Only these flags pass through, so the published command is awf's, not the whole of `bun test`'s,
 * and a later runner can take its place. A path must exist; Bun would take it as a filter.
 */
function parseTestCommand(argv: readonly string[], cwd: string): TestCommand {
  const paths: string[] = [];
  const bunArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index]!;
    const value = argv[index + 1];
    if (option === "--watch") {
      bunArgs.push("--watch");
    } else if (option === "-t") {
      if (value === undefined) throw new Error("-t needs a pattern");
      bunArgs.push("-t", value);
      index += 1;
    } else if (option === "--timeout") {
      if (value === undefined) throw new Error("--timeout needs a duration such as 10s");
      bunArgs.push("--timeout", String(parseDuration(value, "--timeout")));
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
async function runWorkflowTests(
  command: TestCommand,
  cwd: string,
  options: {
    signal?: AbortSignal;
    output?: Out;
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
  // awf exiting at a second signal does not wait for the tests, which would outlive it.
  const orphaned = () => child.kill("SIGKILL");
  process.on("exit", orphaned);
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
    process.off("exit", orphaned);
  }
}

/** A test file `bun test` would find under a folder, outside `node_modules`, for each folder. */
function testFiles(dir: string): string[] {
  const byFolder = new Map<string, string>();
  for (const path of new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx,mts,mjs}").scanSync({
    cwd: dir,
  }))
    if (!path.split("/").includes("node_modules") && !byFolder.has(dirname(path)))
      byFolder.set(dirname(path), join(dir, path));
  return [...byFolder.values()];
}
