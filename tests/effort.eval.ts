import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { EffortCheck, EffortResult } from "../examples/effort/workflow";
import { RUNTIMES } from "../examples/effort/workflow";
import type { OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { assertLiveOptIn, interruption } from "./live";

/**
 * Effort and `set` on every harness and placement that switches, live, on cheap models (story
 * 020): each agent opens at `low`, is set to `high`, then to another model, with a turn between
 * each. Its record must say so, and so must what the harness itself logged it ran at: claude's
 * transcript, codex's rollout, pi's shell. Its last turn must still know the word its first was
 * told. One run of six agents, a metered headless claude among them, about a minute and $0.50 at
 * list prices.
 */
const EFFORT = join(import.meta.dir, "../examples/effort/workflow.ts");

type Ran = { model: string; effort: string | null };

export async function problems(
  exitCode: number,
  record: OutputRecord | undefined,
  logged: (check: EffortCheck) => Promise<Ran[] | undefined> = harnessLog,
): Promise<string[]> {
  if (exitCode !== 0 || record?.outcome !== "completed") {
    return [`run did not succeed: exit ${exitCode}, outcome ${record?.outcome ?? "missing"}`];
  }
  const { checks, word } = record.value as EffortResult;
  const found: string[] = [];
  for (const check of checks) {
    const name = check.runtime;
    if (check.problem) {
      found.push(`${name}: ${check.problem}`);
      continue;
    }
    const { execution, switched: then } = RUNTIMES[name];
    const expected = [
      [execution.model, execution.effort],
      [execution.model, then.effort],
      [execution.model, then.effort],
      [then.model, then.effort],
      [then.model, then.effort],
    ];
    const recorded = check.steps.map((step) => [step.execution.model, step.execution.effort]);
    if (JSON.stringify(recorded) !== JSON.stringify(expected)) {
      found.push(`${name}: recorded ${JSON.stringify(recorded)}, not ${JSON.stringify(expected)}`);
    }
    const last = check.steps.at(-1);
    if (last?.word?.toLowerCase() !== word) {
      found.push(`${name}: its last turn recalled ${last?.word}, not ${word}`);
    }
    const turns = check.steps.filter((step) => step.kind === "turn");
    if (name.startsWith("pi")) {
      // pi names its model and level to its shell, the one per-turn readback it has (M6).
      const wanted = [execution, { model: execution.model, effort: then.effort }, then];
      turns.forEach((turn, at) => {
        const shell = turn.shell ?? "";
        const { model, effort } = wanted[at]!;
        const [ranModel, ranEffort] = shell.trim().split(/\s+/);
        if (ranModel?.split("/").at(-1) !== model.split("/").at(-1) || ranEffort !== effort) {
          found.push(`${name}: turn ${at + 1}'s shell said "${shell}", not ${model} ${effort}`);
        }
      });
      continue;
    }
    const ran = await logged(check);
    if (!ran) {
      found.push(`${name}: its harness's log was not found`);
      continue;
    }
    const want: Ran[] = [
      { model: execution.model, effort: execution.effort },
      { model: execution.model, effort: then.effort },
      { model: then.model, effort: then.effort },
    ];
    const distinct = ran.filter(
      (row, at) => at === 0 || JSON.stringify(row) !== JSON.stringify(ran[at - 1]),
    );
    if (JSON.stringify(distinct) !== JSON.stringify(want)) {
      found.push(
        `${name}: the harness logged ${JSON.stringify(distinct)}, not ${JSON.stringify(want)}`,
      );
    }
  }
  return found;
}

/** What the harness logged each request ran at, in order, from its own session files. */
export async function harnessLog(check: EffortCheck): Promise<Ran[] | undefined> {
  const sessions = [...new Set(check.steps.flatMap((step) => step.sessions))];
  const harness = RUNTIMES[check.runtime].execution.harness;
  const files =
    harness === "claude"
      ? sessions.flatMap((id) => [
          ...new Bun.Glob(`*/${id}.jsonl`).scanSync({
            cwd: join(homedir(), ".claude", "projects"),
            absolute: true,
          }),
        ])
      : sessions.flatMap((id) => [
          ...new Bun.Glob(`**/rollout-*${id}.jsonl`).scanSync({
            cwd: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
            absolute: true,
          }),
        ]);
  if (files.length === 0) return undefined;
  const ran: Ran[] = [];
  for (const file of [...new Set(files)]) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as {
        type?: string;
        message?: { model?: string };
        perTurnEffort?: string | null;
        payload?: { model?: string; effort?: string };
      };
      if (
        harness === "claude" &&
        row.type === "assistant" &&
        row.message?.model !== "<synthetic>"
      ) {
        ran.push({ model: row.message?.model ?? "", effort: row.perTurnEffort ?? null });
      }
      if (harness === "codex" && row.type === "turn_context") {
        ran.push({ model: row.payload?.model ?? "", effort: row.payload?.effort ?? null });
      }
    }
  }
  return ran;
}

if (import.meta.main) {
  assertLiveOptIn();
  const workDir = await mkdtemp(join(tmpdir(), "awf-effort-"));
  const output: string[] = [];
  const exitCode = await runOperatorCli(
    [
      "run",
      "--run-root",
      join(workDir, "runs"),
      "--timeout",
      "20m",
      "--json",
      EFFORT,
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
  const failed = await problems(exitCode, record);
  console.log(
    JSON.stringify(
      {
        ok: failed.length === 0,
        failed,
        checks: record?.outcome === "completed" ? (record.value as EffortResult).checks : undefined,
        estimateUsd: record?.accounting.totals.estimate,
        artifacts: record?.artifacts,
      },
      null,
      2,
    ),
  );
  if (failed.length > 0) process.exitCode = 1;
}
