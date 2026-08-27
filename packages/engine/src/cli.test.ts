import { describe, expect, test } from "bun:test";
import { runCli } from "./cli";
import { readAccepted, readAttempts, writeCall } from "./run-dir";
import type { SemanticCheck } from "@wf/contract";
import { COUNT_SCHEMA, tempRunDir } from "./testing";

const CALL = "call-1";

async function withCall(): Promise<{ runDir: string; env: Record<string, string> }> {
  const runDir = tempRunDir();
  await writeCall(runDir, {
    callId: CALL,
    question: "how many e's",
    schema: COUNT_SCHEMA,
  });
  return { runDir, env: { WF_RUN: runDir, WF_CALL: CALL } };
}

describe("wf result", () => {
  test("a valid value is accepted, recorded, and reported on stdout", async () => {
    const { runDir, env } = await withCall();

    const outcome = await runCli(["result", '{"count":3,"even":false}'], env);

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).toContain("accepted");
    expect(await readAccepted(runDir, CALL)).toEqual({ value: { count: 3, even: false } });
  });

  test("a value that fails the schema exits nonzero and names the field", async () => {
    const { env } = await withCall();

    const outcome = await runCli(["result", '{"count":"3","even":false}'], env);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("value.count: expected an integer");
    expect(outcome.stderr).toContain("run wf result again");
  });

  test("a rejected value is never coerced into an accepted one", async () => {
    const { runDir, env } = await withCall();

    await runCli(["result", '{"count":"3","even":"false"}'], env);

    expect(await readAccepted(runDir, CALL)).toBeNull();
  });

  test("a rejected attempt is recorded, so a silent agent and a refused one differ", async () => {
    const { runDir, env } = await withCall();

    await runCli(["result", '{"count":-1,"even":true}'], env);

    const attempts = await readAttempts(runDir, CALL);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.accepted).toBe(false);
    expect(attempts[0]?.error).toContain("expected at least 0");
  });

  test("output that is not JSON is refused with the shape that was wanted", async () => {
    const { env } = await withCall();

    const outcome = await runCli(["result", "the count is 3"], env);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("not valid JSON");
    expect(outcome.stderr).toContain('"count"');
  });

  test("an argument split by the shell is refused rather than rejoined", async () => {
    const { runDir, env } = await withCall();

    const outcome = await runCli(["result", '{"count":', '3,', '"even":', "true}"], env);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("Quote the JSON");
    expect(await readAccepted(runDir, CALL)).toBeNull();
  });

  // Rejoining made this parse as {"msg":"a b"} and accepted it: valid JSON, wrong value.
  test("rejoining would have silently collapsed whitespace inside a string", async () => {
    const { runDir, env } = await withCall();

    const outcome = await runCli(["result", '{"msg":', '"a', 'b"}'], env);

    expect(outcome.exitCode).toBe(2);
    expect(await readAccepted(runDir, CALL)).toBeNull();
  });

  test("a shell with no call in its environment says so rather than guessing one", async () => {
    const outcome = await runCli(["result", "{}"], {});

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("WF_RUN and WF_CALL");
  });

  test("an unrecorded call is refused rather than accepted into an empty directory", async () => {
    const runDir = tempRunDir();

    const outcome = await runCli(["result", "{}"], { WF_RUN: runDir, WF_CALL: "nope" });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("no call nope");
  });

  test("an empty argument prints the shape instead of accepting nothing", async () => {
    const { env } = await withCall();

    const outcome = await runCli(["result"], env);

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("needs one JSON argument");
  });

  test("any other command prints usage", async () => {
    const outcome = await runCli(["ship-it"], {});

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("wf result");
  });
});

describe("the semantic seam", () => {
  const rejecting: SemanticCheck = async () => ({
    kind: "rejected",
    reason: "the count is for a different string",
  });

  test("a schema-valid value the checker refuses does not become a result", async () => {
    const { runDir, env } = await withCall();

    const outcome = await runCli(["result", '{"count":3,"even":false}'], env, rejecting);

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("does not answer what was asked");
    expect(outcome.stderr).toContain("different string");
    expect(await readAccepted(runDir, CALL)).toBeNull();
  });

  test("the checker sees the question recorded with the call, not the prompt", async () => {
    const { env } = await withCall();
    const seen: string[] = [];

    await runCli(["result", '{"count":3,"even":false}'], env, async ({ question }) => {
      seen.push(question);
      return { kind: "accepted" };
    });

    expect(seen).toEqual(["how many e's"]);
  });
});
