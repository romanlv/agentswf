import { describe, expect, test } from "bun:test";
import {
  decodeControlRequest,
  decodeControlResponse,
  decodeResponseFor,
  decodeResultSubmitRequest,
  decodeResultSubmitResponse,
  ENVELOPE_CODES,
  REPLY_CODES,
  RESULT_CODES,
  SEND_CODES,
  TOOL_CODES,
  validWaitingReason,
  WIRE_VERSION,
} from "./wire";

describe("result-submit wire", () => {
  test("decodes one exact versioned request", () => {
    expect(
      decodeResultSubmitRequest({
        version: WIRE_VERSION,
        command: "result",
        operationId: "op-1",
        raw: '{"verdict":"approve"}',
      }),
    ).toEqual({
      ok: true,
      value: {
        version: WIRE_VERSION,
        command: "result",
        operationId: "op-1",
        raw: '{"verdict":"approve"}',
      },
    });
  });

  test("carries the agent's native session when the launcher had one", () => {
    const request = {
      version: WIRE_VERSION,
      command: "result",
      operationId: "op-1",
      raw: "{}",
    } as const;
    expect(decodeResultSubmitRequest({ ...request, session: "s-1" })).toEqual({
      ok: true,
      value: { ...request, session: "s-1" },
    });
    expect(decodeResultSubmitRequest({ ...request, session: "" })).toMatchObject({
      ok: false,
      code: "invalid-request",
    });
  });

  test("rejects unsupported versions separately from malformed requests", () => {
    expect(
      decodeResultSubmitRequest({
        version: 1,
        operationId: "op-1",
        raw: "{}",
      }),
    ).toMatchObject({ ok: false, code: "unsupported-version" });
    expect(
      decodeResultSubmitRequest({
        operationId: "op-1",
        raw: "{}",
      }),
    ).toMatchObject({ ok: false, code: "invalid-request" });
    expect(
      decodeResultSubmitRequest({
        version: "2",
        operationId: "op-1",
        raw: "{}",
      }),
    ).toMatchObject({ ok: false, code: "invalid-request" });
  });

  test("rejects extra, empty, and malformed fields", () => {
    const extra = decodeResultSubmitRequest({
      version: WIRE_VERSION,
      command: "result",
      operationId: "op-1",
      raw: "{}",
      extra: true,
    });
    expect(extra).toMatchObject({ ok: false, code: "invalid-request" });
    expect(JSON.stringify(extra)).not.toContain("extra");
    expect(
      decodeResultSubmitRequest({
        version: WIRE_VERSION,
        command: "result",
        operationId: "",
        raw: "",
      }),
    ).toMatchObject({ ok: false, code: "invalid-request" });
  });

  test("decodes accepted and rejected responses without accepting extra fields", () => {
    expect(decodeResultSubmitResponse({ version: WIRE_VERSION, kind: "accepted" })).toEqual({
      ok: true,
      value: { version: WIRE_VERSION, kind: "accepted" },
    });
    expect(
      decodeResultSubmitResponse({
        version: WIRE_VERSION,
        kind: "rejected",
        code: "invalid-result",
        error: "value.count: expected an integer",
      }),
    ).toMatchObject({ ok: true });
    expect(
      decodeResultSubmitResponse({ version: WIRE_VERSION, kind: "accepted", extra: true }),
    ).toMatchObject({ ok: false });
    expect(decodeResultSubmitResponse({ kind: "accepted" })).toMatchObject({
      ok: false,
      code: "invalid-request",
    });
    expect(decodeResultSubmitResponse({ version: 1, kind: "accepted" })).toMatchObject({
      ok: false,
      code: "unsupported-version",
    });
  });
});

const WAITING = {
  version: WIRE_VERSION,
  command: "waiting",
  operationId: "op-1",
  reason: "Deploy in progress",
} as const;

test("waiting has a separate strict request shape and old wire clients fail explicitly", () => {
  expect(decodeControlRequest(WAITING)).toEqual({ ok: true, value: WAITING });
  expect(decodeControlRequest({ ...WAITING, timeoutMs: 120000, session: "session" })).toMatchObject(
    { ok: true },
  );
  expect(decodeResultSubmitRequest(WAITING)).toMatchObject({ ok: false });
  expect(decodeControlRequest({ version: 2, operationId: "op-1", raw: "{}" })).toMatchObject({
    ok: false,
    code: "unsupported-version",
  });
  expect(decodeControlRequest({ ...WAITING, command: "unknown" })).toMatchObject({
    ok: false,
    code: "unsupported-command",
  });
  for (const fields of [
    { raw: "{}" },
    { session: " " },
    { operationId: " " },
    { reason: " " },
    { reason: 7 },
    { timeoutMs: 0 },
    { timeoutMs: -1 },
    { timeoutMs: 1.5 },
    { timeoutMs: Infinity },
    { timeoutMs: Number.MAX_SAFE_INTEGER + 1 },
    { timeoutMs: "2m" },
  ]) {
    expect(decodeControlRequest({ ...WAITING, ...fields })).toMatchObject({ ok: false });
  }
});

test("reason limit counts UTF-8 bytes including astral and unpaired characters", () => {
  for (const unit of ["a", "é", "中", "😀", "\ud800"]) {
    const size = new TextEncoder().encode(unit).length;
    const limit = unit.repeat(Math.floor(2048 / size));
    expect(validWaitingReason(limit)).toBe(true);
    expect(validWaitingReason(limit + unit)).toBe(false);
  }
});

test("waiting acknowledgements require integer ordered timestamps and exact fields", () => {
  const response = {
    version: WIRE_VERSION,
    kind: "waiting",
    waitUntil: 1000,
    deadline: 2000,
  } as const;
  expect(decodeControlResponse(response) as unknown).toEqual({ ok: true, value: response });
  expect(decodeResultSubmitResponse(response)).toMatchObject({ ok: false });
  // An operation with no deadline around it reports none.
  const open = { version: WIRE_VERSION, kind: "waiting", waitUntil: 1000 } as const;
  expect(decodeControlResponse(open) as unknown).toEqual({ ok: true, value: open });
  for (const fields of [
    { waitUntil: -1 },
    { waitUntil: 1.5 },
    { waitUntil: 2001 },
    { deadline: Infinity },
    { deadline: "2000" },
    { extra: true },
  ]) {
    expect(decodeControlResponse({ ...response, ...fields })).toMatchObject({ ok: false });
  }
});

test("control decoders reject unrelated JSON values without throwing", () => {
  for (const value of [
    null,
    true,
    0,
    "waiting",
    [],
    {},
    { version: null },
    { version: 3 },
    { version: 3, command: [] },
  ]) {
    expect(decodeControlRequest(value).ok).toBe(false);
    expect(decodeControlResponse(value).ok).toBe(false);
  }
});

describe("messaging wire", () => {
  const SEND = {
    version: WIRE_VERSION,
    command: "send",
    peer: "fixer",
    text: "Off by one",
  } as const;

  test("decodes peers, send and reply, none naming a call id", () => {
    expect(decodeControlRequest({ version: WIRE_VERSION, command: "peers" })).toEqual({
      ok: true,
      value: { version: WIRE_VERSION, command: "peers" },
    });
    expect(decodeControlRequest(SEND)).toEqual({ ok: true, value: SEND });
    const asking = {
      ...SEND,
      command: "reply",
      awaitReply: true,
      timeoutMs: 300_000,
      session: "s",
    };
    expect(decodeControlRequest(asking) as unknown).toEqual({ ok: true, value: asking });
    for (const fields of [
      { operationId: "op-1" },
      { peer: " " },
      { text: "  " },
      { text: 7 },
      { awaitReply: false },
      { timeoutMs: 1000 },
      { awaitReply: true, timeoutMs: 0 },
      { session: "" },
    ]) {
      expect(decodeControlRequest({ ...SEND, ...fields })).toMatchObject({
        ok: false,
        code: "invalid-request",
      });
    }
    expect(
      decodeControlRequest({ version: WIRE_VERSION, command: "peers", json: true }),
    ).toMatchObject({ ok: false, code: "invalid-request" });
  });

  test("a launcher from before messaging is refused, not misread", () => {
    expect(decodeControlRequest({ ...SEND, version: 3 })).toMatchObject({
      ok: false,
      code: "unsupported-version",
    });
    expect(
      decodeControlRequest({ version: 3, command: "result", operationId: "op-1", raw: "{}" }),
    ).toMatchObject({ ok: false, code: "unsupported-version" });
  });

  test("every refusal code round-trips, with the owed-answer line", () => {
    for (const code of new Set([
      ...ENVELOPE_CODES,
      ...RESULT_CODES,
      ...SEND_CODES,
      ...REPLY_CODES,
    ])) {
      const response = {
        version: WIRE_VERSION,
        kind: "rejected",
        code,
        error: `refused (${code})`,
        owing: "you owe reviewer a reply (wf reply reviewer).",
      } as const;
      expect(decodeControlResponse(JSON.parse(JSON.stringify(response)))).toEqual({
        ok: true,
        value: response,
      });
    }
    expect(
      decodeControlResponse({ version: WIRE_VERSION, kind: "rejected", code: "nope", error: "x" }),
    ).toMatchObject({ ok: false });
  });

  test("a result's response is a result code, never a send's", () => {
    const rejected = { version: WIRE_VERSION, kind: "rejected", error: "x" } as const;
    expect(decodeResultSubmitResponse({ ...rejected, code: "owes-reply" })).toMatchObject({
      ok: true,
    });
    expect(decodeResultSubmitResponse({ ...rejected, code: "no-route" })).toMatchObject({
      ok: false,
    });
    expect(
      decodeResultSubmitResponse({ version: WIRE_VERSION, kind: "sent", message: 1, notice: "x" }),
    ).toMatchObject({ ok: false });
  });

  test("acknowledgements: sent, awaiting a reply, peers", () => {
    const responses = [
      { version: WIRE_VERSION, kind: "sent", message: 3, notice: "wf: sent to fixer." },
      {
        version: WIRE_VERSION,
        kind: "sent",
        message: 4,
        until: 1_800_000,
        notice: "wf: sent to architect.",
        owing: "you await architect's reply.",
      },
      {
        version: WIRE_VERSION,
        kind: "awaiting-reply",
        peer: "architect",
        until: 1_800_000,
        notice: "you already await architect's reply.",
      },
      { version: WIRE_VERSION, kind: "accepted", owing: "you owe reviewer a reply." },
      {
        version: WIRE_VERSION,
        kind: "peers",
        peers: [
          {
            peer: "reviewer",
            can: "both",
            state: "awaiting",
            awaits: "implementer",
            queued: 0,
            purpose: "Review it.",
          },
          {
            peer: "architect",
            can: "send",
            state: "stopped",
            reason: "design settled",
            queued: 1,
            purpose: "Ask.",
          },
        ],
        owes: ["reviewer"],
        awaits: { peer: "architect", until: 1_800_000 },
        text: "peer  you can  state",
      },
    ];
    // A wait on an outside participant may have no limit, and it shows in `wf peers` as `outside`.
    const outside: object[] = [
      { version: WIRE_VERSION, kind: "awaiting-reply", peer: "coordinator", notice: "waiting." },
      {
        version: WIRE_VERSION,
        kind: "peers",
        peers: [{ peer: "coordinator", can: "both", state: "outside", queued: 0, purpose: "Ask." }],
        owes: [],
        awaits: { peer: "coordinator" },
        text: "peer  you can  state",
      },
    ];
    for (const response of [...responses, ...outside]) {
      expect(decodeControlResponse(response) as unknown).toEqual({ ok: true, value: response });
    }
    for (const broken of [
      { ...responses[0], message: 0 },
      { ...responses[0], notice: "" },
      { ...responses[0], owing: "" },
      { ...responses[2], until: -1 },
      { ...responses[4], owes: [""] },
      { ...responses[4], awaits: { peer: "x", until: -1 } },
      {
        ...responses[4],
        peers: [{ peer: "x", can: "all", state: "idle", queued: 0, purpose: "" }],
      },
      {
        ...responses[4],
        peers: [{ peer: "x", can: "send", state: "idle", queued: -1, purpose: "" }],
      },
    ]) {
      expect(decodeControlResponse(broken)).toMatchObject({ ok: false });
    }
  });
});

describe("tool wire", () => {
  const tool = { version: WIRE_VERSION, command: "tool", tool: "close_case" } as const;

  test("a call carries JSON, flags as given, or no input", () => {
    for (const given of [{ raw: '{"status":"noise"}' }, { args: ["--status", "it's"] }, {}]) {
      expect(decodeControlRequest({ ...tool, ...given, session: "s-1" })).toEqual({
        ok: true,
        value: { ...tool, ...given, session: "s-1" },
      });
    }
  });

  test("a call is refused both forms at once, empty flags, a blank name and unknown fields", () => {
    for (const request of [
      { ...tool, raw: "{}", args: ["--a", "b"] },
      { ...tool, args: [] },
      { ...tool, args: ["--a", 1] },
      { ...tool, raw: " " },
      { ...tool, tool: " " },
      { ...tool, operationId: "op-1" },
    ]) {
      expect(decodeControlRequest(request)).toMatchObject({ ok: false, code: "invalid-request" });
    }
  });

  test("a result takes flags or no input as a call does", () => {
    const result = { version: WIRE_VERSION, command: "result", operationId: "op-1" } as const;
    expect(decodeControlRequest({ ...result, args: ["--verdict", "noise"] })).toEqual({
      ok: true,
      value: { ...result, args: ["--verdict", "noise"] },
    });
    expect(decodeControlRequest(result)).toEqual({ ok: true, value: result });
    for (const request of [
      { ...result, raw: "{}", args: ["--a"] },
      { ...result, args: [] },
      { ...result, args: ["--a"], extra: true },
    ]) {
      expect(decodeControlRequest(request)).toMatchObject({ ok: false, code: "invalid-request" });
    }
  });

  test("a call's answers: its result, its failure, and its own refusals only", () => {
    const version = WIRE_VERSION;
    for (const response of [
      { version, kind: "tool-result", output: "Closed." },
      { version, kind: "tool-result" },
      { version, kind: "tool-failed", outcome: "timed-out", error: "may have run", owing: "x" },
      ...[...TOOL_CODES, ...ENVELOPE_CODES].map((code) => ({
        version,
        kind: "rejected",
        code,
        error: "no",
      })),
    ]) {
      expect(decodeResponseFor("tool", response)).toEqual({ ok: true, value: response as never });
    }
    for (const response of [
      { version, kind: "tool-failed", outcome: "lost", error: "x" },
      { version, kind: "tool-result", output: 1 },
      { version, kind: "accepted" },
      { version, kind: "rejected", code: "no-route", error: "x" },
    ]) {
      expect(decodeResponseFor("tool", response).ok).toBe(false);
    }
    expect(
      decodeResponseFor("result", { version, kind: "rejected", code: "tool-running", error: "x" })
        .ok,
    ).toBe(true);
  });

  test("a launcher from before tools is refused, not misread", () => {
    expect(decodeControlRequest({ ...tool, version: 4 })).toMatchObject({
      ok: false,
      code: "unsupported-version",
    });
  });
});
