import { describe, expect, test } from "bun:test";
import {
  type ResultSubmitRequest,
  type ResultSubmitResponse,
  WIRE_VERSION,
} from "@wf/contract/wire";
import { readBoundedStdin, readCliStdin, runCli } from "./cli";

const ENDPOINT = "/private/control.sock";
const at = (...args: readonly string[]) => ["--at", ENDPOINT, ...args];

describe("wf result", () => {
  test("submits an exact argument request", async () => {
    const seen: Array<{ endpoint: string; request: ResultSubmitRequest }> = [];
    const outcome = await runCli(
      at("result", "op-1", '{"count":3}'),
      null,
      async (endpoint, request) => {
        seen.push({ endpoint, request });
        return { version: WIRE_VERSION, kind: "accepted" };
      },
    );

    expect(outcome).toEqual({ exitCode: 0, stdout: "wf: result accepted", stderr: "" });
    expect(seen).toEqual([
      {
        endpoint: ENDPOINT,
        request: {
          version: WIRE_VERSION,
          operationId: "op-1",
          raw: '{"count":3}',
        },
      },
    ]);
  });

  test("passes on the session the launcher expanded, and omits an empty one", async () => {
    const sessions: Array<string | undefined> = [];
    const submit = async (_endpoint: string, request: ResultSubmitRequest) => {
      sessions.push(request.session);
      return { version: WIRE_VERSION, kind: "accepted" } as const;
    };

    await runCli(at("--session", "s-1", "result", "op-1", "{}"), null, submit);
    await runCli(at("--session", "", "result", "op-1", "{}"), null, submit);
    await runCli(at("--session", "  ", "result", "op-1", "{}"), null, submit);

    expect(sessions).toEqual(["s-1", undefined, undefined]);
  });

  test("a session before the command still leaves the value to standard input", async () => {
    expect(await readCliStdin(at("--session", "s-1", "result", "op-1"), false, stream("{}"))).toBe(
      "{}",
    );
  });

  test("standard input is the alternative single source", async () => {
    let raw = "";
    const outcome = await runCli(
      at("result", "op-1"),
      '{"count":3}\n',
      async (_endpoint, request) => {
        raw = request.raw;
        return { version: WIRE_VERSION, kind: "accepted" };
      },
    );

    expect(outcome.exitCode).toBe(0);
    expect(raw).toBe('{"count":3}\n');
  });

  test("argument input never waits for or consumes standard input", async () => {
    const unreadable = new Proxy({} as ReadableStream<Uint8Array>, {
      get() {
        throw new Error("standard input was accessed");
      },
    });

    expect(await readCliStdin(at("result", "op-1", '{"count":3}'), false, unreadable)).toBeNull();
  });

  test("both, neither, extra arguments, and empty input fail before connecting", async () => {
    let calls = 0;
    const submit = async (): Promise<ResultSubmitResponse> => {
      calls += 1;
      return { version: WIRE_VERSION, kind: "accepted" };
    };

    // Direct callers can still violate the single-source contract; the executable never reads
    // stdin when an argument is present.
    expect((await runCli(at("result", "op-1", "{}"), "{}", submit)).exitCode).toBe(2);
    expect((await runCli(at("result", "op-1"), null, submit)).exitCode).toBe(2);
    expect((await runCli(at("result", "op-1", "a", "b"), null, submit)).exitCode).toBe(2);
    expect((await runCli(at("result", "op-1"), "  \n", submit)).exitCode).toBe(2);
    expect((await runCli(at("result"), "{}", submit)).exitCode).toBe(2);
    expect(calls).toBe(0);
  });

  test("a bare invocation fails before connecting", async () => {
    let called = false;
    const outcome = await runCli(["result", "op-1", "{}"], null, async () => {
      called = true;
      return { version: WIRE_VERSION, kind: "accepted" };
    });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("launcher");
    expect(called).toBe(false);
  });

  test("a rejected response retains actionable field detail", async () => {
    const outcome = await runCli(at("result", "op-1", "{}"), null, async () => ({
      version: WIRE_VERSION,
      kind: "rejected",
      code: "invalid-result",
      error: "value.count: expected an integer",
    }));

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("value.count: expected an integer");
    expect(outcome.stderr).toContain("run wf result again");
  });

  test("a transport failure reports the reason it was given", async () => {
    const outcome = await runCli(at("result", "op-1", "{}"), null, async () => {
      throw new Error("connect ENOENT /run/engine.sock");
    });

    expect(outcome.exitCode).toBe(1);
    expect(outcome.stderr).toContain("connect ENOENT /run/engine.sock");
  });

  test("only validation failures tell the agent to change and retry the value", async () => {
    for (const code of [
      "unknown-operation",
      "wrong-agent",
      "expired-operation",
      "closed-operation",
      "invalid-request",
      "unsupported-version",
      "request-too-large",
      "internal-error",
    ] as const) {
      const outcome = await runCli(at("result", "op-1", "{}"), null, async () => ({
        version: WIRE_VERSION,
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

  test("gives up on a pipe that is never closed", async () => {
    const neverCloses = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const startedAt = Date.now();
    await expect(readBoundedStdin(neverCloses, 1024, 50)).rejects.toThrow("not closed in time");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}
