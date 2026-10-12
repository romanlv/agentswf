import { createConnection, type Socket } from "node:net";
import {
  type ControlRequest,
  decodeResponseFor,
  type ResponseFor,
  type ResultSubmitRequest,
  type ResultSubmitResponse,
  type WaitingRequest,
  type WaitingResponse,
} from "@agentswf/contract/wire";

const MAX_RESPONSE_BYTES = 256 * 1024;

/** The connection never opened: nothing was written, so nothing reached the engine. */
export class NotSentError extends Error {}

export function submitResult(
  endpoint: string,
  request: ResultSubmitRequest,
  timeoutSeconds = 30,
  connect: (endpoint: string) => Socket = createConnection,
): Promise<ResultSubmitResponse> {
  return submitControl(endpoint, request, timeoutSeconds, connect);
}

export function submitWaiting(
  endpoint: string,
  request: WaitingRequest,
  timeoutSeconds = 30,
  connect: (endpoint: string) => Socket = createConnection,
): Promise<WaitingResponse> {
  return submitControl(endpoint, request, timeoutSeconds, connect);
}

/** Sends one request and resolves with a response that answers its command. */
export function submitControl<R extends ControlRequest>(
  endpoint: string,
  request: R,
  timeoutSeconds = 30,
  connect: (endpoint: string) => Socket = createConnection,
): Promise<ResponseFor[R["command"]]> {
  type Response = ResponseFor[R["command"]];
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return Promise.reject(new Error("control-plane timeout must be positive"));
  }
  const outgoing = Buffer.from(`${JSON.stringify(request)}\n`);

  return new Promise<Response>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let connected = false;
    const socket = connect(endpoint);
    const lifetime = setTimeout(
      () => fail(new Error("control plane response timed out")),
      timeoutSeconds * 1000,
    );

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(lifetime);
      socket.destroy();
      reject(error);
    };

    socket.once("connect", () => {
      connected = true;
      socket.end(outgoing);
    });
    socket.on("data", (data) => {
      if (settled) return;
      const chunk = typeof data === "string" ? Buffer.from(data) : data;
      bytes += chunk.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        fail(new Error("control-plane response exceeds the size limit"));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => {
      if (settled) return;
      const frame = Buffer.concat(chunks).toString("utf8");
      if (!frame.endsWith("\n") || frame.slice(0, -1).includes("\n")) {
        fail(new Error("control plane returned an invalid response frame"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.slice(0, -1));
      } catch {
        fail(new Error("control plane returned invalid JSON"));
        return;
      }
      const decoded = decodeResponseFor<R["command"]>(request.command, parsed);
      if (!decoded.ok) {
        fail(new Error(decoded.error));
        return;
      }
      settled = true;
      clearTimeout(lifetime);
      resolve(decoded.value);
    });
    socket.once("error", (error) =>
      fail(connected ? error : new NotSentError(error.message, { cause: error })),
    );
    socket.once("close", () => {
      if (!settled) fail(new Error("control plane closed without a response"));
    });
  });
}
