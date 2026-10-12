import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord, RunLogLine } from "../packages/contract/src/records";
import { canAwaitReply } from "../packages/engine/src/messaging/limits";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { CODEWORD, RUNTIMES, type SmokeResult } from "./fixtures/messaging-smoke";
import { assertLiveOptIn, interruption } from "./live";

/**
 * Story 029's headless delivery smoke, with `--await-reply` forced on for the harnesses named (all
 * four by default): a question wakes a keeper that has never run, its answer resumes the asker's
 * same call, and the record shows both delivered and seen. Two agents a harness.
 * `bun tests/messaging.eval.ts codex pi` runs only those.
 */
const SMOKE = join(import.meta.dir, "fixtures/messaging-smoke.ts");

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
    // cursor keeps its chats in a SQLite store awf cannot read, so nothing confirms a delivery.
    const expected = name === "cursor" ? "unconfirmed" : "observed";
    for (const agent of [keeper, `asker:${name}`]) {
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
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(RUNTIMES);
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
      // The list is off until M2 passes on a harness; this smoke turns each on, headless, to show
      // its delivery works.
      awaitReply: (execution, confirms) =>
        canAwaitReply(
          execution,
          confirms,
          Object.fromEntries(
            names.map((name) => [
              RUNTIMES[name as keyof typeof RUNTIMES].harness,
              { headless: true },
            ]),
          ),
        ),
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
