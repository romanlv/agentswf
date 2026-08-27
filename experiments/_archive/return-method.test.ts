import { describe, expect, test } from "bun:test";
import { runCli } from "./deps";
import {
  collect,
  instructions,
  nudge,
  RESULT_END,
  RESULT_START,
  type MethodContext,
  writeE2Call,
} from "./return-method";
import { COUNT_SCHEMA, tempRunDir } from "./deps";
import type { ReturnMethod } from "./deps";

const CALL = "call-1";

async function context(method: ReturnMethod): Promise<MethodContext> {
  const runDir = tempRunDir();
  const filePath = `${runDir}/agent-result.json`;
  await writeE2Call(runDir, {
    callId: CALL,
    question: "how many e's",
    method,
    schema: COUNT_SCHEMA,
    ...(method === "write-a-file" ? { filePath } : {}),
  });
  return { runDir, callId: CALL, filePath, schema: COUNT_SCHEMA };
}

describe("instructions", () => {
  test("the callback names the command and the shape", async () => {
    const text = instructions("cli-callback", await context("cli-callback"));

    expect(text).toContain("wf result '<json>'");
    expect(text).toContain("{ count: integer, even: boolean }");
  });

  test("the file method names the exact path", async () => {
    const ctx = await context("write-a-file");

    expect(instructions("write-a-file", ctx)).toContain(ctx.filePath);
  });

  test("the delimited method names both markers", async () => {
    const text = instructions("delimited-line", await context("delimited-line"));

    expect(text).toContain(RESULT_START);
    expect(text).toContain(RESULT_END);
  });
});

describe("nudge", () => {
  test("without a rejection it just asks for the report on the same channel", async () => {
    const text = nudge("cli-callback", await context("cli-callback"));

    expect(text).toContain("finished without reporting");
    expect(text).toContain("wf result");
  });

  test("with a rejection it carries the validation error the agent has to fix", async () => {
    const text = nudge("write-a-file", await context("write-a-file"), "value.count: expected an integer");

    expect(text).toContain("value.count: expected an integer");
    expect(text).toContain("agent-result.json");
  });
});

describe("collect cli-callback", () => {
  test("a value the CLI accepted is found", async () => {
    const ctx = await context("cli-callback");
    await runCli(["result", '{"count":3,"even":false}'], { WF_RUN: ctx.runDir, WF_CALL: CALL });

    expect(await collect("cli-callback", ctx, null)).toEqual({
      kind: "value",
      value: { count: 3, even: false },
    });
  });

  test("an agent that never called back reads as absent, not as an empty result", async () => {
    const ctx = await context("cli-callback");

    expect(await collect("cli-callback", ctx, null)).toEqual({ kind: "absent" });
  });

  test("an agent the CLI refused reads as malformed and keeps the error", async () => {
    const ctx = await context("cli-callback");
    await runCli(["result", '{"count":"3"}'], { WF_RUN: ctx.runDir, WF_CALL: CALL });

    const collected = await collect("cli-callback", ctx, null);

    expect(collected.kind).toBe("malformed");
    expect(collected.kind === "malformed" && collected.error).toContain("value.count");
  });
});

describe("collect write-a-file", () => {
  test("a file holding a valid value is accepted", async () => {
    const ctx = await context("write-a-file");
    await Bun.write(ctx.filePath, '{"count":3,"even":false}');

    expect(await collect("write-a-file", ctx, null)).toEqual({
      kind: "value",
      value: { count: 3, even: false },
    });
  });

  test("no file at the path is absent", async () => {
    const ctx = await context("write-a-file");

    expect(await collect("write-a-file", ctx, null)).toEqual({ kind: "absent" });
  });

  test("prose in the file is malformed, and the same result layer says why", async () => {
    const ctx = await context("write-a-file");
    await Bun.write(ctx.filePath, "the count is three");

    const collected = await collect("write-a-file", ctx, null);

    expect(collected.kind).toBe("malformed");
    expect(collected.kind === "malformed" && collected.error).toContain("not valid JSON");
  });
});

describe("collect delimited-line", () => {
  test("a marked block in the transcript is accepted", async () => {
    const ctx = await context("delimited-line");
    const transcript = `thinking...\n${RESULT_START}\n{"count":3,"even":false}\n${RESULT_END}\ndone`;

    expect(await collect("delimited-line", ctx, transcript)).toEqual({
      kind: "value",
      value: { count: 3, even: false },
    });
  });

  test("the last block wins, so a corrected value beats the one it replaced", async () => {
    const ctx = await context("delimited-line");
    const transcript = [
      `${RESULT_START}\n{"count":"3","even":false}\n${RESULT_END}`,
      `${RESULT_START}\n{"count":3,"even":false}\n${RESULT_END}`,
    ].join("\n");

    expect(await collect("delimited-line", ctx, transcript)).toEqual({
      kind: "value",
      value: { count: 3, even: false },
    });
  });

  test("a transcript the backend could not read is absent, never a value", async () => {
    const ctx = await context("delimited-line");

    expect(await collect("delimited-line", ctx, null)).toEqual({ kind: "absent" });
  });

  test("an unterminated block is absent rather than half-parsed", async () => {
    const ctx = await context("delimited-line");

    expect(await collect("delimited-line", ctx, `${RESULT_START}\n{"count":3`)).toEqual({
      kind: "absent",
    });
  });
});
