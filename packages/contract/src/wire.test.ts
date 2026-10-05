import { describe, expect, test } from "bun:test";
import {
  decodeControlRequest,
  decodeControlResponse,
  decodeResultSubmitRequest,
  decodeResultSubmitResponse,
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
  expect(decodeControlResponse(response)).toEqual({ ok: true, value: response });
  expect(decodeResultSubmitResponse(response)).toMatchObject({ ok: false });
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
