import { isRecord } from "./schema";

/**
 * Version 3 discriminates result submissions from cooperative waiting declarations.
 * The per-agent connection remains the authority.
 */
export const WIRE_VERSION = 3 as const;

export type ResultSubmitRequest = {
  version: typeof WIRE_VERSION;
  command: "result";
  operationId: string;
  raw: string;
  /**
   * The harness's own session id, where the agent's shell names one. Added within version 2: the
   * engine installs the `wf` its agents run, so client and engine always ship together.
   */
  session?: string;
};

export type WaitingRequest = {
  version: typeof WIRE_VERSION;
  command: "waiting";
  operationId: string;
  reason: string;
  timeoutMs?: number;
  session?: string;
};

export type ControlRequest = ResultSubmitRequest | WaitingRequest;
export const MAX_WAITING_REASON_BYTES = 2048;

export function validWaitingReason(value: unknown): value is string {
  if (!nonEmpty(value)) return false;
  let bytes = 0;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MAX_WAITING_REASON_BYTES) return false;
  }
  return true;
}

const RESULT_SUBMIT_CODES = [
  "unknown-operation",
  "wrong-agent",
  "expired-operation",
  "closed-operation",
  "invalid-result",
  "invalid-request",
  "unsupported-version",
  "unsupported-command",
  "request-too-large",
  "internal-error",
] as const;

export type ResultSubmitCode = (typeof RESULT_SUBMIT_CODES)[number];

export type ResultSubmitResponse =
  | { version: typeof WIRE_VERSION; kind: "accepted" }
  | {
      version: typeof WIRE_VERSION;
      kind: "rejected";
      code: ResultSubmitCode;
      error: string;
    };

export type WaitingResponse =
  | { version: typeof WIRE_VERSION; kind: "waiting"; waitUntil: number; deadline: number }
  | Extract<ResultSubmitResponse, { kind: "rejected" }>;
export type ControlResponse = ResultSubmitResponse | WaitingResponse;

export type WireDecodeResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: "invalid-request" | "unsupported-version" | "unsupported-command";
      error: string;
    };

const REQUEST_FIELDS = ["version", "command", "operationId", "raw", "session"] as const;
const RESPONSE_CODES = new Set<ResultSubmitCode>(RESULT_SUBMIT_CODES);

function checkEnvelope(value: unknown, label: string): WireDecodeResult<Record<string, unknown>> {
  if (!isRecord(value)) return invalid(`${label} must be a JSON object`);
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version)) {
    return invalid(`${label}.version must be an integer`);
  }
  if (value.version !== WIRE_VERSION) {
    return {
      ok: false,
      code: "unsupported-version",
      error: `unsupported wire version; expected ${WIRE_VERSION}`,
    };
  }
  return { ok: true, value };
}

export function decodeResultSubmitRequest(value: unknown): WireDecodeResult<ResultSubmitRequest> {
  const envelope = checkEnvelope(value, "request");
  if (!envelope.ok) return envelope;
  const request = envelope.value;
  if (request.command !== "result") return invalid("request.command must be result");
  const extra = Object.keys(request).some(
    (key) => !REQUEST_FIELDS.includes(key as (typeof REQUEST_FIELDS)[number]),
  );
  if (extra) return invalid("request has unexpected fields");
  if (!nonEmpty(request.operationId)) {
    return invalid("request.operationId must be a non-empty string");
  }
  if (typeof request.raw !== "string" || request.raw.trim() === "") {
    return invalid("request.raw must be a non-empty string");
  }
  if (request.session !== undefined && !nonEmpty(request.session)) {
    return invalid("request.session must be a non-empty string when present");
  }
  return {
    ok: true,
    value: {
      version: WIRE_VERSION,
      command: "result",
      operationId: request.operationId,
      raw: request.raw,
      ...(request.session === undefined ? {} : { session: request.session }),
    },
  };
}

export function decodeControlRequest(value: unknown): WireDecodeResult<ControlRequest> {
  const envelope = checkEnvelope(value, "request");
  if (!envelope.ok) return envelope;
  const request = envelope.value;
  if (request.command === "result") return decodeResultSubmitRequest(request);
  if (request.command !== "waiting")
    return {
      ok: false,
      code: "unsupported-command",
      error: "request.command must be result or waiting",
    };
  if (
    Object.keys(request).some(
      (key) =>
        !["version", "command", "operationId", "reason", "timeoutMs", "session"].includes(key),
    )
  )
    return invalid("request has unexpected fields");
  if (!nonEmpty(request.operationId))
    return invalid("request.operationId must be a non-empty string");
  if (!validWaitingReason(request.reason))
    return invalid("request.reason must be non-blank and at most 2048 UTF-8 bytes");
  if (
    request.timeoutMs !== undefined &&
    (typeof request.timeoutMs !== "number" ||
      !Number.isSafeInteger(request.timeoutMs) ||
      request.timeoutMs <= 0)
  )
    return invalid("request.timeoutMs must be a positive safe integer when present");
  if (request.session !== undefined && !nonEmpty(request.session))
    return invalid("request.session must be a non-empty string when present");
  return {
    ok: true,
    value: {
      version: WIRE_VERSION,
      command: "waiting",
      operationId: request.operationId,
      reason: request.reason,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.session === undefined ? {} : { session: request.session }),
    },
  };
}

export function decodeControlResponse(value: unknown): WireDecodeResult<ControlResponse> {
  const envelope = checkEnvelope(value, "response");
  if (!envelope.ok) return envelope;
  const response = envelope.value;
  if (response.kind === "accepted") {
    const fields = Object.keys(response);
    if (fields.length !== 2) return invalid("accepted response has unexpected fields");
    return { ok: true, value: { version: WIRE_VERSION, kind: "accepted" } };
  }
  if (response.kind === "waiting") {
    if (
      Object.keys(response).some(
        (key) => !["version", "kind", "waitUntil", "deadline"].includes(key),
      )
    )
      return invalid("waiting response has unexpected fields");
    if (
      typeof response.waitUntil !== "number" ||
      !Number.isSafeInteger(response.waitUntil) ||
      response.waitUntil < 0 ||
      typeof response.deadline !== "number" ||
      !Number.isSafeInteger(response.deadline) ||
      response.deadline < response.waitUntil
    )
      return invalid(
        "waiting response requires non-negative integer times with waitUntil <= deadline",
      );
    return {
      ok: true,
      value: {
        version: WIRE_VERSION,
        kind: "waiting",
        waitUntil: response.waitUntil,
        deadline: response.deadline,
      },
    };
  }
  if (response.kind !== "rejected")
    return invalid("response.kind must be accepted, waiting or rejected");
  if (Object.keys(response).some((key) => !["version", "kind", "code", "error"].includes(key))) {
    return invalid("rejected response has unexpected fields");
  }
  if (!RESPONSE_CODES.has(response.code as ResultSubmitCode)) {
    return invalid("response.code is not recognized");
  }
  if (!nonEmpty(response.error)) return invalid("response.error must be a non-empty string");
  return {
    ok: true,
    value: {
      version: WIRE_VERSION,
      kind: "rejected",
      code: response.code as ResultSubmitCode,
      error: response.error,
    },
  };
}

function invalid(error: string): WireDecodeResult<never> {
  return { ok: false, code: "invalid-request", error };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function decodeResultSubmitResponse(value: unknown): WireDecodeResult<ResultSubmitResponse> {
  const decoded = decodeControlResponse(value);
  if (!decoded.ok) return decoded;
  if (decoded.value.kind === "waiting")
    return invalid("result response must be accepted or rejected");
  return { ok: true, value: decoded.value };
}
