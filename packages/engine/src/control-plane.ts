import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeResultSubmitRequest,
  type ResultSubmitResponse,
  WIRE_VERSION,
} from "@wf/contract/wire";
import type { ResultSlotRegistry } from "./result-slots";

/** `wf` accepts a 1 MiB value; escaped into the request's JSON it can double, plus the envelope. */
const MAX_RESULT_REQUEST_BYTES = 2 * 1024 * 1024 + 4 * 1024;
const MAX_CONTROL_CONNECTIONS = 64;
const CONNECTION_TIMEOUT_SECONDS = 30;

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
  close(): Promise<void>;
};

export async function startResultControlPlane(options: {
  /**
   * Where the socket directory is made. Defaults to the system temp dir, and should stay there:
   * `sun_path` is 104 bytes on macOS and a run directory alone can exceed it. Bun binds longer
   * paths anyway, but nothing else does, which would put the sockets beyond every other tool.
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
  const root = options.socketRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "awf-"));
  // Traversable but not listable: an agent reaches the one path it was given and cannot read the
  // directory to discover its siblings'. Close puts the read bit back so the tree can be removed.
  await chmod(directory, 0o300);

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
            if (activeConnections >= maxConnections) {
              // Answered rather than dropped: a silent close is indistinguishable from a crashed
              // engine, and the agent would report a result it could have simply retried.
              socket.data.handled = true;
              queueResponse(
                socket,
                rejected(
                  "internal-error",
                  "the control plane is at its connection limit; submit the same result again",
                ),
              );
              return;
            }
            socket.data.counted = true;
            activeConnections += 1;
            // Absolute, not idle: the budget is the whole submission, and a trickle of bytes must
            // not extend it indefinitely.
            socket.data.lifetime = setTimeout(() => socket.terminate(), connectionLifetimeMs);
          },
          async data(socket, data) {
            if (socket.data.handled) return;
            socket.data.bytes += data.byteLength;
            if (socket.data.bytes > maxRequestBytes) {
              socket.data.handled = true;
              queueResponse(
                socket,
                rejected("request-too-large", "result request exceeds the size limit"),
              );
              return;
            }
            socket.data.chunks.push(Buffer.from(data));
          },
          end(socket) {
            if (socket.data.handled) return;
            socket.data.handled = true;
            if (!accepting) {
              socket.terminate();
              return;
            }
            // Resolved once the response is on the wire, not once it is decided: close waits on
            // this, and an agent whose accepted result went unacknowledged submits it again.
            const { promise: written, resolve } = Promise.withResolvers<void>();
            socket.data.responded = resolve;
            const handling = handleFrame(
              Buffer.concat(socket.data.chunks).toString("utf8"),
              options.slots,
              agentId,
              onSession,
            )
              .then((response) => {
                if (socket.data.closed) return;
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

async function handleFrame(
  frame: string,
  slots: ResultSlotRegistry,
  agentId: string,
  onSession: ((id: string) => void) | undefined,
): Promise<ResultSubmitResponse> {
  if (!frame.endsWith("\n") || frame.slice(0, -1).includes("\n")) {
    return rejected("invalid-request", "expected exactly one newline-delimited JSON request");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.slice(0, -1));
  } catch {
    return rejected("invalid-request", "request is not valid JSON");
  }
  const decoded = decodeResultSubmitRequest(parsed);
  if (!decoded.ok) return rejected(decoded.code, decoded.error);
  // Before the result is judged: a rejected submission still proves which session sent it.
  if (decoded.value.session) onSession?.(decoded.value.session);

  try {
    const result = await slots.submit({
      operationId: decoded.value.operationId,
      agentId,
      raw: decoded.value.raw,
      source: "control-plane",
    });
    return result.kind === "accepted"
      ? { version: WIRE_VERSION, kind: "accepted" }
      : rejected(result.code, result.error);
  } catch {
    return rejected("internal-error", "result submission failed internally");
  }
}

function rejected(
  code: Exclude<ResultSubmitResponse, { kind: "accepted" }>["code"],
  error: string,
): ResultSubmitResponse {
  return { version: WIRE_VERSION, kind: "rejected", code, error };
}

function queueResponse(socket: Bun.Socket<ConnectionState>, response: ResultSubmitResponse): void {
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
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
  throw error;
}
