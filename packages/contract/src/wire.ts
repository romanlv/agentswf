import { isRecord } from "./schema";

/**
 * Version 5 adds `tool`, a call of one of the agent's tools, and a result given as flags, `args`.
 * Version 4 added messaging: `peers`, `send` and `reply`, which name no call id, and the line every
 * response leads with about what the agent's open operation owes or awaits. The per-agent
 * connection remains the authority.
 */
export const WIRE_VERSION = 5 as const;

/**
 * An input as `wf` was given it, which it sends without knowing the schema: `raw`, JSON from standard
 * input, or `args`, the words after the call id or tool name, which the engine reads as flags by
 * the schema. Neither is no input, `{}` to a schema.
 */
export type GivenInput = { raw?: string; args?: never } | { args?: string[]; raw?: never };

export type ResultSubmitRequest = {
  version: typeof WIRE_VERSION;
  command: "result";
  operationId: string;
  /**
   * The harness's own session id, where the agent's shell names one. Added within version 2: the
   * engine installs the `wf` its agents run, so client and engine always ship together.
   */
  session?: string;
} & GivenInput;

export type WaitingRequest = {
  version: typeof WIRE_VERSION;
  command: "waiting";
  operationId: string;
  reason: string;
  timeoutMs?: number;
  session?: string;
};

/** The agent's routes and its peers' states, as `wf peers` shows them. */
export type PeersRequest = {
  version: typeof WIRE_VERSION;
  command: "peers";
  session?: string;
};

/**
 * A message to `peer`, bound to the agent's open operation when the engine accepts it. `reply`
 * answers the question `peer` asked; with `awaitReply` either one asks.
 */
export type MessageRequest = {
  version: typeof WIRE_VERSION;
  command: "send" | "reply";
  peer: string;
  text: string;
  awaitReply?: true;
  /** Shortens the wait for the answer; only with `awaitReply`. */
  timeoutMs?: number;
  session?: string;
};

/** A call of the agent's tool `tool`, bound to its open operation when the engine accepts it. */
export type ToolRequest = {
  version: typeof WIRE_VERSION;
  command: "tool";
  tool: string;
  session?: string;
} & GivenInput;

export type ControlRequest =
  | ResultSubmitRequest
  | WaitingRequest
  | PeersRequest
  | MessageRequest
  | ToolRequest;
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

/** Refusals of a request itself, which any command can get. */
export const ENVELOPE_CODES = [
  "invalid-request",
  "unsupported-version",
  "unsupported-command",
  "request-too-large",
  "internal-error",
] as const;

/** `wf result`'s and `wf waiting`'s own refusals. */
export const RESULT_CODES = [
  "unknown-operation",
  "wrong-agent",
  "expired-operation",
  "closed-operation",
  "invalid-result",
  /** While the operation owes an answer. */
  "owes-reply",
  /** Given a message operation's call id. */
  "no-result",
  /** While a tool call of the operation runs. */
  "tool-running",
] as const;

/** A send's refusals, in the order they are checked. */
export const SEND_CODES = [
  "no-operation",
  "no-route",
  "peer-stopped",
  "closed",
  "too-large",
  "awaiting",
  "unsupported",
  "cycle",
  "limit",
  "inbox-full",
] as const;

/** A reply's refusals, in the order they are checked; the last four only with `awaitReply`. */
export const REPLY_CODES = [
  "no-operation",
  "none-owed",
  "expired",
  "closed",
  "too-large",
  "awaiting",
  "unsupported",
  "cycle",
  "limit",
] as const;

/** A tool call's refusals, in the order they are checked; none ran the handler. */
export const TOOL_CODES = [
  "no-operation",
  /** The operation's result is accepted, so it is ending. */
  "result-accepted",
  /** Another call of this agent's is running. */
  "tool-busy",
  "unknown-tool",
  "invalid-input",
] as const;

/**
 * Why `awf reply` or `awf send` was refused, in the order checked; the first that applies is
 * returned. `expired` is a reply's `--to` naming anything but an open question from that agent to
 * this coordinator, `--as` included, or no `--to` with none open; like `wf reply`'s, it comes
 * before the route's state.
 */
export const HOLDER_CODES = [
  "not-found",
  "ended",
  "no-coordinator",
  "unknown-agent",
  "ambiguous",
  "expired",
  "no-route",
  "stopped",
  "closed",
  "too-large",
  "limit",
  "inbox-full",
] as const;

/** Why `awf inbox` read nothing: no such run, no coordinator under `--as`, a cursor it cannot use. */
export const INBOX_CODES = ["not-found", "no-coordinator", "bad-cursor"] as const;

export type EnvelopeCode = (typeof ENVELOPE_CODES)[number];
export type ResultSubmitCode = (typeof RESULT_CODES)[number] | EnvelopeCode;
export type SendCode = (typeof SEND_CODES)[number];
export type ReplyCode = (typeof REPLY_CODES)[number];
export type ToolCode = (typeof TOOL_CODES)[number];
export type HolderCode = (typeof HOLDER_CODES)[number];
export type InboxCode = (typeof INBOX_CODES)[number];
export type ControlCode = ResultSubmitCode | SendCode | ReplyCode | ToolCode;

/**
 * Leads every response while the agent's open operation owes or awaits an answer: one line, such as
 * "you owe reviewer a reply (wf reply reviewer).", which brings it back after a compaction.
 */
export type Owing = { owing?: string };

export type Rejection<Code extends ControlCode = ControlCode> = {
  version: typeof WIRE_VERSION;
  kind: "rejected";
  code: Code;
  /** The refusal as `wf` prints it after its code, naming the next action. */
  error: string;
} & Owing;

export type ResultSubmitResponse =
  | ({ version: typeof WIRE_VERSION; kind: "accepted" } & Owing)
  | Rejection<ResultSubmitCode>;

export type WaitingResponse =
  /** `deadline` is the operation's, absent when nothing around it has one. */
  | ({
      version: typeof WIRE_VERSION;
      kind: "waiting";
      waitUntil: number;
      deadline?: number;
    } & Owing)
  /**
   * `wf waiting` while the operation awaits `peer`'s answer, which it does until `until`, or, absent,
   * until an outside participant answers: it changes nothing, and a `--timeout` given with it is
   * ignored.
   */
  | ({
      version: typeof WIRE_VERSION;
      kind: "awaiting-reply";
      peer: string;
      until?: number;
      /** The acknowledgement as `wf` prints it. */
      notice: string;
    } & Owing)
  | Rejection<ResultSubmitCode>;

/** A peer as `wf peers --json` prints it. */
export type PeerView = {
  peer: string;
  /** `send` on a route from this agent, `reply` on one only to it, `both` either way. */
  can: "send" | "reply" | "both";
  /** `outside` is a participant outside the run, such as a coordinator: never busy, `queued` 0. */
  state: "not-started" | "working" | "idle" | "awaiting" | "stopped" | "outside";
  /** Whose answer it awaits, when `awaiting`. */
  awaits?: string;
  /** Why it stopped, when `stopped`. */
  reason?: string;
  /** This agent's messages it has not been shown yet. */
  queued: number;
  purpose: string;
};

export type PeersResponse =
  | ({
      version: typeof WIRE_VERSION;
      kind: "peers";
      peers: PeerView[];
      /** Who the open operation owes an answer. */
      owes: string[];
      /** Whose answer it awaits, and until when; no `until` for an outside participant's with no limit. */
      awaits?: { peer: string; until?: number };
      /** The table `wf peers` prints. */
      text: string;
    } & Owing)
  | Rejection<EnvelopeCode>;

/**
 * A message admitted: `message` numbers it in the run's record; `until` ends a wait it began, and
 * is absent for a wait on an outside participant with no limit, as for a message that awaits none.
 */
export type MessageResponse =
  | ({
      version: typeof WIRE_VERSION;
      kind: "sent";
      message: number;
      until?: number;
      /** The acknowledgement as `wf` prints it. */
      notice: string;
    } & Owing)
  | Rejection<SendCode | ReplyCode | EnvelopeCode>;

/**
 * A call the handler ended: `tool-result` with what `wf tool` prints, absent when it returned
 * nothing; `tool-failed` when it threw or returned what can't be sent, `failed`, or its budget
 * passed or its operation ended first, so it may have done its work, `timed-out` or `cancelled`.
 */
export type ToolResponse =
  | ({ version: typeof WIRE_VERSION; kind: "tool-result"; output?: string } & Owing)
  | ({
      version: typeof WIRE_VERSION;
      kind: "tool-failed";
      outcome: ToolFailure;
      /** The failure as `wf` prints it, naming the next action. */
      error: string;
    } & Owing)
  | Rejection<ToolCode | EnvelopeCode>;

export type ToolFailure = "failed" | "timed-out" | "cancelled";

export type ControlResponse =
  | ResultSubmitResponse
  | WaitingResponse
  | PeersResponse
  | MessageResponse
  | ToolResponse
  | Rejection;

export type WireDecodeResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: "invalid-request" | "unsupported-version" | "unsupported-command";
      error: string;
    };

const REQUEST_FIELDS = ["version", "command", "operationId", "raw", "args", "session"] as const;
const RESPONSE_CODES = new Set<ControlCode>([
  ...ENVELOPE_CODES,
  ...RESULT_CODES,
  ...SEND_CODES,
  ...REPLY_CODES,
  ...TOOL_CODES,
]);
const TOOL_FAILURES = new Set<string>(["failed", "timed-out", "cancelled"] satisfies ToolFailure[]);

/** What each command's response may be. */
export type ResponseFor = {
  result: ResultSubmitResponse;
  waiting: WaitingResponse;
  peers: PeersResponse;
  send: MessageResponse;
  reply: MessageResponse;
  tool: ToolResponse;
};

const ANSWERS: {
  [C in keyof ResponseFor]: { kinds: readonly string[]; codes: readonly ControlCode[] };
} = {
  result: { kinds: ["accepted"], codes: [...ENVELOPE_CODES, ...RESULT_CODES] },
  waiting: { kinds: ["waiting", "awaiting-reply"], codes: [...ENVELOPE_CODES, ...RESULT_CODES] },
  peers: { kinds: ["peers"], codes: ENVELOPE_CODES },
  send: { kinds: ["sent"], codes: [...ENVELOPE_CODES, ...SEND_CODES] },
  reply: { kinds: ["sent"], codes: [...ENVELOPE_CODES, ...REPLY_CODES] },
  tool: { kinds: ["tool-result", "tool-failed"], codes: [...ENVELOPE_CODES, ...TOOL_CODES] },
};

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
  if (extraFields(request, REQUEST_FIELDS)) return invalid("request has unexpected fields");
  if (!nonEmpty(request.operationId)) {
    return invalid("request.operationId must be a non-empty string");
  }
  const given = decodeGivenInput(request);
  if (!given.ok) return given;
  if (!optionalNonEmpty(request.session)) {
    return invalid("request.session must be a non-empty string when present");
  }
  return {
    ok: true,
    value: {
      version: WIRE_VERSION,
      command: "result",
      operationId: request.operationId,
      ...given.value,
      ...(request.session === undefined ? {} : { session: request.session }),
    },
  };
}

function decodeGivenInput(request: Record<string, unknown>): WireDecodeResult<GivenInput> {
  const { raw, args } = request;
  if (raw !== undefined && args !== undefined) return invalid("request has both raw and args");
  if (raw !== undefined) {
    if (typeof raw !== "string" || raw.trim() === "")
      return invalid("request.raw must be a non-empty string when present");
    return { ok: true, value: { raw } };
  }
  if (args !== undefined) {
    if (!Array.isArray(args) || args.length === 0 || !args.every((arg) => typeof arg === "string"))
      return invalid("request.args must be a non-empty list of strings when present");
    return { ok: true, value: { args: [...args] } };
  }
  return { ok: true, value: {} };
}

/**
 * A holder's request on a run's coordinator socket, as `awf reply` and `awf send` make it: speaking
 * as `coordinator` (`--as`), to the agent at its peer address, answering question `to`
 * (`{attempt}.{n}`) for a reply. Internal: holders run the commands, which ship with the engine
 * that answers them; one this engine cannot decode is closed unanswered. The response is a
 * `HolderResultJson`.
 * @internal
 */
export type HolderWireRequest = {
  version: typeof WIRE_VERSION;
  command: "reply" | "send";
  coordinator?: string;
  agent: string;
  to?: string;
  text: string;
};

/**
 * awf telling a live run of a workflow with `events` that its mailbox has a new event, which its
 * wait then reads; answered `{ v: 1, code: "nudged" }`. Only a wake: the event is already appended,
 * so a nudge that fails loses nothing.
 * @internal
 */
export type NudgeWireRequest = { version: typeof WIRE_VERSION; command: "nudge" };

/** @internal */
export type NudgeWireResult = { v: 1; code: "nudged" };

export function decodeHolderRequest(
  value: unknown,
): WireDecodeResult<HolderWireRequest | NudgeWireRequest> {
  const envelope = checkEnvelope(value, "request");
  if (!envelope.ok) return envelope;
  const request = envelope.value;
  if (request.command === "nudge")
    return extraFields(request, ["version", "command"])
      ? invalid("request has unexpected fields")
      : { ok: true, value: { version: WIRE_VERSION, command: "nudge" } };
  if (request.command !== "reply" && request.command !== "send")
    return {
      ok: false,
      code: "unsupported-command",
      error: "request.command must be reply, send or nudge",
    };
  if (extraFields(request, ["version", "command", "coordinator", "agent", "to", "text"]))
    return invalid("request has unexpected fields");
  if (!optionalNonEmpty(request.coordinator))
    return invalid("request.coordinator must be a non-empty string when present");
  if (!nonEmpty(request.agent)) return invalid("request.agent must be an agent's address");
  if (
    request.to !== undefined &&
    (request.command !== "reply" || !/^\d+\.\d+$/.test(String(request.to)))
  )
    return invalid("request.to is a question's id, {attempt}.{n}, and only on a reply");
  if (!nonEmpty(request.text)) return invalid("request.text must be a non-blank string");
  return {
    ok: true,
    value: {
      version: WIRE_VERSION,
      command: request.command,
      ...(request.coordinator === undefined ? {} : { coordinator: request.coordinator }),
      agent: request.agent,
      ...(request.to === undefined ? {} : { to: request.to as string }),
      text: request.text,
    },
  };
}

export function decodeControlRequest(value: unknown): WireDecodeResult<ControlRequest> {
  const envelope = checkEnvelope(value, "request");
  if (!envelope.ok) return envelope;
  const request = envelope.value;
  switch (request.command) {
    case "result":
      return decodeResultSubmitRequest(request);
    case "waiting":
      return decodeWaitingRequest(request);
    case "peers":
      return decodePeersRequest(request);
    case "send":
    case "reply":
      return decodeMessageRequest(request, request.command);
    case "tool":
      return decodeToolRequest(request);
    default:
      return {
        ok: false,
        code: "unsupported-command",
        error: "request.command must be result, waiting, peers, send, reply or tool",
      };
  }
}

function decodeToolRequest(request: Record<string, unknown>): WireDecodeResult<ToolRequest> {
  if (extraFields(request, ["version", "command", "tool", "raw", "args", "session"]))
    return invalid("request has unexpected fields");
  if (!nonEmpty(request.tool)) return invalid("request.tool must be a non-empty string");
  const given = decodeGivenInput(request);
  if (!given.ok) return given;
  if (!optionalNonEmpty(request.session))
    return invalid("request.session must be a non-empty string when present");
  return {
    ok: true,
    value: {
      version: WIRE_VERSION,
      command: "tool",
      tool: request.tool,
      ...given.value,
      ...(request.session === undefined ? {} : { session: request.session }),
    },
  };
}

function decodeWaitingRequest(request: Record<string, unknown>): WireDecodeResult<WaitingRequest> {
  if (extraFields(request, ["version", "command", "operationId", "reason", "timeoutMs", "session"]))
    return invalid("request has unexpected fields");
  if (!nonEmpty(request.operationId))
    return invalid("request.operationId must be a non-empty string");
  if (!validWaitingReason(request.reason))
    return invalid("request.reason must be non-blank and at most 2048 UTF-8 bytes");
  if (request.timeoutMs !== undefined && !positiveInteger(request.timeoutMs))
    return invalid("request.timeoutMs must be a positive safe integer when present");
  if (!optionalNonEmpty(request.session))
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

function decodePeersRequest(request: Record<string, unknown>): WireDecodeResult<PeersRequest> {
  if (extraFields(request, ["version", "command", "session"]))
    return invalid("request has unexpected fields");
  if (!optionalNonEmpty(request.session))
    return invalid("request.session must be a non-empty string when present");
  return {
    ok: true,
    value: {
      version: WIRE_VERSION,
      command: "peers",
      ...(request.session === undefined ? {} : { session: request.session }),
    },
  };
}

function decodeMessageRequest(
  request: Record<string, unknown>,
  command: "send" | "reply",
): WireDecodeResult<MessageRequest> {
  if (
    extraFields(request, [
      "version",
      "command",
      "peer",
      "text",
      "awaitReply",
      "timeoutMs",
      "session",
    ])
  )
    return invalid("request has unexpected fields");
  if (!nonEmpty(request.peer) || request.peer !== request.peer.trim())
    return invalid("request.peer must be a peer's key, without surrounding spaces");
  if (!nonEmpty(request.text)) return invalid("request.text must be a non-blank string");
  if (request.awaitReply !== undefined && request.awaitReply !== true)
    return invalid("request.awaitReply must be true when present");
  if (request.timeoutMs !== undefined) {
    if (!positiveInteger(request.timeoutMs))
      return invalid("request.timeoutMs must be a positive safe integer when present");
    if (request.awaitReply !== true) return invalid("request.timeoutMs needs awaitReply");
  }
  if (!optionalNonEmpty(request.session))
    return invalid("request.session must be a non-empty string when present");
  return {
    ok: true,
    value: {
      version: WIRE_VERSION,
      command,
      peer: request.peer,
      text: request.text,
      ...(request.awaitReply ? { awaitReply: true as const } : {}),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.session === undefined ? {} : { session: request.session }),
    },
  };
}

export function decodeControlResponse(value: unknown): WireDecodeResult<ControlResponse> {
  const envelope = checkEnvelope(value, "response");
  if (!envelope.ok) return envelope;
  const response = envelope.value;
  if (!optionalNonEmpty(response.owing))
    return invalid("response.owing must be a non-empty string when present");
  const owing = response.owing === undefined ? {} : { owing: response.owing };
  const version = WIRE_VERSION;
  switch (response.kind) {
    case "accepted":
      if (extraFields(response, ["version", "kind", "owing"]))
        return invalid("accepted response has unexpected fields");
      return { ok: true, value: { version, kind: "accepted", ...owing } };
    case "waiting": {
      if (extraFields(response, ["version", "kind", "waitUntil", "deadline", "owing"]))
        return invalid("waiting response has unexpected fields");
      const { waitUntil, deadline } = response;
      if (!time(waitUntil) || (deadline !== undefined && (!time(deadline) || deadline < waitUntil)))
        return invalid(
          "waiting response requires non-negative integer times with waitUntil <= deadline",
        );
      return {
        ok: true,
        value: {
          version,
          kind: "waiting",
          waitUntil,
          ...(deadline === undefined ? {} : { deadline }),
          ...owing,
        },
      };
    }
    case "awaiting-reply": {
      if (extraFields(response, ["version", "kind", "peer", "until", "notice", "owing"]))
        return invalid("awaiting-reply response has unexpected fields");
      const { peer, until, notice } = response;
      if (!nonEmpty(peer)) return invalid("response.peer must be a non-empty string");
      if (until !== undefined && !time(until))
        return invalid("response.until must be a non-negative integer time when present");
      if (!nonEmpty(notice)) return invalid("response.notice must be a non-empty string");
      return {
        ok: true,
        value: {
          version,
          kind: "awaiting-reply",
          peer,
          ...(until === undefined ? {} : { until }),
          notice,
          ...owing,
        },
      };
    }
    case "peers":
      return decodePeersResponse(response, owing);
    case "sent": {
      if (extraFields(response, ["version", "kind", "message", "until", "notice", "owing"]))
        return invalid("sent response has unexpected fields");
      const { message, until, notice } = response;
      if (typeof message !== "number" || !Number.isSafeInteger(message) || message < 1)
        return invalid("response.message must be a positive integer");
      if (until !== undefined && !time(until))
        return invalid("response.until must be a non-negative integer time when present");
      if (!nonEmpty(notice)) return invalid("response.notice must be a non-empty string");
      return {
        ok: true,
        value: {
          version,
          kind: "sent",
          message,
          ...(until === undefined ? {} : { until }),
          notice,
          ...owing,
        },
      };
    }
    case "tool-result": {
      if (extraFields(response, ["version", "kind", "output", "owing"]))
        return invalid("tool-result response has unexpected fields");
      const { output } = response;
      if (output !== undefined && typeof output !== "string")
        return invalid("response.output must be a string when present");
      return {
        ok: true,
        value: {
          version,
          kind: "tool-result",
          ...(output === undefined ? {} : { output }),
          ...owing,
        },
      };
    }
    case "tool-failed": {
      if (extraFields(response, ["version", "kind", "outcome", "error", "owing"]))
        return invalid("tool-failed response has unexpected fields");
      const { outcome, error } = response;
      if (!TOOL_FAILURES.has(outcome as string))
        return invalid("response.outcome must be failed, timed-out or cancelled");
      if (!nonEmpty(error)) return invalid("response.error must be a non-empty string");
      return {
        ok: true,
        value: { version, kind: "tool-failed", outcome: outcome as ToolFailure, error, ...owing },
      };
    }
    case "rejected": {
      if (extraFields(response, ["version", "kind", "code", "error", "owing"]))
        return invalid("rejected response has unexpected fields");
      if (!RESPONSE_CODES.has(response.code as ControlCode))
        return invalid("response.code is not recognized");
      if (!nonEmpty(response.error)) return invalid("response.error must be a non-empty string");
      return {
        ok: true,
        value: {
          version,
          kind: "rejected",
          code: response.code as ControlCode,
          error: response.error,
          ...owing,
        },
      };
    }
    default:
      return invalid(
        "response.kind must be accepted, waiting, awaiting-reply, peers, sent, tool-result, tool-failed or rejected",
      );
  }
}

const PEER_STATES = new Set(["not-started", "working", "idle", "awaiting", "stopped", "outside"]);
const PEER_ABILITIES = new Set(["send", "reply", "both"]);

function decodePeersResponse(
  response: Record<string, unknown>,
  owing: Owing,
): WireDecodeResult<ControlResponse> {
  if (extraFields(response, ["version", "kind", "peers", "owes", "awaits", "text", "owing"]))
    return invalid("peers response has unexpected fields");
  const { peers, owes, awaits, text } = response;
  if (!Array.isArray(owes) || !owes.every(nonEmpty))
    return invalid("response.owes must be a list of peers");
  if (
    awaits !== undefined &&
    !(
      isRecord(awaits) &&
      !extraFields(awaits, ["peer", "until"]) &&
      nonEmpty(awaits.peer) &&
      (awaits.until === undefined || time(awaits.until))
    )
  )
    return invalid("response.awaits must name a peer and a time when present");
  if (typeof text !== "string") return invalid("response.text must be a string");
  if (!Array.isArray(peers)) return invalid("response.peers must be a list");
  const views: PeerView[] = [];
  for (const each of peers) {
    if (
      !isRecord(each) ||
      extraFields(each, ["peer", "can", "state", "awaits", "reason", "queued", "purpose"]) ||
      !nonEmpty(each.peer) ||
      !PEER_ABILITIES.has(each.can as string) ||
      !PEER_STATES.has(each.state as string) ||
      !optionalNonEmpty(each.awaits) ||
      !optionalNonEmpty(each.reason) ||
      typeof each.queued !== "number" ||
      !Number.isSafeInteger(each.queued) ||
      each.queued < 0 ||
      typeof each.purpose !== "string"
    )
      return invalid("response.peers holds a malformed peer");
    views.push({
      peer: each.peer,
      can: each.can as PeerView["can"],
      state: each.state as PeerView["state"],
      ...(each.awaits === undefined ? {} : { awaits: each.awaits }),
      ...(each.reason === undefined ? {} : { reason: each.reason }),
      queued: each.queued,
      purpose: each.purpose,
    });
  }
  return {
    ok: true,
    value: {
      version: WIRE_VERSION,
      kind: "peers",
      peers: views,
      owes: owes as string[],
      ...(isRecord(awaits)
        ? {
            awaits: {
              peer: awaits.peer as string,
              ...(awaits.until === undefined ? {} : { until: awaits.until as number }),
            },
          }
        : {}),
      text,
      ...owing,
    },
  };
}

function invalid(error: string): WireDecodeResult<never> {
  return { ok: false, code: "invalid-request", error };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function optionalNonEmpty(value: unknown): value is string | undefined {
  return value === undefined || nonEmpty(value);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function time(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function extraFields(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).some((key) => !allowed.includes(key));
}

/** A response to `command`: one of its acknowledgements, or a refusal with one of its codes. */
export function decodeResponseFor<C extends keyof ResponseFor>(
  command: C,
  value: unknown,
): WireDecodeResult<ResponseFor[C]> {
  const decoded = decodeControlResponse(value);
  if (!decoded.ok) return decoded;
  const response = decoded.value;
  const { kinds, codes } = ANSWERS[command];
  const fits =
    response.kind === "rejected" ? codes.includes(response.code) : kinds.includes(response.kind);
  if (!fits) {
    const what = response.kind === "rejected" ? `refusal ${response.code}` : response.kind;
    return invalid(`the control plane answered ${command} with ${what}, for a different command`);
  }
  // Checked against the command's own answers above.
  return { ok: true, value: response as ResponseFor[C] };
}

export function decodeResultSubmitResponse(value: unknown): WireDecodeResult<ResultSubmitResponse> {
  return decodeResponseFor("result", value);
}
