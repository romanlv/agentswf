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

describe("examples/triage", () => {
  test("asks one decision per ticket, takes the confident answers and flags the rest", async () => {
    const reply =
      (yes: number, team: [number, number, number], urgency: [number, number, number]) =>
      async () => ({
        snapshot: "typesafe/jev-1.13-20260917",
        answers: {
          team: {
            type: "choice" as const,
            probabilities: { payments: team[0], accounts: team[1], frontend: team[2] },
          },
          bug: { type: "yes-no" as const, yes },
          urgency: { type: "score" as const, probabilities: urgency },
        },
        tokens: { input: 400, output: 20 },
      });
    const provider = createFakeDecisionProvider([
      reply(0.97, [0.95, 0.03, 0.02], [0.1, 0.3, 0.6]),
      reply(0.05, [0, 0.02, 0.98], [0.92, 0.08, 0]),
      reply(0.6, [0.4, 0.5, 0.1], [0.05, 0.9, 0.05]),
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
        "Please add dark mode",
        "Something about my account is off",
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
    expect(provider.requests.map((request) => request.state)).toEqual([
      { ticket: "Checkout charges twice" },
      { ticket: "Please add dark mode" },
      { ticket: "Something about my account is off" },
    ]);
    expect(Object.keys(provider.requests[0]!.questions)).toEqual(["team", "bug", "urgency"]);
    // A confident no is as good as a confident yes; only the middle is unsure.
    expect(output.join("\n").split("\n").slice(0, 3)).toEqual([
      "payments bug     now       (unsure: urgency) Checkout charges twice",
      "frontend request later     Please add dark mode",
      "accounts bug     this week (unsure: team, bug) Something about my account is off",
    ]);
  });
});
