import { createConnection, type Socket } from "node:net";
import {
  decodeResultSubmitResponse,
  type ResultSubmitRequest,
  type ResultSubmitResponse,
} from "@wf/contract/wire";

const MAX_RESPONSE_BYTES = 256 * 1024;

export function submitResult(
  endpoint: string,
  request: ResultSubmitRequest,
  timeoutSeconds = 30,
  connect: (endpoint: string) => Socket = createConnection,
): Promise<ResultSubmitResponse> {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    return Promise.reject(new Error("control-plane timeout must be positive"));
  }
  const outgoing = Buffer.from(`${JSON.stringify(request)}\n`);

  return new Promise<ResultSubmitResponse>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
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

    socket.setTimeout(timeoutSeconds * 1000);
    socket.once("connect", () => socket.end(outgoing));
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
      const decoded = decodeResultSubmitResponse(parsed);
      if (!decoded.ok) {
        fail(new Error(decoded.error));
        return;
      }
      settled = true;
      clearTimeout(lifetime);
      resolve(decoded.value);
    });
    socket.once("timeout", () => fail(new Error("control plane response timed out")));
    socket.once("error", fail);
    socket.once("close", () => {
      if (!settled) fail(new Error("control plane closed without a response"));
    });
  });
}
