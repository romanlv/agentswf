import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";

/**
 * Story 003 against a live harness: a run that crashes, and one cancelled mid-turn, each after one
 * headless codex agent has answered, must keep that spend in `output.json`. Two short codex runs on
 * gpt-6-luna and the ChatGPT subscription, about 20 s and under a cent at list prices.
 */
const FIXTURE = join(import.meta.dir, "fixtures/spend-then-stop.ts");
const CANCEL_AFTER_ANSWER_MILLISECONDS = 3_000;
const operator = new AbortController();

type Observed = {
  mode: "crash" | "cancel";
  exitCode: number;
  outcome?: OutputRecord["outcome"];
  tokens?: number;
  estimate?: number;
  artifacts?: string;
};

async function scenario(mode: Observed["mode"]): Promise<Observed> {
  const workDir = await mkdtemp(join(tmpdir(), `awf-failed-run-${mode}-`));
  const controller = new AbortController();
  const output: string[] = [];
  const exitCode = await runOperatorCli(
    ["run", "--run-root", join(workDir, "runs"), "--timeout", "5m", "--json", FIXTURE, "--", mode],
    {
      cwd: workDir,
      signal: AbortSignal.any([controller.signal, operator.signal]),
      stdout: (text) => output.push(text),
      stderr: (text) => {
        console.error(text);
        if (mode === "cancel" && text === "answered") {
          setTimeout(() => controller.abort("SIGINT"), CANCEL_AFTER_ANSWER_MILLISECONDS);
        }
      },
    },
  );
  if (output.length === 0) return { mode, exitCode };
  const printed = JSON.parse(output.join("\n")) as OutputRecord;
  // The file, not the printed copy: `--json` prints the record even when saving it failed.
  const record = JSON.parse(
    await Bun.file(join(printed.artifacts, "output.json")).text(),
  ) as OutputRecord;
  const { tokens, estimate } = record.accounting.totals;
  return {
    mode,
    exitCode,
    outcome: record.outcome,
    tokens: tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output,
    ...(estimate === undefined ? {} : { estimate }),
    artifacts: record.artifacts,
  };
}

function problems(observed: Observed): string[] {
  const expected =
    observed.mode === "crash"
      ? { exitCode: 1, outcome: "failed" }
      : { exitCode: 130, outcome: "cancelled" };
  return [
    ...(observed.exitCode === expected.exitCode
      ? []
      : [`exit ${observed.exitCode}, expected ${expected.exitCode}`]),
    ...(observed.outcome === expected.outcome
      ? []
      : [`outcome ${observed.outcome ?? "missing"}, expected ${expected.outcome}`]),
    ...(observed.tokens ? [] : ["no tokens recorded for an agent that answered"]),
  ].map((problem) => `${observed.mode}: ${problem}`);
}

if (import.meta.main) {
  if (process.env.WF_LIVE_EVAL !== "1") {
    console.error("WF_LIVE_EVAL=1 is required to start live agents");
    process.exit(1);
  }
  process.on("SIGINT", () => operator.abort("SIGINT"));
  process.on("SIGTERM", () => operator.abort("SIGTERM"));
  const observed = [await scenario("crash")];
  if (!operator.signal.aborted) observed.push(await scenario("cancel"));
  const failed = observed.flatMap(problems);
  const estimate = observed.every((run) => run.estimate !== undefined)
    ? observed.reduce((sum, run) => sum + (run.estimate ?? 0), 0)
    : undefined;
  console.log(
    JSON.stringify({ ok: failed.length === 0, failed, estimateUsd: estimate, observed }, null, 2),
  );
  if (failed.length > 0) process.exitCode = 1;
}
