import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import type { FanOutAnswer } from "./fixtures/fan-out";
import { assertLiveOptIn, interruption } from "./live";

/**
 * Twelve codex and six claude TUI agents prompted at once, twice each (story concurrent-agents):
 * with twelve codex panes busy, Herdr missed half their turns and showed the rest's end past the
 * release. Every answer must be right, and the run end with no cleanup left unresolved.
 * `bun tests/fan-out.eval.ts codex=4` runs fewer. 18 agents, ~2 min, ~$0.30 at list prices.
 */
const FAN_OUT = join(import.meta.dir, "fixtures/fan-out.ts");

export function problems(exitCode: number, record: OutputRecord | undefined): string[] {
  if (exitCode !== 0 || record?.outcome !== "completed") {
    const reason = record && "reason" in record ? `: ${record.reason}` : "";
    return [
      `run did not succeed: exit ${exitCode}, outcome ${record?.outcome ?? "missing"}${reason}`,
    ];
  }
  const found: string[] = [];
  for (const agent of record.value as FanOutAnswer[]) {
    const right = agent.answers.filter((answer, at) => answer === agent.expected[at]).length;
    if (right !== agent.expected.length) {
      found.push(
        `${agent.agent}: ${right} of ${agent.expected.length} right (${agent.outcomes.join(", ")}${
          agent.reasons.length > 0 ? `: ${agent.reasons.join("; ")}` : ""
        })`,
      );
    }
  }
  return found;
}

if (import.meta.main) {
  assertLiveOptIn();
  const workDir = await mkdtemp(join(tmpdir(), "awf-fan-out-"));
  const output: string[] = [];
  const startedAt = Date.now();
  const exitCode = await runOperatorCli(
    [
      "run",
      "--run-root",
      join(workDir, "runs"),
      "--timeout",
      "10m",
      "--json",
      FAN_OUT,
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
        seconds: Math.round((Date.now() - startedAt) / 1000),
        estimateUsd: record?.accounting.totals.estimate,
        artifacts: record?.artifacts,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) process.exitCode = 1;
}
