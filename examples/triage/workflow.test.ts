import { describe, expect, test } from "bun:test";
import { testWorkflow } from "@agentswf/engine/workflow-testing";
import triage from "./workflow";

const tickets = [
  "Checkout charges twice",
  "Please add dark mode",
  "Something about my account is off",
];

describe("triage", () => {
  test("takes the confident answers and flags the rest; a confident no is as good as a yes", async () => {
    const run = await testWorkflow(
      triage,
      { tickets },
      {
        decisions: {
          "triage:1": {
            team: { payments: 0.95, accounts: 0.03, frontend: 0.02 },
            bug: 0.97,
            urgency: [0.1, 0.3, 0.6],
          },
          "triage:2": { team: "frontend", bug: 0.05, urgency: [0.92, 0.08, 0] },
          "triage:3": {
            team: { payments: 0.4, accounts: 0.5, frontend: 0.1 },
            bug: 0.6,
            urgency: [0.05, 0.9, 0.05],
          },
        },
      },
    );
    expect(run.value).toEqual({
      triaged: [
        { ticket: tickets[0]!, team: "payments", bug: true, urgency: "now", unsure: ["urgency"] },
        { ticket: tickets[1]!, team: "frontend", bug: false, urgency: "later", unsure: [] },
        {
          ticket: tickets[2]!,
          team: "accounts",
          bug: true,
          urgency: "this week",
          unsure: ["team", "bug"],
        },
      ],
    });
    const asked = (key: string) => run.decisions.find((decision) => decision.key === key)?.state;
    expect(tickets.map((_, index) => asked(`triage:${index + 1}`))).toEqual(
      tickets.map((ticket) => ({ ticket })),
    );
    expect(triage.present!(run.value, { kind: "completed", value: run.value, stages: [] })).toBe(
      [
        "payments bug     now       (unsure: urgency) Checkout charges twice",
        "frontend request later     Please add dark mode",
        "accounts bug     this week (unsure: team, bug) Something about my account is off",
      ].join("\n"),
    );
  });

  test("an answer just under 0.9 is unsure, and 0.9 itself is sure", async () => {
    const run = await testWorkflow(
      triage,
      { tickets: ["t"] },
      {
        decisions: {
          "triage:1": {
            team: { payments: 0.89, accounts: 0.11, frontend: 0 },
            bug: 0.9,
            urgency: [0, 0.1, 0.9],
          },
        },
      },
    );
    expect(run.value.triaged[0]).toMatchObject({ team: "payments", unsure: ["team"] });
  });

  test("with no tickets named, it triages the samples", () => {
    const { tickets: samples } = triage.prepare({ argv: [], cwd: "." });
    expect(samples.length).toBeGreaterThan(0);
    expect(triage.prepare({ argv: ["one"], cwd: "." })).toEqual({ tickets: ["one"] });
  });

  test("a decision that fails fails the triage", async () => {
    const run = await testWorkflow(
      triage,
      { tickets: ["t"] },
      {
        decisions: { "triage:*": new Error("OpenRouter is down") },
      },
    );
    expect(() => run.value).toThrow("OpenRouter is down");
  });
});
