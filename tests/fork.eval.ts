import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForkResult } from "../examples/fork/workflow";
import type { OutputRecord, SettledOperation } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { assertLiveOptIn, interruption } from "./live";

/**
 * Forks on every harness and placement, with and without compaction, live (story 016): a worker
 * notes a codename, may compact, is forked, then notes a release. Each fork must answer the codename
 * through its own channel and not know the release, and the worker both. Each fork's first operation
 * must read most of its prompt from its parent's cache, except cursor's, whose usage awf does not
 * read. One run of 26 agents, about two minutes and ~$2 at list prices, its headless claude
 * metered, the rest on subscriptions.
 */
const FORK = join(import.meta.dir, "../examples/fork/workflow.ts");

export const CASES = [
  "claude",
  "claude:compact",
  "claude>headless",
  "claude-headless",
  "claude-headless:compact",
  "claude-headless>pane",
  "codex",
  "codex:compact",
  "codex-headless",
  "codex-headless:compact",
  "pi",
  "pi:compact",
  "cursor",
];

/** A fork reads at least this share of its first operation's prompt from the cache. */
const CACHED = 0.5;

/** The share of an operation's prompt read from the cache; undefined where none was read. */
export function cachedShare(operation: SettledOperation | undefined): number | undefined {
  const tokens = operation?.spend?.map((spend) => spend.tokens);
  if (!tokens?.length) return undefined;
  const read = tokens.reduce((sum, t) => sum + t.cacheRead, 0);
  const all = tokens.reduce((sum, t) => sum + t.input + t.cacheRead + t.cacheWrite, 0);
  return all === 0 ? undefined : read / all;
}

export function problems(exitCode: number, record: OutputRecord | undefined): string[] {
  if (exitCode !== 0 || record?.outcome !== "succeeded") {
    return [`run did not succeed: exit ${exitCode}, outcome ${record?.outcome ?? "missing"}`];
  }
  const { checks, ...args } = record.value as ForkResult;
  const found: string[] = [];
  for (const check of checks) {
    if (check.problem) found.push(`${check.name}: ${check.problem}`);
    const fork = check.fork;
    const worker = check.worker;
    if (fork && fork.codename !== args.codename) {
      found.push(`${check.name}: the fork recalled ${fork.codename}, not ${args.codename}`);
    }
    if (fork && fork.release === args.release) {
      found.push(`${check.name}: the fork knew the release told after it`);
    }
    if (worker && (worker.codename !== args.codename || worker.release !== args.release)) {
      found.push(`${check.name}: the worker recalled ${worker.codename} and ${worker.release}`);
    }
    // Cursor records no usage awf can read (F11).
    if (check.name.startsWith("cursor")) continue;
    const first = record.usage.find((usage) => usage.agent === `fork:${check.name}`);
    const share = cachedShare(first);
    if (share === undefined || share < CACHED) {
      found.push(`${check.name}: the fork's first turn read ${share ?? "nothing"} from the cache`);
    }
  }
  return found;
}

if (import.meta.main) {
  assertLiveOptIn();
  const workDir = await mkdtemp(join(tmpdir(), "awf-fork-"));
  const output: string[] = [];
  const cases = process.argv.slice(2);
  const exitCode = await runOperatorCli(
    [
      "run",
      "--run-root",
      join(workDir, "runs"),
      "--timeout",
      "20m",
      "--json",
      FORK,
      "--",
      ...(cases.length > 0 ? cases : CASES),
    ],
    {
      cwd: workDir,
      signal: interruption(),
      stdout: (text) => output.push(text),
      stderr: (text) => console.error(text),
    },
  );
  const record = output.length > 0 ? (JSON.parse(output.join("\n")) as OutputRecord) : undefined;
  const failed = problems(exitCode, record);
  const succeeded = record?.outcome === "succeeded" ? (record.value as ForkResult).checks : [];
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        failed,
        checks: succeeded.map((check) => ({
          ...check,
          cached: cachedShare(record?.usage.find((usage) => usage.agent === `fork:${check.name}`)),
        })),
        estimateUsd: record?.accounting.totals.estimate,
        artifacts: record?.artifacts,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) process.exitCode = 1;
}
