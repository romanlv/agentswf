import { afterAll, describe, expect, test } from "bun:test";
import { stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { WIRE_VERSION, type ResultSubmitResponse } from "@wf/contract/wire";
import type { ResultSlotRegistry } from "./result-slots";
import { startResultControlPlane } from "./control-plane";
import { readAccepted } from "./run-dir";
import { createResultSlotRegistry } from "./result-slots";
import { COUNT_SCHEMA, createTempRunDirs } from "./testing";

const runDirs = createTempRunDirs();
const { tempRunDir } = runDirs;
afterAll(() => runDirs.cleanup());

const DEADLINE = { unixMilliseconds: Date.now() + 60_000 };

describe("result control plane", () => {
  test("accepts one request and persists through the result-slot path", async () => {
    const fixture = await setup();
    try {
      const response = await rawRequest(
        fixture.control.endpoint,
        `${JSON.stringify(request(fixture.binding.capability, '{"count":3,"even":false}'))}\n`,
      );

      expect(response).toEqual({ version: 1, kind: "accepted" });
      expect(await readAccepted(fixture.runDir, "op-1")).toEqual({
        value: { count: 3, even: false },
      });
    } finally {
      await fixture.control.close();
    }
  });

  test("rejects malformed, extra-line, and oversized frames", async () => {
    const malformed = await setup();
    try {
      expect(await rawRequest(malformed.control.endpoint, "not-json\n")).toMatchObject({
        kind: "rejected",
        code: "invalid-request",
      });
      expect(await rawRequest(malformed.control.endpoint, "{}\n{}\n")).toMatchObject({
        kind: "rejected",
        code: "invalid-request",
      });
    } finally {
      await malformed.control.close();
    }

    const oversized = await setup(64);
    try {
      expect(await rawRequest(oversized.control.endpoint, `${"x".repeat(65)}\n`)).toMatchObject({
        kind: "rejected",
        code: "request-too-large",
      });
    } finally {
      await oversized.control.close();
    }
  });

  test("owns a private directory and removes socket state idempotently", async () => {
    const fixture = await setup();
    const directory = dirname(fixture.control.endpoint);

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    await expect(stat(fixture.control.endpoint)).resolves.toBeDefined();

    await fixture.control.close();
    await fixture.control.close();

    await expect(stat(fixture.control.endpoint)).rejects.toMatchObject({ code: "ENOENT" });
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
    const capability = "A".repeat(43);
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
    const socket = createConnection(control.endpoint);
    socket.once("connect", () => socket.end(`${JSON.stringify(request(capability, "{}"))}\n`));
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
    const blocker = createConnection(fixture.control.endpoint);
    await new Promise<void>((resolve, reject) => {
      blocker.once("connect", resolve);
      blocker.once("error", reject);
    });
    const blockerClosed = new Promise<void>((resolve) => blocker.once("close", resolve));
    blocker.write("{");

    try {
      await expect(
        rawRequest(
          fixture.control.endpoint,
          `${JSON.stringify(request(fixture.binding.capability, "{}"))}\n`,
        ),
      ).rejects.toThrow();
      await blockerClosed;
      await Bun.sleep(5);
      await expect(
        rawRequest(
          fixture.control.endpoint,
          `${JSON.stringify(request(fixture.binding.capability, '{"count":1,"even":false}'))}\n`,
        ),
      ).resolves.toMatchObject({ kind: "accepted" });
    } finally {
      blocker.destroy();
      await fixture.control.close();
    }
  });

  test("the installed agent CLI reaches the endpoint and retains schema errors", async () => {
    const fixture = await setup();
    try {
      const binDirectory = tempRunDir();
      const cli = join(binDirectory, "wf");
      await symlink(join(import.meta.dir, "../../cli-agent/src/cli.ts"), cli);
      const process = Bun.spawn([cli, "result", '{"count":"3","even":false}'], {
        env: {
          ...globalThis.process.env,
          WF_ENDPOINT: fixture.control.endpoint,
          WF_OPERATION: "op-1",
          WF_CAPABILITY: fixture.binding.capability,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toContain("value.count: expected an integer");
      expect(stderr).not.toContain(fixture.binding.capability);
      expect(await readAccepted(fixture.runDir, "op-1")).toBeNull();
    } finally {
      await fixture.control.close();
    }
  });
});

async function setup(
  maxRequestBytes?: number,
  limits: { maxConnections?: number; connectionLifetimeMs?: number } = {},
) {
  const runDir = tempRunDir();
  const slots = createResultSlotRegistry({ runDir });
  const binding = await slots.open({
    operationId: "op-1",
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
  return { runDir, binding, control };
}

function request(capability: string, raw: string) {
  return { version: WIRE_VERSION, operationId: "op-1", capability, raw };
}

async function rawRequest(endpoint: string, frame: string): Promise<ResultSubmitResponse> {
  return new Promise<ResultSubmitResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = createConnection(endpoint);
    socket.once("connect", () => socket.end(frame));
    socket.on("data", (data) => chunks.push(typeof data === "string" ? Buffer.from(data) : data));
    socket.once("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text.slice(0, -1)) as ResultSubmitResponse);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", reject);
  });
}
