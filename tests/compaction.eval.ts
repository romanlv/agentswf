import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompactionResult } from "../examples/compaction/workflow";
import type { OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { assertLiveOptIn, interruption } from "./live";

/**
 * Native compaction on every harness and placement, live, on its cheapest model (story 015): each
 * agent notes a colour, is compacted with a focus naming a codename it was never told, and is then
 * asked both. An answer means the harness compacted; the codename back means the focus reached it;
 * the colour back means the session went on. Cursor has no compaction and must say so, then go on.
 * One run of seven agents, a pane claude, codex and pi among them, about two minutes and $0.20
 * at list prices, a metered headless claude included.
 */
const COMPACTION = join(import.meta.dir, "../examples/compaction/workflow.ts");

/** Where the harness shows its summary, it must carry the focus too. */
const SHOWS_SUMMARY = new Set(["claude", "claude-headless", "pi", "pi-pane"]);

export function problems(exitCode: number, record: OutputRecord | undefined): string[] {
  if (exitCode !== 0 || record?.outcome !== "succeeded") {
    return [`run did not succeed: exit ${exitCode}, outcome ${record?.outcome ?? "missing"}`];
  }
  const { checks, codename, colour } = record.value as CompactionResult;
  const found: string[] = [];
  for (const check of checks) {
    const name = check.runtime;
    if (check.problem) found.push(`${name}: ${check.problem}`);
    if (name === "cursor") {
      if (check.compacted !== "failed") found.push(`cursor: compaction ${check.compacted}`);
    } else if (check.compacted !== "answered") {
      found.push(`${name}: compaction ${check.compacted}: ${check.reason ?? ""}`);
    } else if (SHOWS_SUMMARY.has(name) && !check.summary?.includes(codename)) {
      found.push(`${name}: its summary lacks the codename: ${check.summary?.slice(0, 200)}`);
    }
    if (check.recalled && name !== "cursor" && check.recalled.codename !== codename) {
      found.push(`${name}: recalled codename ${check.recalled.codename}, not ${codename}`);
    }
    if (check.recalled && check.recalled.colour.toLowerCase() !== colour) {
      found.push(`${name}: recalled colour ${check.recalled.colour}, not ${colour}`);
    }
  }
  return found;
}

if (import.meta.main) {
  assertLiveOptIn();
  const workDir = await mkdtemp(join(tmpdir(), "awf-compaction-"));
  const output: string[] = [];
  const exitCode = await runOperatorCli(
    [
      "run",
      "--run-root",
      join(workDir, "runs"),
      "--timeout",
      "15m",
      "--json",
      COMPACTION,
      "--",
      ...process.argv.slice(2),
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
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        failed,
        checks: (record?.outcome === "succeeded"
          ? (record.value as CompactionResult)
          : undefined
        )?.checks.map((check) => ({
          ...check,
          summary: check.summary?.slice(0, 300),
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
