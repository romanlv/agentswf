import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeReceiptReducer, prepareClaudeReceipt } from "./claude-receipt";

const marker = "[awf-delivery:test]";
const user = (uuid = "input") => ({
  type: "user",
  uuid,
  message: { content: `${marker} question` },
});
const assistant = (parentUuid: string, model = "claude") => ({
  type: "assistant",
  uuid: "answer",
  parentUuid,
  message: { role: "assistant", model, content: [{ type: "tool_use", name: "Bash" }] },
});

test("native enqueue proves acceptance but linked model output proves receipt", () => {
  const reader = createClaudeReceiptReducer(marker);
  expect(
    reader.push({ type: "queue-operation", operation: "enqueue", content: `${marker} question` }),
  ).toEqual({ accepted: true, received: false });
  expect(reader.push(assistant("unrelated"))).toEqual({ accepted: true, received: false });
});

test("user input ancestry includes attachment and system rows, without timestamp ordering", () => {
  const reader = createClaudeReceiptReducer(marker);
  reader.push(user());
  reader.push({ type: "system", uuid: "system", parentUuid: "input", timestamp: "later" });
  reader.push({ type: "attachment", uuid: "reminder", parentUuid: "system", timestamp: "earlier" });
  expect(reader.push(assistant("reminder"))).toEqual({ accepted: true, received: true });
});

test("a human queued command is consumed without a user row", () => {
  const reader = createClaudeReceiptReducer(marker);
  expect(
    reader.push({
      type: "attachment",
      uuid: "queued",
      parentUuid: "old-tool-result",
      attachment: {
        type: "queued_command",
        prompt: `${marker} question`,
        commandMode: "prompt",
        humanTurn: true,
        origin: { kind: "human" },
        source_uuid: "other",
        delivery_id: "native",
        timestamp: "before append",
      },
    }),
  ).toEqual({ accepted: true, received: false });
  reader.push({ type: "attachment", uuid: "reminder", parentUuid: "queued" });
  expect(reader.push(assistant("reminder"))).toEqual({ accepted: true, received: true });
});

test("echoes, tool results, synthetic errors, sidechains and missing ancestry are not receipt", () => {
  for (const row of [
    {
      type: "user",
      uuid: "input",
      message: { content: [{ type: "tool_result", content: marker }] },
    },
    { ...user(), isSidechain: true },
    { type: "attachment", uuid: "input", attachment: { type: "queued_command", prompt: marker } },
    { type: "assistant", uuid: "input", message: { content: marker } },
  ]) {
    const reader = createClaudeReceiptReducer(marker);
    reader.push(row);
    expect(reader.push(assistant("input"))).toEqual({ accepted: false, received: false });
  }
  const reader = createClaudeReceiptReducer(marker);
  reader.push(user());
  expect(reader.push(assistant("input", "<synthetic>"))).toEqual({
    accepted: true,
    received: false,
  });
  expect(reader.push({ ...assistant("missing"), uuid: "other" })).toEqual({
    accepted: true,
    received: false,
  });
});

test("ancestry is bounded and cycles cannot prove receipt", () => {
  const reader = createClaudeReceiptReducer(marker);
  reader.push({ uuid: "a", parentUuid: "b" });
  reader.push({ uuid: "b", parentUuid: "a" });
  expect(reader.push(assistant("a")).received).toBe(false);
  for (let i = 0; i < 4093; i++) reader.push({ uuid: `row-${i}` });
  expect(() => reader.push({ uuid: "overflow" })).toThrow("ancestry exceeds");
});

test("watch skips old history, buffers a partial UTF-8 row and stops at linked receipt", async () => {
  const home = await mkdtemp(join(tmpdir(), "awf-receipt-"));
  const cwd = "/probe";
  const directory = join(home, "projects", "-probe");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "session.jsonl");
  const old = `${JSON.stringify(user("old"))}\n${JSON.stringify(assistant("old"))}\n`;
  await writeFile(path, old);
  try {
    const receipt = await prepareClaudeReceipt(cwd, marker, home, { sessionRef: "session" });
    const controller = new AbortController();
    const input = JSON.stringify({ ...user("new"), message: { content: `${marker} café` } });
    const bytes = Buffer.from(input);
    const split = bytes.indexOf(Buffer.from("é")) + 1;
    let accepted = 0;
    let received = 0;
    // The poll starts with a partial row; acceptance cannot come from the pre-baseline pair.
    await appendFile(path, bytes.subarray(0, split));
    let scanned!: () => void;
    const partialScanned = new Promise<void>((resolve) => {
      scanned = resolve;
    });
    let resume!: (again: boolean) => void;
    const resumed = new Promise<boolean>((resolve) => {
      resume = resolve;
    });
    const watching = receipt.watch(
      controller.signal,
      () => {
        accepted++;
      },
      () => {
        received++;
      },
      async () => {
        scanned();
        return resumed;
      },
    );
    await partialScanned;
    expect(accepted).toBe(0);
    await appendFile(
      path,
      Buffer.concat([
        bytes.subarray(split),
        Buffer.from(`\n${JSON.stringify({ ...assistant("new"), uuid: "fresh" })}\n`),
      ]),
    );
    resume(true);
    await watching;
    expect(accepted).toBe(1);
    expect(received).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("replaced or truncated baseline fails closed", async () => {
  const home = await mkdtemp(join(tmpdir(), "awf-receipt-"));
  const directory = join(home, "projects", "-probe");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "session.jsonl");
  try {
    await writeFile(path, `${JSON.stringify(user())}\n`);
    const receipt = await prepareClaudeReceipt("/probe", marker, home, { sessionRef: "session" });
    await writeFile(path, "");
    await expect(
      receipt.watch(
        new AbortController().signal,
        () => {},
        () => {},
      ),
    ).rejects.toThrow("truncated");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("new empty transcripts cannot grow receipt history without bound", async () => {
  const home = await mkdtemp(join(tmpdir(), "awf-receipt-"));
  const directory = join(home, "projects", "-probe");
  await mkdir(directory, { recursive: true });
  try {
    const receipt = await prepareClaudeReceipt("/probe", marker, home);
    let generation = 0;
    let previous = join(directory, "0.jsonl");
    await writeFile(previous, "");
    await expect(
      receipt.watch(
        new AbortController().signal,
        () => {},
        () => {},
        async () => {
          previous = join(directory, `${++generation}.jsonl`);
          await writeFile(previous, "");
          return true;
        },
      ),
    ).rejects.toThrow("exceeds its bound");
    expect(generation).toBeGreaterThanOrEqual(256);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a symlink cwd observes Claude's canonical project directory", async () => {
  const home = await mkdtemp(join(tmpdir(), "awf-receipt-"));
  try {
    const target = join(home, "target");
    const alias = join(home, "alias");
    await mkdir(target);
    await symlink(target, alias);
    const canonical = await realpath(target);
    const directory = join(home, "projects", canonical.replace(/[^A-Za-z0-9]/g, "-"));
    await mkdir(directory, { recursive: true });
    const receipt = await prepareClaudeReceipt(alias, marker, home);
    await writeFile(
      join(directory, "native.jsonl"),
      `${JSON.stringify(user())}\n${JSON.stringify(assistant("input"))}\n`,
    );
    let received = false;
    await receipt.watch(
      new AbortController().signal,
      () => {},
      () => {
        received = true;
      },
      async () => false,
    );
    expect(received).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("native bracketed paste wrapper preserves marker identity and ancestry", () => {
  const reader = createClaudeReceiptReducer(marker);
  expect(
    reader.push({
      ...user(),
      message: {
        content: `\n\n<pasted_content id="83ad">\n${marker} prompt\n</pasted_content id="83ad">\n\nDo what the text above asks.`,
      },
    }),
  ).toEqual({ accepted: true, received: false });
  expect(reader.push(assistant("input")).received).toBe(true);
  const echo = createClaudeReceiptReducer(marker);
  expect(echo.push({ ...user(), message: { content: `quoted ${marker}` } }).accepted).toBe(false);
});

test("historical cwd sessions do not exhaust the live receipt file budget", async () => {
  const home = await mkdtemp(join(tmpdir(), "awf-receipt-"));
  const directory = join(home, "projects", "-probe");
  await mkdir(directory, { recursive: true });
  try {
    for (let i = 0; i < 300; i++) await writeFile(join(directory, `old-${i}.jsonl`), "");
    const receipt = await prepareClaudeReceipt("/probe", marker, home);
    await writeFile(
      join(directory, "new.jsonl"),
      `${JSON.stringify(user())}\n${JSON.stringify(assistant("input"))}\n`,
    );
    let received = false;
    await receipt.watch(
      new AbortController().signal,
      () => {},
      () => {
        received = true;
      },
      async () => false,
    );
    expect(received).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("known session ignores siblings accumulated since pane launch", async () => {
  const home = await mkdtemp(join(tmpdir(), "awf-receipt-"));
  const directory = join(home, "projects", "-probe");
  await mkdir(directory, { recursive: true });
  try {
    for (let i = 0; i < 300; i++) await writeFile(join(directory, `sibling-${i}.jsonl`), "");
    const path = join(directory, "known.jsonl");
    await writeFile(path, "");
    const receipt = await prepareClaudeReceipt("/probe", marker, home, { sessionRef: "known" });
    await appendFile(path, `${JSON.stringify(user())}\n${JSON.stringify(assistant("input"))}\n`);
    let received = false;
    await receipt.watch(
      new AbortController().signal,
      () => {},
      () => {
        received = true;
      },
      async () => false,
    );
    expect(received).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test.each([true, false])(
  "receipt selection ignores file timestamps (already exists: %s)",
  async (exists) => {
    const home = await mkdtemp(join(tmpdir(), "awf-receipt-"));
    const directory = join(home, "projects", "-probe");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "native.jsonl");
    const originalNow = Date.now;
    try {
      if (exists) await writeFile(path, "");
      // Clock skew models coarse or unavailable birthtime: native creation predates this clock.
      Date.now = () => originalNow() + 60_000;
      const receipt = await prepareClaudeReceipt("/probe", marker, home);
      Date.now = originalNow;
      await appendFile(path, `${JSON.stringify(user())}\n${JSON.stringify(assistant("input"))}\n`);
      let received = false;
      await receipt.watch(
        new AbortController().signal,
        () => {},
        () => {
          received = true;
        },
        async () => false,
      );
      expect(received).toBe(true);
    } finally {
      Date.now = originalNow;
      await rm(home, { recursive: true, force: true });
    }
  },
);
