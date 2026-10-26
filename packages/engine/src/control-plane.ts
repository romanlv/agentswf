import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ControlResponse,
  decodeControlRequest,
  type GivenInput,
  WIRE_VERSION,
} from "@agentswf/contract/wire";
import { isCode } from "./files";
import type { Messaging } from "./messaging/messaging";
import { UNRECORDED } from "./messaging/text";
import type { ResultSlotRegistry } from "./result-slots";
import type { ToolCalls } from "./tools";

/** What the control plane asks of the run's tools, by the agent whose socket asked. */
export type ToolHandler = Pick<ToolCalls<unknown>, "call" | "running" | "accepted">;

/** What the control plane asks of the run's messaging, by the agent whose socket asked. */
export type MessagingHandler = Pick<
  Messaging,
  "checkFinish" | "peers" | "send" | "reply" | "owing"
>;

/** `wf` accepts a 1 MiB value; escaped into the request's JSON it can double, plus the envelope. */
const MAX_RESULT_REQUEST_BYTES = 2 * 1024 * 1024 + 4 * 1024;
const MAX_CONTROL_CONNECTIONS = 64;
const CONNECTION_TIMEOUT_SECONDS = 30;
const MAX_TIMER_MS = 2_147_483_647;

export type ResultChannel = {
  /** The socket this agent's launcher connects to. */
  endpoint: string;
  close(): Promise<void>;
};

export type ResultControlPlane = {
  /**
   * One socket per agent, in its own directory with an unguessable name, under a root an agent
   * cannot list. That is what makes the connection worth trusting: no secret has to reach the
   * agent, and no agent is handed a way to find another's socket.
   *
   * It is not isolation. Every agent runs as the same user as the engine, so one that goes looking
   * — through the engine's own open descriptors, say — can still reach a sibling. Separating
   * agents that share a uid needs a uid per agent, which is a sandbox question, not a socket one.
   */
  openChannel(agentId: string, onSession?: (id: string) => void): Promise<ResultChannel>;
  /** The run's messaging, once it exists; until then `peers`, `send` and `reply` are refused. */
  attach(messaging: MessagingHandler): void;
  /** The run's tools, once it has them; until then `tool` is refused. */
  attachTools(tools: ToolHandler): void;
  close(): Promise<void>;
};

/**
 * `/tmp`, not the system temp dir, which on macOS is a long `/var/folders/…/T/`. Agents type the
 * launcher's path into a shell, and a cheap model was seen dropping the `/` before `T` there, every
 * retry. It also keeps sockets far inside `sun_path`, 104 bytes on macOS.
 */
export const CONTROL_PLANE_ROOT = "/tmp";

export async function startResultControlPlane(options: {
  /**
   * Where the socket directory is made; `CONTROL_PLANE_ROOT` unless a test says otherwise. A run
   * directory is no place for it: alone it can exceed `sun_path`, and Bun binds longer paths but
   * nothing else does.
   */
  socketRoot?: string;
  slots: ResultSlotRegistry;
  maxRequestBytes?: number;
  maxConnections?: number;
  connectionLifetimeMs?: number;
}): Promise<ResultControlPlane> {
  if (process.platform === "win32") {
    throw new Error("result control plane requires POSIX Unix-domain sockets");
  }
  const positive = (name: string, value: number | undefined, fallback: number): number => {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    return resolved;
  };
  const maxRequestBytes = positive(
    "maxRequestBytes",
    options.maxRequestBytes,
    MAX_RESULT_REQUEST_BYTES,
  );
  const maxConnections = positive(
    "maxConnections",
    options.maxConnections,
    MAX_CONTROL_CONNECTIONS,
  );
  const connectionLifetimeMs = positive(
    "connectionLifetimeMs",
    options.connectionLifetimeMs,
    CONNECTION_TIMEOUT_SECONDS * 1000,
  );
  const root = options.socketRoot ?? CONTROL_PLANE_ROOT;
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "awf-"));
  // Traversable but not listable: an agent reaches the one path it was given and cannot read the
  // directory to discover its siblings'. Close puts the read bit back so the tree can be removed.
  await chmod(directory, 0o300);

  let messaging: MessagingHandler | undefined;
  let tools: ToolHandler | undefined;
  // Shared across channels: the budget protects the engine, not any one agent.
  let activeConnections = 0;
  let accepting = true;
  const channels = new Set<ResultChannel>();
  // Close waits for these: a channel still being built when close runs would otherwise miss the
  // sweep and keep listening on a socket whose directory is gone.
  const opening = new Set<Promise<ResultChannel>>();

  const openChannel = (
    agentId: string,
    onSession?: (id: string) => void,
  ): Promise<ResultChannel> => {
    const pending = buildChannel(agentId, onSession).finally(() => opening.delete(pending));
    opening.add(pending);
    return pending;
  };

  const buildChannel = async (
    agentId: string,
    onSession: ((id: string) => void) | undefined,
  ): Promise<ResultChannel> => {
    if (!accepting) throw new Error("result control plane is closed");
    // Per channel, unlike the connection budget: closing one agent must not wait on a submission
    // another agent is still making.
    const activeHandlers = new Set<Promise<void>>();
    // The agent key never reaches the path: it is arbitrary length and arbitrary text, and two
    // keys that differ only outside `[A-Za-z0-9._-]` would name the same directory.
    const home = await mkdtemp(join(directory, "a"));
    await chmod(home, 0o700);
    const endpoint = join(home, "s.sock");
    let listener: Bun.UnixSocketListener<ConnectionState> | undefined;
    try {
      listener = Bun.listen<ConnectionState>({
        unix: endpoint,
        allowHalfOpen: true,
        data: emptyConnection(),
        socket: {
          open(socket) {
            socket.data = emptyConnection();
            // Absolute, not idle: the budget is the whole submission, and a trickle of bytes must
            // not extend it indefinitely.
            socket.data.lifetime = setTimeout(() => socket.terminate(), connectionLifetimeMs);
            if (activeConnections >= maxConnections) {
              // Answered rather than dropped: a silent close is indistinguishable from a crashed
              // engine, and the agent would report a result it could have simply retried. The
              // answer waits for the request's end, as one sent before it meets a closed socket.
              socket.data.refusal = rejected(
                "internal-error",
                "the control plane is at its connection limit; retry the command later",
              );
              return;
            }
            socket.data.counted = true;
            activeConnections += 1;
          },
          async data(socket, data) {
            if (socket.data.handled || socket.data.refusal) return;
            socket.data.bytes += data.byteLength;
            if (socket.data.bytes > maxRequestBytes) {
              socket.data.handled = true;
              queueResponse(
                socket,
                rejected("request-too-large", "control request exceeds the size limit"),
              );
              return;
            }
            socket.data.chunks.push(Buffer.from(data));
          },
          end(socket) {
            if (socket.data.handled) return;
            socket.data.handled = true;
            if (socket.data.refusal) {
              queueResponse(socket, socket.data.refusal);
              return;
            }
            if (!accepting) {
              socket.terminate();
              return;
            }
            // Resolved once the response is on the wire, not once it is decided: close waits on
            // this, and an agent whose accepted result went unacknowledged submits it again.
            const { promise: written, resolve } = Promise.withResolvers<void>();
            socket.data.responded = resolve;
            const handling = Promise.race([
              handleFrame(Buffer.concat(socket.data.chunks).toString("utf8"), {
                slots: options.slots,
                messaging,
                tools,
                agentId,
                onSession,
                // A tool call lasts as long as its budget, not the connection's 30 s.
                lifetime: (milliseconds) => {
                  if (socket.data.lifetime) clearTimeout(socket.data.lifetime);
                  // One past a timer's range is as good as none: the call's own end closes it.
                  socket.data.lifetime =
                    milliseconds === undefined || milliseconds > MAX_TIMER_MS
                      ? undefined
                      : setTimeout(() => socket.terminate(), milliseconds);
                },
              }),
              written.then(() => undefined),
            ])
              .then((response) => {
                if (socket.data.closed || response === undefined) return;
                queueResponse(socket, response);
              })
              .then(() => written)
              .finally(() => activeHandlers.delete(handling));
            activeHandlers.add(handling);
          },
          error(socket) {
            socket.terminate();
          },
          close(socket) {
            socket.data.closed = true;
            socket.data.responded?.();
            if (socket.data.lifetime) clearTimeout(socket.data.lifetime);
            if (socket.data.counted) {
              socket.data.counted = false;
              activeConnections -= 1;
            }
          },
          drain(socket) {
            flushResponse(socket);
          },
        },
      });
      await chmod(endpoint, 0o600).catch(ignoreMissing);
    } catch (error) {
      listener?.stop(true);
      await rm(home, { recursive: true, force: true });
      throw error;
    }
    const live = listener;

    let channelClosing: Promise<void> | undefined;
    const channel: ResultChannel = {
      endpoint,
      close() {
        channelClosing ??= (async () => {
          // Stop accepting, then let whatever is already being answered finish: taking the socket
          // away first turns an accepted submission into a connection error the agent must guess
          // at.
          live.stop(false);
          // Repeated: a connection already open can still finish its request while this waits.
          while (activeHandlers.size > 0) await Promise.allSettled([...activeHandlers]);
          live.stop(true);
          await rm(home, { recursive: true, force: true });
          channels.delete(channel);
        })();
        return channelClosing;
      },
    };
    channels.add(channel);
    if (!accepting) {
      await channel.close();
      throw new Error("result control plane is closed");
    }
    return channel;
  };

  let closing: Promise<void> | undefined;
  return {
    openChannel,
    attach(handler) {
      messaging = handler;
    },
    attachTools(handler) {
      tools = handler;
    },
    close() {
      closing ??= (async () => {
        accepting = false;
        await Promise.allSettled([...opening]);
        await Promise.allSettled([...channels].map((channel) => channel.close()));
        await chmod(directory, 0o700).catch(ignoreMissing);
        // Recursive: each agent's socket and launcher live in a directory of their own.
        await rm(directory, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}

type ConnectionState = {
  chunks: Buffer[];
  bytes: number;
  handled: boolean;
  refusal?: ControlResponse;
  outgoing?: Buffer;
  written: number;
  counted: boolean;
  closed: boolean;
  lifetime?: ReturnType<typeof setTimeout>;
  responded?: () => void;
};

function emptyConnection(): ConnectionState {
  return {
    chunks: [],
    bytes: 0,
    handled: false,
    written: 0,
    counted: false,
    closed: false,
  };
}

type Handlers = {
  slots: ResultSlotRegistry;
  messaging: MessagingHandler | undefined;
  tools: ToolHandler | undefined;
  agentId: string;
  onSession: ((id: string) => void) | undefined;
  lifetime: (milliseconds: number | undefined) => void;
};

async function handleFrame(frame: string, handlers: Handlers): Promise<ControlResponse> {
  const { messaging, agentId } = handlers;
  const response = await answerFrame(frame, handlers);
  // Leads every response, so what is owed comes back after a compaction; not one that already
  // says it, about the wait it began or the answer it is refused for.
  const repeats =
    response.kind === "awaiting-reply" ||
    (response.kind === "sent" && response.until !== undefined) ||
    (response.kind === "rejected" &&
      (response.code === "owes-reply" || response.code === "awaiting"));
  const owing = repeats ? undefined : messaging?.owing(agentId);
  return owing ? { ...response, owing } : response;
}

async function answerFrame(
  frame: string,
  { slots, messaging, tools, agentId, onSession, lifetime }: Handlers,
): Promise<ControlResponse> {
  if (!frame.endsWith("\n") || frame.slice(0, -1).includes("\n")) {
    return rejected("invalid-request", "expected exactly one newline-delimited JSON request");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.slice(0, -1));
  } catch {
    return rejected("invalid-request", "request is not valid JSON");
  }
  const decoded = decodeControlRequest(parsed);
  if (!decoded.ok) return rejected(decoded.code, decoded.error);
  // Before the result is judged: a rejected submission still proves which session sent it.
  if (decoded.value.session) onSession?.(decoded.value.session);

  const request = decoded.value;
  if (request.command === "tool") {
    if (!tools) return rejected("unsupported-command", "tools are not available in this run");
    let answer: Awaited<ReturnType<ToolHandler["call"]>>;
    try {
      answer = await tools.call(agentId, request, lifetime);
    } catch {
      return rejected("internal-error", "the tool call failed internally; it may have run");
    }
    if (answer.kind === "refused") return rejected(answer.code, answer.error);
    return { version: WIRE_VERSION, ...answer };
  }
  if (request.command !== "result" && request.command !== "waiting") {
    if (!messaging)
      return rejected("unsupported-command", "messaging is not available in this run");
    if (request.command === "peers") {
      return { version: WIRE_VERSION, kind: "peers", ...messaging.peers(agentId) };
    }
    const { peer, text } = request;
    const message = {
      peer,
      text,
      ...(request.awaitReply ? { awaitReply: request.awaitReply } : {}),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    };
    let admitted: Awaited<ReturnType<MessagingHandler["send"]>>;
    try {
      admitted =
        request.command === "send"
          ? await messaging.send(agentId, message)
          : await messaging.reply(agentId, message);
    } catch {
      // Only its record failed: it was admitted, so it may yet arrive.
      return rejected("internal-error", UNRECORDED);
    }
    if (admitted.kind === "refused") return rejected(admitted.code, admitted.error);
    const { kind: _kind, ...sent } = admitted;
    return { version: WIRE_VERSION, kind: "sent", ...sent };
  }
  // Before the slot is asked: a message operation has none, and an answer owed comes first.
  const gate = messaging?.checkFinish(agentId, request.operationId, request.command);
  const running = tools?.running(agentId);
  if (running && gate?.kind !== "refused") {
    const by =
      running.settledBy === undefined ? "" : ` by ${new Date(running.settledBy).toISOString()}`;
    return rejected(
      "tool-running",
      `your call of ${running.tool} is still running; it will have answered${by || " when it ends"}. Run this again then.`,
    );
  }
  if (gate?.kind === "refused") return rejected(gate.code, gate.error);
  if (gate?.kind === "awaiting" && request.command === "waiting") {
    const { peer, until, notice } = gate;
    return { version: WIRE_VERSION, kind: "awaiting-reply", peer, until, notice };
  }
  try {
    if (request.command === "waiting") {
      const grant = await slots.waiting({
        operationId: request.operationId,
        agentId,
        reason: request.reason,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      });
      return grant.kind === "waiting"
        ? { version: WIRE_VERSION, ...grant }
        : rejected(grant.code, grant.error);
    }
    const result = await slots.submit({
      operationId: request.operationId,
      agentId,
      ...givenOf(request),
      source: "control-plane",
    });
    if (result.kind !== "accepted") return rejected(result.code, result.error);
    tools?.accepted(request.operationId);
    return { version: WIRE_VERSION, kind: "accepted" };
  } catch {
    return rejected("internal-error", "control request failed internally");
  }
}

/** The input as the wire decoded it, without the request's other fields. */
function givenOf({ raw, args }: GivenInput): GivenInput {
  return raw !== undefined ? { raw } : args !== undefined ? { args } : {};
}

function rejected(
  code: Extract<ControlResponse, { kind: "rejected" }>["code"],
  error: string,
): ControlResponse {
  return { version: WIRE_VERSION, kind: "rejected", code, error };
}

function queueResponse(socket: Bun.Socket<ConnectionState>, response: ControlResponse): void {
  socket.data.outgoing = Buffer.from(`${JSON.stringify(response)}\n`);
  socket.data.written = 0;
  flushResponse(socket);
}

function flushResponse(socket: Bun.Socket<ConnectionState>): void {
  const outgoing = socket.data.outgoing;
  if (!outgoing) return;
  while (socket.data.written < outgoing.byteLength) {
    const written = socket.write(
      outgoing,
      socket.data.written,
      outgoing.byteLength - socket.data.written,
    );
    if (written <= 0) return;
    socket.data.written += written;
  }
  socket.data.outgoing = undefined;
  socket.end();
  socket.data.responded?.();
}

function ignoreMissing(error: unknown): void {
  if (!isCode(error, "ENOENT")) throw error;
}
