import { onTestFinished } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ResultSubmitResponse, WIRE_VERSION } from "@wf/contract/wire";

export function createTempRunDirs(): {
  tempRunDir(): string;
  cleanup(): void;
} {
  const paths = new Set<string>();
  return {
    tempRunDir() {
      const path = mkdtempSync(join(tmpdir(), "wf-"));
      paths.add(path);
      return path;
    },
    cleanup() {
      for (const path of paths) rmSync(path, { recursive: true, force: true });
      paths.clear();
    },
  };
}

/** Compatibility helper for frozen tests; current suites should own a tracker per file. */
export function tempRunDir(): string {
  const path = mkdtempSync(join(tmpdir(), "wf-"));
  onTestFinished(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

export { COUNT_SCHEMA } from "@wf/contract/testing";

export function future(milliseconds = 60_000): { unixMilliseconds: number } {
  return { unixMilliseconds: Date.now() + milliseconds };
}

/** Answers a call the way an agent's `wf` does: one framed request over its own socket. */
export async function submit(
  binding: { endpoint: string; operationId: string },
  value: unknown,
): Promise<ResultSubmitResponse> {
  const response = await exchange(
    binding.endpoint,
    `${JSON.stringify({
      version: WIRE_VERSION,
      operationId: binding.operationId,
      raw: JSON.stringify(value),
    })}\n`,
  );
  return JSON.parse(response) as ResultSubmitResponse;
}

export function exchange(endpoint: string, frame: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.end(frame));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
    socket.once("error", reject);
  });
}
