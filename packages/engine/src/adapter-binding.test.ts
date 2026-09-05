import { afterAll, expect, test } from "bun:test";
import { createFakeAdapter } from "@wf/harness/testing";
import { readAccepted } from "./run-dir";
import { createResultSlotRegistry } from "./result-slots";
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
    { endpoint: "/private/engine.sock", operationId: "op-1", capability: first.capability },
  );
  await firstTurn.settled;
  await slots.close(first.capability);

  await slots.open({
    operationId: "op-2",
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

  await expect(
    slots.submit({
      operationId: "op-1",
      capability: first.capability,
      raw: '{"count":1,"even":false}',
      source: "delayed-first-turn-command",
    }),
  ).resolves.toMatchObject({ kind: "rejected", code: "closed-capability" });
  expect(await readAccepted(runDir, "op-2")).toBeNull();
  expect(adapter.turns[0]?.binding?.capability).toBe(first.capability);
  expect(adapter.turns[1]?.binding?.capability).toBe(first.capability);
});
