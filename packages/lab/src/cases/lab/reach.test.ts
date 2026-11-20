import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrialLine } from "../format/trial-file";
import { blame } from "./blame";
import { checkReach, covers, type ReachInput } from "./reach";
import { ENGINE_HOSTS } from "./trial-settings";

const box = (key: string, spec: object = {}) => ({
  key,
  provider: "srt" as const,
  spec: { srt: {}, cwd: "/x", ...spec } as ReachInput["sandboxes"][number]["spec"],
});
const reach = (input: Partial<ReachInput>) =>
  checkReach({ opened: [], named: [], sandboxes: [], agentReach: { network: [] }, ...input });

describe("checkReach", () => {
  test("an agent with no sandbox", () => {
    const seen = reach({ opened: [{ agent: "reader", harness: "claude" }] });
    expect(seen.ok).toBe(false);
    expect(seen.problems).toEqual(["agent reader ran with no sandbox"]);
  });

  test("an agent in the run's sessions or turns with no agent-opened line", () => {
    const seen = reach({ named: ["ghost"] });
    expect(seen.problems[0]).toContain("ghost has no agent-opened line");
  });

  test("a network domain agentReach doesn't list; a model domain the harness added passes", () => {
    const opened = [
      { agent: "reader", harness: "claude", sandbox: "b", domains: ["api.anthropic.com"] },
    ];
    expect(reach({ opened, sandboxes: [box("b", { network: ["api.anthropic.com"] })] }).ok).toBe(
      true,
    );
    const wider = reach({ opened, sandboxes: [box("b", { network: ["evil.example.com"] })] });
    expect(wider.problems).toEqual([
      "sandbox b reaches evil.example.com, which agentReach doesn't list",
    ]);
  });

  test("*.x covers a.x and *.a.x, never x", () => {
    expect(covers("*.x.com", "a.x.com")).toBe(true);
    expect(covers("*.x.com", "*.a.x.com")).toBe(true);
    expect(covers("*.x.com", "x.com")).toBe(false);
    expect(covers("x.com", "a.x.com")).toBe(false);
    const sandboxes = [box("b", { network: ["x.com"] })];
    expect(reach({ sandboxes, agentReach: { network: ["*.x.com"] } }).ok).toBe(false);
    expect(reach({ sandboxes, agentReach: { network: ["x.com"] } }).ok).toBe(true);
  });

  test("web search, unless agentReach allows it; a cursor agent counts as web search", () => {
    expect(reach({ sandboxes: [box("b", { webSearch: true })] }).ok).toBe(false);
    expect(
      reach({
        sandboxes: [box("b", { webSearch: true })],
        agentReach: { network: [], webSearch: true },
      }).ok,
    ).toBe(true);
    const cursor = reach({
      opened: [{ agent: "c", harness: "cursor", sandbox: "b" }],
      sandboxes: [box("b")],
    });
    expect(cursor.problems[0]).toContain("cursor, which keeps its web tools");
  });

  test("an agent in a sandbox no sandbox-opened line or record names: reach unknown", () => {
    const opened = [{ agent: "reader", harness: "claude", sandbox: "ghost" }];
    const seen = reach({ opened, sandboxes: [box("b")] });
    expect(seen.ok).toBe(false);
    expect(seen.problems).toEqual([
      "agent reader ran in sandbox ghost, which the run's records never open, so its reach is unknown",
    ]);
    expect(reach({ opened, sandboxes: [box("ghost")] }).ok).toBe(true);
  });

  test("sockets, unless agentReach allows them; they are listed either way", () => {
    const sandboxes = [box("b", { sockets: ["/tmp/browser.sock"] })];
    const refused = reach({ sandboxes });
    expect(refused.ok).toBe(false);
    expect(refused.sockets).toEqual(["/tmp/browser.sock"]);
    const allowed = reach({ sandboxes, agentReach: { network: [], sockets: true } });
    expect(allowed.ok).toBe(true);
    expect(allowed.sockets).toEqual(["/tmp/browser.sock"]);
  });
});

const ending = { stderr: "", loginRefused: false };

describe("blame", () => {
  test("an error or a timeout is the workflow's only in the body", () => {
    const setup: TrialLine[] = [{ phase: "setup" }, { timedOut: "setup" }];
    expect(blame(setup, { ...ending, outcome: "failed", reason: "x" }).errored).toMatchObject({
      by: "dataset",
      phase: "setup",
      code: "timed-out",
    });
    const body: TrialLine[] = [{ phase: "setup" }, { phase: "body" }, { timedOut: "body" }];
    expect(blame(body, { ...ending, outcome: "failed", reason: "x" }).workflowError).toBe(
      "timed out in body",
    );
  });

  test("facts written after a timeout are ignored", () => {
    const lines: TrialLine[] = [
      { phase: "body" },
      { timedOut: "body" },
      { end: { facts: { ok: true }, stages: {}, given: [] } },
    ];
    const blamed = blame(lines, { ...ending, outcome: "timed-out", reason: "x" });
    expect(blamed.facts).toBeUndefined();
    expect(blamed.workflowError).toBe("timed out in body");
  });

  test("a run that died before the trial file's first line is the dataset's, with its stderr", () => {
    const blamed = blame([], { ...ending, stderr: "SyntaxError: in env.ts\n" });
    expect(blamed.errored).toMatchObject({ by: "dataset", phase: "setup" });
    expect(blamed.errored?.reason).toContain("SyntaxError");
  });

  test("an engine timed-out with no line of its own is blamed by the last phase recorded", () => {
    const inObserve = blame([{ phase: "observe" }], {
      ...ending,
      outcome: "timed-out",
      reason: "deadline",
    });
    expect(inObserve.errored).toMatchObject({ by: "dataset", phase: "observe", code: "timed-out" });
    const inBody = blame([{ phase: "body" }], {
      ...ending,
      outcome: "timed-out",
      reason: "deadline",
    });
    expect(inBody.workflowError).toBe("deadline");
  });

  test("a stop after until is graded from the trial file", () => {
    const lines: TrialLine[] = [
      { phase: "body" },
      { end: { facts: { ok: true }, stages: { spec: 1 }, given: [], until: "spec" } },
      { stopped: { reason: "stopped" } },
    ];
    const blamed = blame(lines, { ...ending, outcome: "stopped", reason: "stopped" });
    expect(blamed.stopped).toBeUndefined();
    expect(blamed.facts).toEqual({ ok: true });
  });

  test("a non-empty error fact fails the trial as the workflow's", () => {
    const blamed = blame([{ phase: "observe" }], {
      ...ending,
      outcome: "completed",
      value: {
        facts: { error: "the reader failed" },
        stages: {},
        given: [],
        unused: [],
        refused: [],
      },
    });
    expect(blamed.workflowError).toBe("the reader failed");
  });

  test("the login refusal is the provider's", () => {
    const blamed = blame([{ phase: "body" }], {
      ...ending,
      loginRefused: true,
      outcome: "failed",
      reason: "log in",
    });
    expect(blamed.errored).toMatchObject({ by: "provider", code: "login" });
  });

  test("a dataset error wins over the workflow's, whatever their order: teardown throwing after the body failed", () => {
    // What a trial file holds when the body threw and a cleanup then threw too.
    const lines: TrialLine[] = [
      { phase: "setup" },
      { phase: "body" },
      { workflow: { name: "throws" } },
      { error: { by: "workflow", phase: "body", reason: "the workflow broke" } },
      { unused: [] },
      { phase: "teardown" },
      {
        error: {
          by: "dataset",
          phase: "teardown",
          code: "threw",
          reason: "teardown broke: db container left running",
        },
      },
    ];
    const blamed = blame(lines, { ...ending, outcome: "failed", reason: "the workflow broke" });
    expect(blamed.errored).toEqual({
      by: "dataset",
      phase: "teardown",
      code: "threw",
      reason: "teardown broke: db container left running",
    });
    expect(blamed.workflowError).toBeUndefined();
  });

  test("a cancelled run is the lab's, by its trial file or by the engine's outcome alone", () => {
    const lines: TrialLine[] = [
      { phase: "setup" },
      { phase: "body" },
      { cancelled: "body" },
      { phase: "teardown" },
    ];
    expect(blame(lines, { ...ending }).errored).toMatchObject({ by: "lab", phase: "body" });
    const byOutcome = blame([{ phase: "body" }], {
      ...ending,
      outcome: "cancelled",
      reason: "cancelled by SIGTERM",
    });
    expect(byOutcome.errored).toMatchObject({ by: "lab", phase: "body" });
    expect(byOutcome.errored?.reason).toContain("cancelled");
    expect(byOutcome.workflowError).toBeUndefined();
  });

  test("an exit in the body short of the deadline reads as the run's ending, never a timeout", () => {
    const lines: TrialLine[] = [{ phase: "setup" }, { phase: "body" }, { exited: "body" }];
    const blamed = blame(lines, { ...ending, outcome: "failed", reason: "process exited 3" });
    expect(blamed.workflowError).toBe("process exited 3");
    expect(blamed.errored).toBeUndefined();
  });
});

test("ENGINE_HOSTS holds the host of the engine's decision provider", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../../../engine/src/decisions/openrouter.ts"),
    "utf8",
  );
  const url = /OPENROUTER_DECISIONS = "([^"]+)"/.exec(source)?.[1];
  expect(url).toBeDefined();
  expect(ENGINE_HOSTS as readonly string[]).toContain(new URL(url!).hostname);
});
