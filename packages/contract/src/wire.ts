/**
 * Version 2 dropped the per-operation bearer capability. An agent reaches the control plane over a
 * socket of its own, so the connection is the authority and nothing secret crosses the wire.
 */
export const WIRE_VERSION = 2 as const;

export type ResultSubmitRequest = {
  version: typeof WIRE_VERSION;
  operationId: string;
  raw: string;
};

const RESULT_SUBMIT_CODES = [
  "unknown-operation",
  "wrong-agent",
  "expired-operation",
  "closed-operation",
  "invalid-result",
  "invalid-request",
  "unsupported-version",
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

export type WireDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "invalid-request" | "unsupported-version"; error: string };

const REQUEST_FIELDS = ["version", "operationId", "raw"] as const;
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
  return {
    ok: true,
    value: {
      version: WIRE_VERSION,
      operationId: request.operationId,
      raw: request.raw,
    },
  };
}

export function decodeResultSubmitResponse(
  value: unknown,
): WireDecodeResult<ResultSubmitResponse> {
  const envelope = checkEnvelope(value, "response");
  if (!envelope.ok) return envelope;
  const response = envelope.value;
  if (response.kind === "accepted") {
    const fields = Object.keys(response);
    if (fields.length !== 2) return invalid("accepted response has unexpected fields");
    return { ok: true, value: { version: WIRE_VERSION, kind: "accepted" } };
  }
  if (response.kind !== "rejected") return invalid("response.kind must be accepted or rejected");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
