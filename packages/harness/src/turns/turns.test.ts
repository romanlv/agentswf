import { expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESSES } from "../spec";
import { createClaudeReceiptReducer } from "./claude";
import { codexTurnPlace, createCodexTurnReducer } from "./codex";
import { prepareTurnRecord, type TurnReading, type TurnReducer } from "./record";

const MARKER = "[awf-delivery:fixture]";
const LEAD = "Do what the pasted text below asks. ";

function rows(name: string): unknown[] {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

function read(reducer: TurnReducer, values: readonly unknown[]): TurnReading[] {
  return values.map((value) => reducer.push(value));
}

test.each([
  ["claude-2.1.317-turn.jsonl", "completed"],
  ["claude-2.1.317-interrupted.jsonl", "interrupted"],
] as const)("claude's %s ends its turn %s", (fixture, how) => {
  const readings = read(createClaudeReceiptReducer(MARKER, LEAD), rows(fixture));
  const last = readings.at(-1)!;
  expect(last).toEqual({ accepted: true, received: true, ended: how });
  // Only its last row ends it.
  expect(readings.slice(0, -1).some((reading) => reading.ended)).toBe(false);
});

test.each([
  ["codex-0.166-turn.jsonl", "completed"],
  ["codex-0.166-interrupted.jsonl", "interrupted"],
] as const)("codex's %s ends its turn %s", (fixture, how) => {
  const readings = read(createCodexTurnReducer(MARKER), rows(fixture));
  expect(readings.at(-1)).toEqual({ accepted: true, received: true, ended: how });
  expect(readings.slice(0, -1).some((reading) => reading.ended)).toBe(false);
});

test("a queued prompt is not ended by the turn before it, which claude ends first", () => {
  const reducer = createClaudeReceiptReducer(MARKER);
  reducer.push({ type: "queue-operation", operation: "enqueue", content: `${MARKER} go` });
  expect(reducer.push({ type: "system", subtype: "turn_duration" }).ended).toBeUndefined();
  reducer.push({
    type: "attachment",
    uuid: "q1",
    attachment: {
      type: "queued_command",
      commandMode: "prompt",
      humanTurn: true,
      origin: { kind: "human" },
      prompt: `${MARKER} go`,
    },
  });
  expect(reducer.push({ type: "system", subtype: "turn_duration" }).ended).toBe("completed");
});

test("a turn its API refused, whose answer is synthetic, still ends at its turn_duration", () => {
  const reducer = createClaudeReceiptReducer(MARKER);
  reducer.push({ type: "user", uuid: "u1", message: { content: `${MARKER} go` } });
  const refused = reducer.push({
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    isApiErrorMessage: true,
    message: { role: "assistant", model: "<synthetic>" },
  });
  expect(refused.received).toBe(false);
  expect(reducer.push({ type: "system", subtype: "turn_duration" })).toEqual({
    accepted: true,
    received: false,
    ended: "completed",
  });
});

test("a sidechain's end, a subagent's, does not end claude's turn", () => {
  const reducer = createClaudeReceiptReducer(MARKER);
  reducer.push({ type: "user", uuid: "u1", message: { content: `${MARKER} go` } });
  reducer.push({
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    message: { role: "assistant", model: "m" },
  });
  const sidechain = { type: "system", subtype: "turn_duration", isSidechain: true };
  expect(reducer.push(sidechain).ended).toBeUndefined();
});

test("a long turn past its answer is read for its end without the ancestry bound", () => {
  const reducer = createClaudeReceiptReducer(MARKER);
  reducer.push({ type: "user", uuid: "u1", message: { content: `${MARKER} go` } });
  reducer.push({
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    message: { role: "assistant", model: "m" },
  });
  for (let i = 0; i < 5000; i++) reducer.push({ type: "assistant", uuid: `r${i}` });
  expect(reducer.push({ type: "system", subtype: "turn_duration" }).ended).toBe("completed");
});

test("codex's end of another turn does not end the one its prompt began", () => {
  const reducer = createCodexTurnReducer(MARKER);
  reducer.push({
    type: "event_msg",
    payload: {
      type: "item_completed",
      turn_id: "t2",
      item: { type: "UserMessage", content: [{ text: `${MARKER} go` }] },
    },
  });
  const other = { type: "event_msg", payload: { type: "task_complete", turn_id: "t1" } };
  expect(reducer.push(other).ended).toBeUndefined();
  const own = { type: "event_msg", payload: { type: "task_complete", turn_id: "t2" } };
  expect(reducer.push(own).ended).toBe("completed");
});

test("a codex rollout written after the watch starts is found by its marker and names its session", async () => {
  const home = mkdtempSync(join(tmpdir(), "awf-turn-codex-"));
  try {
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const day = join(
      home,
      "sessions",
      `${now.getFullYear()}`,
      pad(now.getMonth() + 1),
      pad(now.getDate()),
    );
    mkdirSync(day, { recursive: true });
    // A session already open, and another agent's, both hold rows from before.
    writeFileSync(join(day, "rollout-2026-11-03T09-00-00-other.jsonl"), '{"type":"event_msg"}\n');
    const record = await prepareTurnRecord(codexTurnPlace(Date.now(), home), MARKER, () =>
      createCodexTurnReducer(MARKER),
    );
    const id = "01a1a31a-7aad-7901-922d-9e5f4766e353";
    const file = join(day, `rollout-2026-11-03T20-29-44-${id}.jsonl`);
    const ended: string[] = [];
    let accepted = 0;
    const watching = record.watch(AbortSignal.timeout(5_000), {
      accepted: () => {
        accepted += 1;
      },
      received: () => {},
      ended: (how, name) => {
        ended.push(how, HARNESSES.codex.turnRecord!.session(name)!);
      },
    });
    for (const row of rows("codex-0.166-turn.jsonl")) {
      appendFileSync(file, `${JSON.stringify(row)}\n`);
      await Bun.sleep(5);
    }
    await watching;
    expect(accepted).toBe(1);
    expect(ended).toEqual(["completed", id]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("claude's transcript names its session by its file", () => {
  expect(HARNESSES.claude.turnRecord!.session("0d258b2b-ba3d-4009-9eaf-01e74b6e4844.jsonl")).toBe(
    "0d258b2b-ba3d-4009-9eaf-01e74b6e4844",
  );
});

test("past its answer, a row too long to hold is skipped, and the turn's end still read", async () => {
  const home = mkdtempSync(join(tmpdir(), "awf-turn-long-"));
  try {
    const record = HARNESSES.claude.turnRecord!;
    const place = await record.place("/probe", Date.now(), home, "s1");
    mkdirSync(place.root, { recursive: true });
    const file = join(place.root, "s1.jsonl");
    writeFileSync(file, "");
    const watching = await prepareTurnRecord(place, MARKER, () => record.reducer(MARKER, LEAD));
    let ended: string | undefined;
    const done = watching.watch(AbortSignal.timeout(10_000), {
      accepted: () => {},
      received: () => {},
      ended: (how) => {
        ended = how;
      },
    });
    const head = rows("claude-2.1.317-turn.jsonl").slice(0, -1);
    appendFileSync(file, head.map((row) => `${JSON.stringify(row)}\n`).join(""));
    await Bun.sleep(300);
    // An image read into the transcript: one row of 9 MiB.
    const image = {
      type: "user",
      message: { content: [{ type: "image", data: "x".repeat(9 << 20) }] },
    };
    appendFileSync(file, `${JSON.stringify(image)}\n`);
    appendFileSync(file, `${JSON.stringify({ type: "system", subtype: "turn_duration" })}\n`);
    await done;
    expect(ended).toBe("completed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
