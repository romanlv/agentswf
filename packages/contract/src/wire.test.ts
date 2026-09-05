import { describe, expect, test } from "bun:test";
import {
  WIRE_VERSION,
  decodeResultSubmitRequest,
  decodeResultSubmitResponse,
} from "./wire";

const CAPABILITY = "A".repeat(43);

describe("result-submit wire", () => {
  test("decodes one exact versioned request", () => {
    expect(
      decodeResultSubmitRequest({
        version: WIRE_VERSION,
        operationId: "op-1",
        capability: CAPABILITY,
        raw: '{"verdict":"approve"}',
      }),
    ).toEqual({
      ok: true,
      value: {
        version: WIRE_VERSION,
        operationId: "op-1",
        capability: CAPABILITY,
        raw: '{"verdict":"approve"}',
      },
    });
  });

  test("rejects unsupported versions separately from malformed requests", () => {
    expect(
      decodeResultSubmitRequest({
        version: 2,
        operationId: "op-1",
        capability: CAPABILITY,
        raw: "{}",
      }),
    ).toMatchObject({ ok: false, code: "unsupported-version" });
    expect(
      decodeResultSubmitRequest({
        operationId: "op-1",
        capability: CAPABILITY,
        raw: "{}",
      }),
    ).toMatchObject({ ok: false, code: "invalid-request" });
    expect(
      decodeResultSubmitRequest({
        version: "1",
        operationId: "op-1",
        capability: CAPABILITY,
        raw: "{}",
      }),
    ).toMatchObject({ ok: false, code: "invalid-request" });
  });

  test("rejects extra, empty, and malformed authority fields", () => {
    const extra =
      decodeResultSubmitRequest({
        version: 1,
        operationId: "op-1",
        capability: CAPABILITY,
        raw: "{}",
        extra: true,
      });
    expect(extra).toMatchObject({ ok: false, code: "invalid-request" });
    expect(JSON.stringify(extra)).not.toContain("extra");
    expect(
      decodeResultSubmitRequest({
        version: 1,
        operationId: "",
        capability: "short",
        raw: "",
      }),
    ).toMatchObject({ ok: false, code: "invalid-request" });
  });

  test("decodes accepted and rejected responses without accepting extra fields", () => {
    expect(decodeResultSubmitResponse({ version: 1, kind: "accepted" })).toEqual({
      ok: true,
      value: { version: 1, kind: "accepted" },
    });
    expect(
      decodeResultSubmitResponse({
        version: 1,
        kind: "rejected",
        code: "invalid-result",
        error: "value.count: expected an integer",
      }),
    ).toMatchObject({ ok: true });
    expect(
      decodeResultSubmitResponse({ version: 1, kind: "accepted", capability: CAPABILITY }),
    ).toMatchObject({ ok: false });
    expect(decodeResultSubmitResponse({ kind: "accepted" })).toMatchObject({
      ok: false,
      code: "invalid-request",
    });
    expect(decodeResultSubmitResponse({ version: 2, kind: "accepted" })).toMatchObject({
      ok: false,
      code: "unsupported-version",
    });
  });
});
