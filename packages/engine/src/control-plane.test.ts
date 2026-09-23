import { afterAll, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { type ResultSubmitResponse, WIRE_VERSION } from "@wf/contract/wire";
import { startResultControlPlane } from "./control-plane";
import type { ResultSlotRegistry } from "./result-slots";
import { createResultSlotRegistry } from "./result-slots";
import { readAccepted } from "./run-dir";
import { COUNT_SCHEMA, createTempRunDirs, exchange } from "./testing";

const runDirs = createTempRunDirs();
const { tempRunDir } = runDirs;
afterAll(() => runDirs.cleanup());

const AGENT = "reviewer";
const DEADLINE = { unixMilliseconds: Date.now() + 60_000 };

describe("result control plane", () => {
  test("accepts one request and persists through the result-slot path", async () => {
    const fixture = await setup();
    try {
      const response = await rawRequest(
        fixture.channel.endpoint,
        `${JSON.stringify(request('{"count":3,"even":false}'))}\n`,
      );

      expect(response).toEqual({ version: WIRE_VERSION, kind: "accepted" });
      expect(await readAccepted(fixture.runDir, "op-1")).toEqual({
        value: { count: 3, even: false },
      });
    } finally {
      await fixture.control.close();
    }
  });

  test("a call is answerable only on its own agent's socket", async () => {
    const fixture = await setup();
    try {
      const other = await fixture.control.openChannel("other-agent");

      await expect(
        rawRequest(other.endpoint, `${JSON.stringify(request('{"count":3,"even":false}'))}\n`),
      ).resolves.toMatchObject({ kind: "rejected", code: "wrong-agent" });
      expect(await readAccepted(fixture.runDir, "op-1")).toBeNull();
    } finally {
      await fixture.control.close();
    }
  });

  test("rejects malformed, extra-line, and oversized frames", async () => {
    const malformed = await setup();
    try {
      expect(await rawRequest(malformed.channel.endpoint, "not-json\n")).toMatchObject({
        kind: "rejected",
        code: "invalid-request",
      });
      expect(await rawRequest(malformed.channel.endpoint, "{}\n{}\n")).toMatchObject({
        kind: "rejected",
        code: "invalid-request",
      });
    } finally {
      await malformed.control.close();
    }

    const oversized = await setup(64);
    try {
      expect(await rawRequest(oversized.channel.endpoint, `${"x".repeat(65)}\n`)).toMatchObject({
        kind: "rejected",
        code: "request-too-large",
      });
    } finally {
      await oversized.control.close();
    }
  });

  test("owns a private directory and removes socket state idempotently", async () => {
    const fixture = await setup();
    const directory = dirname(fixture.channel.endpoint);

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await expect(stat(fixture.channel.endpoint)).resolves.toBeDefined();

    await fixture.control.close();
    await fixture.control.close();

    await expect(stat(fixture.channel.endpoint)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("close waits for an admitted submission before releasing endpoint ownership", async () => {
    let entered!: () => void;
    let release!: () => void;
    const submissionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slots: ResultSlotRegistry = {
      async open() {
        throw new Error("not used");
      },
      async submit() {
        entered();
        await gate;
        return { kind: "accepted", value: {}, attemptRecorded: true };
      },
      async close() {
        return false;
      },
    };
    const control = await startResultControlPlane({ socketRoot: tempRunDir(), slots });
    const channel = await control.openChannel(AGENT);
    const socket = createConnection(channel.endpoint);
    socket.once("connect", () => socket.end(`${JSON.stringify(request("{}"))}\n`));
    await submissionEntered;

    let closed = false;
    const closing = control.close().then(() => {
      closed = true;
    });
    await Bun.sleep(0);
    expect(closed).toBe(false);

    release();
    await closing;
    expect(closed).toBe(true);
    socket.destroy();
  });

  test("bounds concurrent peers by an absolute connection lifetime", async () => {
    const fixture = await setup(undefined, { maxConnections: 1, connectionLifetimeMs: 40 });
    const blocker = createConnection(fixture.channel.endpoint);
    await new Promise<void>((resolve, reject) => {
      blocker.once("connect", resolve);
      blocker.once("error", reject);
    });
    const blockerClosed = new Promise<void>((resolve) => blocker.once("close", resolve));
    blocker.write("{");

    try {
      await expect(
        rawRequest(fixture.channel.endpoint, `${JSON.stringify(request("{}"))}\n`),
      ).rejects.toThrow();
      await blockerClosed;
      await Bun.sleep(5);
      await expect(
        rawRequest(
          fixture.channel.endpoint,
          `${JSON.stringify(request('{"count":1,"even":false}'))}\n`,
        ),
      ).resolves.toMatchObject({ kind: "accepted" });
    } finally {
      blocker.destroy();
      await fixture.control.close();
    }
  });

  test("a channel still being opened when the plane closes is refused, not left listening", async () => {
    const fixture = await setup();
    const late = fixture.control.openChannel("late");
    await fixture.control.close();

    await expect(late).rejects.toThrow("closed");
  });
});

async function setup(
  maxRequestBytes?: number,
  limits: { maxConnections?: number; connectionLifetimeMs?: number } = {},
) {
  const runDir = tempRunDir();
  const slots = createResultSlotRegistry({ runDir });
  await slots.open({
    operationId: "op-1",
    agentId: AGENT,
    question: "count letters",
    schema: COUNT_SCHEMA,
    deadline: DEADLINE,
  });
  const control = await startResultControlPlane({
    socketRoot: tempRunDir(),
    slots,
    ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
    ...limits,
  });
  const channel = await control.openChannel(AGENT);
  return { runDir, control, channel };
}

function request(raw: string) {
  return { version: WIRE_VERSION, operationId: "op-1", raw };
}

async function rawRequest(endpoint: string, frame: string): Promise<ResultSubmitResponse> {
  return JSON.parse(await exchange(endpoint, frame)) as ResultSubmitResponse;
}
