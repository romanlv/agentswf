import { chmod, mkdir, mkdtemp, rmdir, unlink } from "node:fs/promises";
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

export type ResultControlPlane = {
  endpoint: string;
  close(): Promise<void>;
};

export async function startResultControlPlane(options: {
  socketRoot: string;
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
  await mkdir(options.socketRoot, { recursive: true });
  const directory = await mkdtemp(join(options.socketRoot, "wf-control-"));
  const endpoint = join(directory, "engine.sock");
  let activeConnections = 0;
  let accepting = true;
  const activeHandlers = new Set<Promise<void>>();
  let listener: Bun.UnixSocketListener<ConnectionState>;
  try {
    await chmod(directory, 0o700);
    listener = Bun.listen<ConnectionState>({
      unix: endpoint,
      allowHalfOpen: true,
      data: emptyConnection(),
      socket: {
        open(socket) {
          socket.data = emptyConnection();
          if (activeConnections >= maxConnections) {
            socket.terminate();
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
          const handling = handleFrame(
            Buffer.concat(socket.data.chunks).toString("utf8"),
            options.slots,
          )
            .then((response) => {
              if (!socket.data.closed) queueResponse(socket, response);
            })
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
    await removeEndpoint(endpoint, directory);
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    endpoint,
    close() {
      closing ??= (async () => {
        accepting = false;
        listener.stop(true);
        await unlink(endpoint).catch(ignoreMissing);
        await Promise.allSettled([...activeHandlers]);
        await rmdir(directory).catch(ignoreMissing);
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
      capability: decoded.value.capability,
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
}

async function removeEndpoint(endpoint: string, directory: string): Promise<void> {
  await unlink(endpoint).catch(ignoreMissing);
  await rmdir(directory).catch(ignoreMissing);
}

function ignoreMissing(error: unknown): void {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
  throw error;
}
