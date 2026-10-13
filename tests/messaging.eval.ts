import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord, RunLogLine } from "../packages/contract/src/records";
import { canAwaitReply } from "../packages/engine/src/messaging/limits";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { CODEWORD, HEADLESS_NAMES, RUNTIMES, type SmokeResult } from "./fixtures/messaging-smoke";
import { assertLiveOptIn, interruption } from "./live";

/**
 * Story 029's delivery smoke, with `--await-reply` turned on for what it runs: a question wakes a
 * keeper that has never run, its answer resumes the asker's same call, and the record says what
 * confirmed each delivery. With no names, the four headless pairs; `claude-pane`, `codex-pane`,
 * `pi-pane` and `cursor-pane` run a pane's. Two agents each.
 */
const SMOKE = join(import.meta.dir, "fixtures/messaging-smoke.ts");

/**
 * Whether a delivery to this side can be confirmed: a claude pane's receipt, or a headless
 * session's own record but cursor's, which keeps its chats in a SQLite store awf cannot read. A
 * codex, pi or cursor pane gives no evidence.
 */
function confirmable(name: string, side: "asker" | "keeper"): boolean {
  const { asker, keeper } = RUNTIMES[name]!;
  const execution = side === "asker" ? asker : keeper;
  if (execution.placement !== "headless") return execution.harness === "claude";
  return execution.harness !== "cursor";
}

export async function problems(
  exitCode: number,
  record: OutputRecord | undefined,
  names: readonly string[],
): Promise<string[]> {
  if (exitCode !== 0 || record?.outcome !== "completed") {
    return [`run did not succeed: exit ${exitCode}, outcome ${record?.outcome ?? "missing"}`];
  }
  const found: string[] = [];
  const results = record.value as SmokeResult;
  for (const name of names) {
    const result = results.find((each) => each.runtime === name);
    if (result?.codeword !== CODEWORD) {
      found.push(`${name}: ${result?.outcome ?? "no result"}, codeword ${result?.codeword}`);
    }
  }
  const text = await readFile(join(record.artifacts, "turns.jsonl"), "utf8").catch(() => undefined);
  if (text === undefined) return [...found, "the run's event log could not be read"];
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunLogLine);
  for (const name of names) {
    const keeper = `keeper:${name}`;
    const woken = lines.some(
      (line) => line.kind === "turn" && line.agent === keeper && line.cause?.message.from,
    );
    if (!woken) found.push(`${name}: the keeper was not woken by the question`);
    for (const agent of [keeper, `asker:${name}`]) {
      const expected = confirmable(name, agent === keeper ? "keeper" : "asker")
        ? "observed"
        : "unconfirmed";
      const states = lines.flatMap((line) =>
        line.kind === "message-delivery" && line.state !== "offered" && line.to === agent
          ? [line.state]
          : [],
      );
      if (states.length === 0 || states.some((state) => state !== expected)) {
        found.push(`${agent}: deliveries ${states.join(", ") || "never settled"}, not ${expected}`);
      }
    }
    // The answer continued the asker's own call: one operation, carried by more than one turn.
    const asks = lines.filter(
      (line) => line.kind === "operation-started" && line.agent === `asker:${name}`,
    );
    if (asks.length !== 1) found.push(`${name}: the asker ran ${asks.length} operations, not 1`);
  }
  return found;
}

if (import.meta.main) {
  assertLiveOptIn();
  const names = process.argv.slice(2).length ? process.argv.slice(2) : HEADLESS_NAMES;
  const workDir = await mkdtemp(join(tmpdir(), "awf-messaging-"));
  const output: string[] = [];
  const exitCode = await runOperatorCli(
    [
      "run",
      "--run-root",
      join(workDir, "runs"),
      "--timeout",
      "8m",
      "--json",
      SMOKE,
      "--",
      ...names,
    ],
    {
      cwd: workDir,
      signal: interruption(),
      stdout: (text) => output.push(text),
      stderr: (text) => console.error(text),
      // The engine's list has what M2 passed; this smoke turns cursor on too, to show its delivery
      // works, and checks every harness headless and a claude pane that confirms what it was sent.
      awaitReply: (execution, confirms) =>
        canAwaitReply(execution, confirms, {
          claude: { headless: true, pane: "confirmed" },
          codex: { headless: true },
          pi: { headless: true },
          cursor: { headless: true },
        }),
    },
  );
  const record = output.length > 0 ? (JSON.parse(output.join("\n")) as OutputRecord) : undefined;
  const failed = await problems(exitCode, record, names);
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        failed,
        results: record?.outcome === "completed" ? record.value : undefined,
        estimateUsd: record?.accounting.totals.estimate,
        artifacts: record?.artifacts,
      },
      null,
      2,
    ),
  );
  process.exit(failed.length === 0 ? 0 : 1);
}
