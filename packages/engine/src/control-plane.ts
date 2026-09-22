import { chmod, mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WIRE_VERSION,
  decodeResultSubmitRequest,
  type ResultSubmitResponse,
} from "@wf/contract/wire";
import type { ResultSlotRegistry } from "./result-slots";

export const MAX_RESULT_REQUEST_BYTES = 1024 * 1024;
export const MAX_CONTROL_CONNECTIONS = 64;
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
  openChannel(agentId: string): Promise<ResultChannel>;
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
  const maxRequestBytes = options.maxRequestBytes ?? MAX_RESULT_REQUEST_BYTES;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new Error("maxRequestBytes must be a positive safe integer");
  }
  const maxConnections = options.maxConnections ?? MAX_CONTROL_CONNECTIONS;
  const connectionLifetimeMs = options.connectionLifetimeMs ?? CONNECTION_TIMEOUT_SECONDS * 1000;
  if (!Number.isSafeInteger(maxConnections) || maxConnections <= 0) {
    throw new Error("maxConnections must be a positive safe integer");
  }
  if (!Number.isSafeInteger(connectionLifetimeMs) || connectionLifetimeMs <= 0) {
    throw new Error("connectionLifetimeMs must be a positive safe integer");
  }
  const root = options.socketRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "awf-"));
  // Traversable but not listable: an agent reaches the one path it was given and cannot read the
  // directory to discover its siblings'. Close puts the read bit back so the tree can be removed.
  await chmod(directory, 0o300);

  // Shared across channels: the budget protects the engine, not any one agent.
  let activeConnections = 0;
  let accepting = true;
  const activeHandlers = new Set<Promise<void>>();
  const channels = new Set<ResultChannel>();
  let sockets = 0;

  const openChannel = async (agentId: string): Promise<ResultChannel> => {
    if (!accepting) throw new Error("result control plane is closed");
    sockets += 1;
    // The agent key never reaches the path: it is arbitrary length and arbitrary text, and two
    // keys that differ only outside `[A-Za-z0-9._-]` would name the same directory.
    const home = await mkdtemp(join(directory, "a"));
    await chmod(home, 0o700);
    const endpoint = join(home, "s.sock");
    let listener: Bun.UnixSocketListener<ConnectionState>;
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
            // Idle and total budget are the same window: a caller that lengthens the lifetime for a
            // slow submission would otherwise still lose the connection to the fixed idle timeout.
            socket.timeout(Math.max(1, Math.ceil(connectionLifetimeMs / 1000)));
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
          timeout(socket) {
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
    } catch (error) {
      await rm(home, { recursive: true, force: true }).catch(ignoreMissing);
      throw error;
    }
    await chmod(endpoint, 0o600).catch(ignoreMissing);

    let channelClosing: Promise<void> | undefined;
    const channel: ResultChannel = {
      endpoint,
      close() {
        channelClosing ??= (async () => {
          // Stop accepting, then let whatever is already being answered finish: taking the socket
          // away first turns an accepted submission into a connection error the agent must guess at.
          listener.stop(false);
          await Promise.allSettled([...activeHandlers]);
          listener.stop(true);
          await unlink(endpoint).catch(ignoreMissing);
          await rm(home, { recursive: true, force: true }).catch(ignoreMissing);
          channels.delete(channel);
        })();
        return channelClosing;
      },
    };
    channels.add(channel);
    return channel;
  };

  let closing: Promise<void> | undefined;
  return {
    openChannel,
    close() {
      closing ??= (async () => {
        accepting = false;
        await Promise.allSettled([...activeHandlers]);
        await Promise.allSettled([...channels].map((channel) => channel.close()));
        await chmod(directory, 0o700).catch(ignoreMissing);
        // Recursive: each agent's socket and launcher live in a directory of their own.
        await rm(directory, { recursive: true, force: true }).catch(ignoreMissing);
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

function queueResponse(
  socket: Bun.Socket<ConnectionState>,
  response: ResultSubmitResponse,
): void {
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
