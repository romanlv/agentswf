/**
 * What a nudge costs, when the matrix does not produce enough of them on its own.
 *
 * The first turn here is the task with no reporting instructions at all, so it always settles
 * without a value; the second turn is the same one-line nudge `trial.ts` sends. That is not the
 * natural failure population — these agents were never asked to report — but it is the same two
 * turns against the same live agent, which is what the plan's "nudging is cheaper than a re-run"
 * claim is about. The re-run it is compared against is the first turn itself.
 *
 *   bun run e2/nudge-cost.ts [trials] [harness] [backend]
 */
import { join } from "node:path";
import { createHeadlessBackend } from "../backends/headless";
import { createPaneBackend } from "../backends/pane";
import { collect, instructions, nudge, type MethodContext , writeE2Call } from "../return-method"
import { appendTrial, createRunDir } from "../deps";
import { resultFilePath } from "../trial";
import type { BackendKind, Harness, Step } from "../deps";

const HERE = join(import.meta.dir, "..");
const TRIALS = Number(process.argv[2] ?? 5);
const ONLY_HARNESS = process.argv[3];
const ONLY_BACKEND = process.argv[4];
const SCHEMA = {
  type: "object" as const,
  properties: { count: { type: "integer" as const, minimum: 0 }, even: { type: "boolean" as const } },
  required: ["count", "even"],
  additionalProperties: false,
};
const QUESTION =
  "how many times does the letter e appear in 'agent terminal', and is that count even";
const PROMPT =
  "Count how many times the letter e appears in the string 'agent terminal', " +
  "and say whether that count is even. Do not use any tools for the counting.";

const runDir = await createRunDir(join(HERE, "e2", "results"), "nudge-cost");
const binDir = join(HERE, "bin");
const backends: Record<BackendKind, ReturnType<typeof createHeadlessBackend>> = {
  headless: createHeadlessBackend({ turnTimeoutMs: 180_000, binDir }),
  pane: createPaneBackend({
    session: "wf-lab",
    workspaceLabel: "e2-nudge",
    commandTimeoutMs: 30_000,
    settleTimeoutMs: 180_000,
    binDir,
  }),
};

for (const harness of ["claude", "codex", "pi", "cursor"] as Harness[]) {
  if (ONLY_HARNESS && harness !== ONLY_HARNESS) continue;
  for (const backend of ["headless", "pane"] as BackendKind[]) {
    if (ONLY_BACKEND && backend !== ONLY_BACKEND) continue;
    for (let index = 1; index <= TRIALS; index += 1) {
      const callId = `${harness}-${backend}-nudge-${index}`;
      const context: MethodContext = {
        runDir,
        callId,
        filePath: resultFilePath(runDir, callId),
        schema: SCHEMA,
      };
      await writeE2Call(runDir, {
        callId,
        question: QUESTION,
        method: "cli-callback",
        schema: SCHEMA,
      });
      const step: Step = { prompt: PROMPT, harness, backend, cwd: HERE, schema: SCHEMA };

      let record: Record<string, unknown> = { callId, harness, backend, index };
      try {
        const session = await backends[backend].open(step, { runDir, callId });
        try {
          // No reporting instructions: this turn is guaranteed to settle without a value.
          const firstStarted = Date.now();
          const first = await session.prompt(PROMPT);
          const firstMs = Date.now() - firstStarted;

          // The nudge names the channel for the first time, which is what makes it recoverable.
          const nudgeStarted = Date.now();
          const second = await session.prompt(
            `${nudge("cli-callback", context)}\n${instructions("cli-callback", context)}`,
          );
          const nudgeMs = Date.now() - nudgeStarted;
          const recovered = await collect("cli-callback", context, await session.transcript());

          record = {
            ...record,
            recovered: recovered.kind === "value",
            firstMs,
            nudgeMs,
            firstUsage: first.usage ?? null,
            nudgeUsage: second.usage ?? null,
            firstState: first.state,
            nudgeState: second.state,
            sessionRef: second.sessionRef ?? first.sessionRef ?? null,
          };
        } finally {
          await session.close().catch(() => {});
        }
      } catch (error) {
        record = { ...record, error: error instanceof Error ? error.message : String(error) };
      }
      await appendTrial(runDir, record);
      console.log(JSON.stringify(record));
    }
  }
}
