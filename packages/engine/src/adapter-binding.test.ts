import { afterAll, expect, test } from "bun:test";
import { createFakeAdapter } from "@agentswf/harness/testing";
import { createResultSlotRegistry } from "./result-slots";
import { readAccepted } from "./runs";
import { COUNT_SCHEMA, createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
const { tempRunDir } = runDirs;
afterAll(() => runDirs.cleanup());

test("a delayed command from one turn cannot settle the next turn on the same agent", async () => {
  const runDir = tempRunDir();
  const slots = createResultSlotRegistry({ runDir });
  const deadline = { unixMilliseconds: Date.now() + 60_000 };
  const first = await slots.open({
    operationId: "op-1",
    agentId: "reviewer",
    question: "first",
    schema: COUNT_SCHEMA,
    deadline,
  });
  const adapter = createFakeAdapter({ script: () => ({ state: "completed" }) });
  const session = await adapter.activate({
    key: "reviewer",
    deadline,
    cwd: "/repo",
    execution: { harness: "fake", model: "fake" },
  });
  const firstTurn = await session.start(
    { id: "turn-1", prompt: "first", deadline },
    { endpoint: "/private/engine.sock", operationId: first.operationId },
  );
  await firstTurn.settled;
  await slots.close(first.operationId);

  await slots.open({
    operationId: "op-2",
    agentId: "reviewer",
    question: "second",
    schema: COUNT_SCHEMA,
    deadline,
  });
  const secondTurn = await firstTurn.nudge({
    id: "turn-1:nudge",
    prompt: "second",
    deadline,
  });
  await secondTurn.settled;

  // Replayed from the binding the adapter actually gave the first turn, not from a literal: a
  // nudge that was handed a fresh binding would point this at `op-2`, and it would be accepted.
  const delayed = adapter.turns[0]?.binding;
  if (!delayed) throw new Error("the first turn was given no binding to replay");
  await expect(
    slots.submit({
      operationId: delayed.operationId,
      agentId: "reviewer",
      raw: '{"count":1,"even":false}',
      source: "delayed-first-turn-command",
    }),
  ).resolves.toMatchObject({ kind: "rejected", code: "closed-operation" });
  expect(await readAccepted(runDir, "op-2")).toBeNull();
  expect(delayed.operationId).toBe("op-1");
  // The nudge continues the same operation, so it carries no binding of its own to replay.
  expect(adapter.turns[1]?.binding?.operationId ?? delayed.operationId).toBe("op-1");
});
