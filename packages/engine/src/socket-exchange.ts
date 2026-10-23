import { createConnection } from "node:net";

/**
 * One request line to a Unix socket, and what comes back until the other side closes: empty when
 * it closed without a word. Bounded, so a run that stopped answering does not hang a holder.
 */
export function exchange(endpoint: string, frame: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    socket.once("connect", () => socket.end(frame));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8").trim());
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
