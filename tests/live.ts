import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord } from "../packages/contract/src/records";
import { type OperatorEnvironment, runOperatorCli } from "../packages/engine/src/operator-cli";

/** The live evals' consent to spend, which `bun run eval` gives. */
const LIVE_EVAL = "AWF_LIVE_EVAL";

/** Throws unless the runner gave that consent; `what` says what it is for. */
export function assertLiveOptIn(
  env: Readonly<Record<string, string | undefined>> = process.env,
  what = "start live agents",
): void {
  if (env[LIVE_EVAL] !== "1") throw new Error(`${LIVE_EVAL}=1 is required to ${what}`);
}

/** Aborts when the operator interrupts the eval. */
export function interruption(): AbortSignal {
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort("SIGINT"));
  process.on("SIGTERM", () => controller.abort("SIGTERM"));
  return controller.signal;
}

/**
 * Sets `name`, unless it is set, from the repository's git-ignored `.env`, which `bunfig.toml`
 * keeps Bun from loading whole.
 */
export async function loadFromDotEnv(name: string): Promise<void> {
  if (process.env[name]) return;
  const env = await readFile(join(import.meta.dir, "..", ".env"), "utf8").catch(() => "");
  const line = env.split("\n").find((entry) => entry.startsWith(`${name}=`));
  const value = line
    ?.slice(line.indexOf("=") + 1)
    .replace(/^["']|["']$/g, "")
    .trim();
  if (value) process.env[name] = value;
}

export type LiveOptions = Omit<OperatorEnvironment, "stdout"> & {
  /** The run's own directory; a new temporary one, `awf-{name}-…`, when absent. */
  workDir?: string;
  /** `--run-root`; `runs` in the work directory when absent. */
  runRoot?: string;
  /** `--timeout`; the CLI's default when absent. */
  timeout?: string;
  /** More of `awf run`'s flags, given before the workflow. */
  flags?: readonly string[];
};

export type LiveRun = { exitCode: number; record: OutputRecord | undefined; workDir: string };

/**
 * `awf run --json {workflow} -- {args}`, and the record it printed. The run's cwd is the work
 * directory, Ctrl-C stops it and its stderr is passed through, unless `options` says otherwise.
 */
export async function runLive(
  name: string,
  workflow: string,
  args: readonly string[] = [],
  options: LiveOptions = {},
): Promise<LiveRun> {
  const { workDir: given, runRoot, timeout, flags = [], ...environment } = options;
  const workDir = given ?? (await mkdtemp(join(tmpdir(), `awf-${name}-`)));
  const output: string[] = [];
  const exitCode = await runOperatorCli(
    [
      "run",
      "--run-root",
      runRoot ?? join(workDir, "runs"),
      ...(timeout ? ["--timeout", timeout] : []),
      "--json",
      ...flags,
      workflow,
      "--",
      ...args,
    ],
    {
      cwd: workDir,
      stderr: (text) => console.error(text),
      ...environment,
      signal: environment.signal ?? interruption(),
      stdout: (text) => output.push(text),
    },
  );
  const record = output.length > 0 ? (JSON.parse(output.join("\n")) as OutputRecord) : undefined;
  return { exitCode, record, workDir };
}

/** What `bun run eval` reads off a run's record: its estimate and where its artifacts are. */
export function recorded(record: OutputRecord | undefined): {
  estimateUsd: number | undefined;
  artifacts: string | undefined;
} {
  return { estimateUsd: record?.accounting.totals.estimate, artifacts: record?.artifacts };
}

/**
 * Prints an eval's summary, the last JSON object on stdout, which `bun run eval` reads: `ok`, the
 * problems found, then `fields`. Any problem fails the process.
 */
export function report(
  failed: readonly string[],
  fields: Record<string, unknown> = {},
  fail: () => void = () => {
    process.exitCode = 1;
  },
): void {
  console.log(JSON.stringify({ ok: failed.length === 0, failed, ...fields }, null, 2));
  if (failed.length > 0) fail();
}
