import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createFakeDecisionProvider } from "../packages/engine/src/decisions/fake";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { createTempRunDirs } from "../packages/engine/src/testing";
import { createSingleSessionHostFactory } from "../packages/harness/src/single-session-host";
import { createFakeAdapter } from "../packages/harness/src/testing/fake";

const ROOT = join(import.meta.dir, "..");
const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

// What triage does with its answers is tested beside it; this checks that `awf run` hands a
// workflow the operator's decision models and prints what `present` makes of the result.
describe("examples/triage", () => {
  test("awf run asks the operator's decision model and prints what present makes of it", async () => {
    const provider = createFakeDecisionProvider([
      async () => ({
        snapshot: "typesafe/jev-1.13-20260917",
        answers: {
          team: {
            type: "choice",
            probabilities: { payments: 0.95, accounts: 0.03, frontend: 0.02 },
          },
          bug: { type: "yes-no", yes: 0.97 },
          urgency: { type: "score", probabilities: [0.1, 0.3, 0.6] },
        },
        tokens: { input: 400, output: 20 },
      }),
    ]);
    const output: string[] = [];
    const exitCode = await runOperatorCli(
      [
        "run",
        "--run-root",
        runDirs.tempRunDir(),
        "examples/triage/workflow.ts",
        "--",
        "Checkout charges twice",
      ],
      {
        cwd: ROOT,
        stdout: (text) => output.push(text),
        stderr: () => undefined,
        installRuntime: async () => ({
          config: {
            aliases: {},
            host: createSingleSessionHostFactory(createFakeAdapter({ script: () => ({}) })),
          },
          decisions: {
            providers: { openrouter: provider },
            aliases: { jev: { provider: "openrouter", model: "typesafe/jev-1.13" } },
          },
          cleanup: async () => undefined,
        }),
      },
    );
    expect(exitCode).toBe(0);
    expect(provider.requests.map((request) => request.model)).toEqual(["typesafe/jev-1.13"]);
    expect(output.join("\n").split("\n")[0]).toBe(
      "payments bug     now       (unsure: urgency) Checkout charges twice",
    );
  });
});
