import { afterAll, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { type ControlResponse, WIRE_VERSION } from "@agentswf/contract/wire";
import { CONTROL_PLANE_ROOT, startResultControlPlane } from "./control-plane";
import type { ResultSlotRegistry } from "./result-slots";
import { createResultSlotRegistry } from "./result-slots";
import { readAccepted } from "./runs";
import { COUNT_SCHEMA, createTempRunDirs, exchange } from "./testing";

const runDirs = createTempRunDirs();
const { tempRunDir } = runDirs;
afterAll(() => runDirs.cleanup());

const AGENT = "reviewer";
const DEADLINE = { unixMilliseconds: Date.now() + 60_000 };

describe("result control plane", () => {
  test("keeps its sockets under a short root, whatever the system temp dir", async () => {
    const control = await startResultControlPlane({
      slots: createResultSlotRegistry({ runDir: tempRunDir() }),
    });
    try {
      const channel = await control.openChannel(AGENT);
      expect(channel.endpoint.startsWith(`${CONTROL_PLANE_ROOT}/awf-`)).toBe(true);
      expect(channel.endpoint.length).toBeLessThan(40);
    } finally {
      await control.close();
    }
  });

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

  test("routes waiting through the same authority and preserves the result slot", async () => {
    const runDir = tempRunDir();
    const slots = createResultSlotRegistry({ runDir });
    const binding = await slots.open({
      operationId: "op-1",
      agentId: AGENT,
      question: "q",
      deadline: DEADLINE,
      allowWaiting: true,
    });
    const control = await startResultControlPlane({ socketRoot: tempRunDir(), slots });
    try {
      const channel = await control.openChannel(AGENT);
      const other = await control.openChannel("other");
      const frame = `${JSON.stringify({ version: WIRE_VERSION, command: "waiting", operationId: "op-1", reason: "deploy", timeoutMs: 120_000 })}\n`;
      await expect(rawRequest(other.endpoint, frame)).resolves.toMatchObject({
        kind: "rejected",
        code: "wrong-agent",
      });
      await expect(rawRequest(channel.endpoint, frame)).resolves.toEqual({
        version: WIRE_VERSION,
        kind: "waiting",
        waitUntil: DEADLINE.unixMilliseconds,
        deadline: DEADLINE.unixMilliseconds,
      });
      expect(await readAccepted(runDir, "op-1")).toBeNull();
      await expect(
        rawRequest(channel.endpoint, `${JSON.stringify(request("{}"))}\n`),
      ).resolves.toMatchObject({ kind: "accepted" });
      await expect(binding.settled).resolves.toMatchObject({ kind: "accepted" });
      await expect(rawRequest(channel.endpoint, frame)).resolves.toMatchObject({
        code: "closed-operation",
      });
    } finally {
      await control.close();
    }
  });

  test("a connection's lifetime bounds close even if semantic validation never returns", async () => {
    const entered = Promise.withResolvers<void>();
    const slots = createResultSlotRegistry({ runDir: tempRunDir() });
    await slots.open({
      operationId: "op-1",
      agentId: AGENT,
      question: "q",
      deadline: DEADLINE,
      semantic: async () => {
        entered.resolve();
        return new Promise(() => {});
      },
    });
    const control = await startResultControlPlane({
      socketRoot: tempRunDir(),
      slots,
      connectionLifetimeMs: 30,
    });
    const channel = await control.openChannel(AGENT);
    const socket = createConnection(channel.endpoint);
    socket.on("error", () => {});
    socket.once("connect", () => socket.end(`${JSON.stringify(request("{}"))}\n`));
    await entered.promise;
    await control.close();
    expect(await slots.close("op-1")).toBe(true);
    socket.destroy();
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
      async waiting() {
        throw new Error("unused");
      },
      async open() {
        throw new Error("not used");
      },
      async submit() {
        entered();
        await gate;
        return {
          kind: "accepted",
          value: {},
          candidateRecorded: true,
          admittedAt: 0,
          acceptedAt: 0,
        };
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
    // Long enough for the last request to finish on a loaded machine, short enough to wait out.
    const fixture = await setup(undefined, { maxConnections: 1, connectionLifetimeMs: 200 });
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
      ).resolves.toMatchObject({
        kind: "rejected",
        code: "internal-error",
        error: expect.stringContaining("connection limit"),
      });
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
  return { version: WIRE_VERSION, command: "result", operationId: "op-1", raw };
}

async function rawRequest(endpoint: string, frame: string): Promise<ControlResponse> {
  return JSON.parse(await exchange(endpoint, frame)) as ControlResponse;
}
