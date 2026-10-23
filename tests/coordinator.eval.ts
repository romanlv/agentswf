import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputRecord, RunLogLine } from "../packages/contract/src/records";
import type { CoordinatorHolder } from "../packages/engine/src/coordinator-port";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import {
  CODEWORD,
  type CoordinatorSmokeResult,
  HEADLESS_NAMES,
} from "./fixtures/coordinator-smoke";
import { assertLiveOptIn, interruption } from "./live";

/**
 * Story 032's coordinator smoke on live agents: each investigator reports to the coordinator and
 * asks it for a codeword, and the answer, given as an app would through the run's holder, continues
 * the asker's same call. With no names, claude and codex headless. With `--late`, each operation
 * has 60 s and the answer comes after 90 s: the wait doesn't count, so it goes on.
 */
const SMOKE = join(import.meta.dir, "fixtures/coordinator-smoke.ts");

export function problems(
  exitCode: number,
  record: OutputRecord | undefined,
  names: readonly string[],
  lines: readonly RunLogLine[],
): string[] {
  if (exitCode !== 0 || record?.outcome !== "completed")
    return [`run did not succeed: exit ${exitCode}, outcome ${record?.outcome ?? "missing"}`];
  const found: string[] = [];
  const results = record.value as CoordinatorSmokeResult;
  for (const name of names) {
    const agent = `investigator:${name}`;
    const result = results.find((each) => each.runtime === name);
    if (result?.codeword !== CODEWORD)
      found.push(`${name}: ${result?.outcome ?? "no result"}, codeword ${result?.codeword}`);
    const sent = lines.filter(
      (line) => line.kind === "message-sent" && line.from === agent && line.to === "coordinator",
    );
    if (!sent.some((line) => line.kind === "message-sent" && !line.awaitsReply))
      found.push(`${name}: no report reached the coordinator`);
    const question = sent.find((line) => line.kind === "message-sent" && line.awaitsReply);
    if (!question) found.push(`${name}: no question reached the coordinator`);
    else if (
      !lines.some(
        (line) =>
          line.kind === "request-ended" &&
          question.kind === "message-sent" &&
          line.message === question.message &&
          line.end === "replied",
      )
    )
      found.push(`${name}: its question was not answered`);
    const answers = lines.filter(
      (line) => line.kind === "message-sent" && line.from === "coordinator" && line.to === agent,
    );
    if (answers.length !== 1 || answers[0]?.kind !== "message-sent" || answers[0].via !== "command")
      found.push(`${name}: the answer was not recorded once, via command`);
    const operations = lines.filter(
      (line) => line.kind === "operation-started" && line.agent === agent,
    );
    if (operations.length !== 1)
      found.push(`${name}: the investigator ran ${operations.length} operations, not 1`);
  }
  if (!lines.some((line) => line.kind === "participant-connected"))
    found.push("no participant-connected line");
  if (!lines.some((line) => line.kind === "route-closed" && line.reason === "released"))
    found.push("the coordinator was not released when the workflow returned");
  return found;
}

if (import.meta.main) {
  assertLiveOptIn();
  const late = process.argv.includes("--late");
  const given = process.argv.slice(2).filter((arg) => arg !== "--late");
  const names = given.length ? given : HEADLESS_NAMES;
  const workDir = await mkdtemp(join(tmpdir(), "awf-coordinator-"));
  const output: string[] = [];
  let holder: CoordinatorHolder | undefined;
  const asked: string[] = [];
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
      ...(late ? ["--timeout-ms", "60000"] : []),
    ],
    {
      cwd: workDir,
      signal: interruption(),
      stdout: (text) => output.push(text),
      stderr: (text) => console.error(text),
      // An app's part: answer each question as it is recorded.
      coordinators: [
        {
          attach: (given) => {
            holder = given;
          },
          recorded: (event) => {
            if (event.kind !== "message-sent" || event.to !== "coordinator" || !event.awaitsReply)
              return;
            asked.push(event.text);
            setTimeout(
              () => {
                void holder
                  ?.reply({
                    agent: event.from,
                    to: event.message,
                    text: `The codeword is ${CODEWORD}.`,
                    via: "command",
                  })
                  .then((result) => console.error(`coordinator → ${event.from}: ${result.code}`));
              },
              late ? 90_000 : 2_000,
            );
          },
        },
      ],
    },
  );
  const record = output.length > 0 ? (JSON.parse(output.join("\n")) as OutputRecord) : undefined;
  const text = record
    ? await readFile(join(record.artifacts, "turns.jsonl"), "utf8").catch(() => "")
    : "";
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunLogLine);
  const failed = problems(exitCode, record, names, lines);
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        failed,
        asked,
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
