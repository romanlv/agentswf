import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuickCheckResult } from "../examples/quick-check/workflow";
import type { OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { assertLiveOptIn, interruption } from "./live";

/**
 * Every harness awf runs, live, on its cheapest model: codex, pi and cursor headless, and claude, pi
 * and cursor in a Herdr pane, each answering a follow-up in the same session. Each must answer right
 * through `wf result`, and each agent's spend must be read on its subscription, but cursor's: what
 * it bills is unknown, and in a pane it prints no usage. One run of six agents, about 40 s and $0.07
 * at list prices.
 */
const QUICK_CHECK = join(import.meta.dir, "../examples/quick-check/workflow.ts");
const HARNESSES = ["codex", "pi", "pi-pane", "claude", "cursor", "cursor-pane"] as const;

export function problems(exitCode: number, record: OutputRecord | undefined): string[] {
  if (exitCode !== 0 || record?.outcome !== "completed") {
    return [`run did not succeed: exit ${exitCode}, outcome ${record?.outcome ?? "missing"}`];
  }
  const { checks } = record.value as QuickCheckResult;
  const found: string[] = [];
  for (const harness of HARNESSES) {
    const check = checks.find((candidate) => candidate.runtime === harness);
    const expectedAnswers = 2;
    const right = check?.answers.filter((answer) => answer.answer === answer.expected).length ?? 0;
    if (right !== expectedAnswers) {
      found.push(`${harness}: ${right} of ${expectedAnswers} answers right`);
    }
  }
  for (const agent of record.accounting.byAgent) {
    const cursor = agent.execution.harness === "cursor";
    if (agent.known !== agent.agents && !(cursor && agent.execution.placement !== "headless")) {
      found.push(`${agent.agent}: usage unknown`);
    }
    if (agent.billing !== (cursor ? "unknown" : "subscription")) {
      found.push(`${agent.agent}: billing ${agent.billing}`);
    }
  }
  if (record.accounting.byAgent.length !== HARNESSES.length) {
    found.push(
      `${record.accounting.byAgent.length} agents accounted, expected ${HARNESSES.length}`,
    );
  }
  return found;
}

if (import.meta.main) {
  assertLiveOptIn();
  const workDir = await mkdtemp(join(tmpdir(), "awf-harnesses-"));
  const output: string[] = [];
  const exitCode = await runOperatorCli(
    [
      "run",
      "--run-root",
      join(workDir, "runs"),
      "--timeout",
      "5m",
      "--json",
      QUICK_CHECK,
      "--",
      ...HARNESSES,
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
        estimateUsd: record?.accounting.totals.estimate,
        artifacts: record?.artifacts,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) process.exitCode = 1;
}

/** Ctrl-C stops the run and its agents, as it does under `awf run`, instead of killing the process. */
