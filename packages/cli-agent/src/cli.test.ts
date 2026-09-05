import { describe, expect, test } from "bun:test";
import { WIRE_VERSION, type ResultSubmitRequest, type ResultSubmitResponse } from "@wf/contract/wire";
import { readBoundedStdin, readCliStdin, runCli } from "./cli";

const CAPABILITY = "A".repeat(43);
const ENV = {
  WF_ENDPOINT: "/private/control.sock",
  WF_OPERATION: "op-1",
  WF_CAPABILITY: CAPABILITY,
};

describe("wf result", () => {
  test("submits an exact argument request without exposing authority", async () => {
    const seen: Array<{ endpoint: string; request: ResultSubmitRequest }> = [];
    const outcome = await runCli(
      ["result", '{"count":3}'],
      ENV,
      null,
      async (endpoint, request) => {
        seen.push({ endpoint, request });
        return { version: WIRE_VERSION, kind: "accepted" };
      },
    );

    expect(outcome).toEqual({ exitCode: 0, stdout: "wf: result accepted", stderr: "" });
    expect(seen).toEqual([
      {
        endpoint: ENV.WF_ENDPOINT,
        request: {
          version: 1,
          operationId: "op-1",
          capability: CAPABILITY,
          raw: '{"count":3}',
        },
      },
    ]);
    expect(JSON.stringify(outcome)).not.toContain(CAPABILITY);
  });

  test("standard input is the alternative single source", async () => {
    let raw = "";
    const outcome = await runCli(["result"], ENV, '{"count":3}\n', async (_endpoint, request) => {
      raw = request.raw;
      return { version: 1, kind: "accepted" };
    });

    expect(outcome.exitCode).toBe(0);
    expect(raw).toBe('{"count":3}\n');
  });

  test("argument input never waits for or consumes standard input", async () => {
    const unreadable = new Proxy({} as ReadableStream<Uint8Array>, {
      get() {
        throw new Error("standard input was accessed");
      },
    });

    expect(await readCliStdin(["result", '{"count":3}'], false, unreadable)).toBeNull();
  });

  test("both, neither, extra arguments, and empty input fail before connecting", async () => {
    let calls = 0;
    const submit = async (): Promise<ResultSubmitResponse> => {
      calls += 1;
      return { version: 1, kind: "accepted" };
    };

    // Direct callers can still violate the single-source contract; the executable never reads
    // stdin when an argument is present.
    expect((await runCli(["result", "{}"], ENV, "{}", submit)).exitCode).toBe(2);
    expect((await runCli(["result"], ENV, null, submit)).exitCode).toBe(2);
    expect((await runCli(["result", "a", "b"], ENV, null, submit)).exitCode).toBe(2);
    expect((await runCli(["result"], ENV, "  \n", submit)).exitCode).toBe(2);
    expect(calls).toBe(0);
  });

  test("missing binding fails before connecting", async () => {
    let called = false;
    const outcome = await runCli(["result", "{}"], {}, null, async () => {
      called = true;
      return { version: 1, kind: "accepted" };
    });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("WF_ENDPOINT");
    expect(called).toBe(false);
  });

  test("a rejected response retains actionable field detail but not authority", async () => {
    const outcome = await runCli(["result", "{}"], ENV, null, async () => ({
      version: 1,
      kind: "rejected",
      code: "invalid-result",
      error: "value.count: expected an integer",
    }));

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("value.count: expected an integer");
    expect(outcome.stderr).toContain("run wf result again");
    expect(outcome.stderr).not.toContain(CAPABILITY);
  });

  test("does not expose authority from untrusted diagnostics", async () => {
    const thrown = await runCli(["result", "{}"], ENV, null, async () => {
      throw new Error(`transport echoed ${CAPABILITY}`);
    });
    const rejected = await runCli(["result", "{}"], ENV, null, async () => ({
      version: 1,
      kind: "rejected",
      code: "invalid-result",
      error: `value.note: ${CAPABILITY} op-1`,
    }));

    const transport = await runCli(["result", "{}"], ENV, null, async () => {
      throw new Error("connect ENOENT /run/engine.sock");
    });
    const escaped = `\\x${CAPABILITY.charCodeAt(0).toString(16)}${CAPABILITY.slice(1)}`;
    const escapedThrown = await runCli(["result", "{}"], ENV, null, async () => {
      throw new Error(`transport echoed ${escaped}`);
    });

    expect(thrown.stderr).toContain("without safe diagnostic detail");
    expect(thrown.stderr).not.toContain(CAPABILITY);
    expect(escapedThrown.stderr).toContain("without safe diagnostic detail");
    expect(escapedThrown.stderr).not.toContain(escaped);
    expect(transport.stderr).toContain("connect ENOENT /run/engine.sock");
    expect(rejected.stderr).not.toContain(CAPABILITY);
    expect(rejected.stderr).not.toContain("op-1");
  });

  test("only validation failures tell the agent to change and retry the value", async () => {
    for (const code of [
      "unknown-capability",
      "wrong-operation",
      "expired-capability",
      "closed-capability",
      "invalid-request",
      "unsupported-version",
      "request-too-large",
      "internal-error",
    ] as const) {
      const outcome = await runCli(["result", "{}"], ENV, null, async () => ({
        version: 1,
        kind: "rejected",
        code,
        error: "not actionable by changing JSON",
      }));
      expect(outcome.stderr).not.toContain("Fix the value");
    }
  });

  test("bounds standard input while reading it", async () => {
    const stream = new Blob(["123", "456"]).stream();
    await expect(readBoundedStdin(stream, 5)).rejects.toThrow("size limit");
  });
});
