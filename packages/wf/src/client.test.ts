import { expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { WIRE_VERSION } from "@agentswf/contract/wire";
import { submitResult } from "./client";

const REQUEST = {
  version: WIRE_VERSION,
  operationId: "op-1",
  raw: "{}",
} as const;

test("a peer that never answers settles the submission and closes its socket", async () => {
  const endpoint = `/tmp/wf-client-${crypto.randomUUID()}.sock`;
  let peer: Socket | undefined;
  let client: Socket | undefined;
  let received = "";
  // Accepted, read, and never answered: the case an agent must be told about rather than wait out.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    peer = socket;
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });

  try {
    const submission = submitResult(endpoint, REQUEST, 0.2, (path) => {
      client = createConnection(path);
      return client;
    });
    await expect(submission).rejects.toThrow("timed out");
    expect(received).toContain('"operationId":"op-1"');
    expect(client?.destroyed).toBe(true);
  } finally {
    peer?.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("the response lifetime is absolute even when a peer keeps sending data", async () => {
  const endpoint = `/tmp/wf-client-${crypto.randomUUID()}.sock`;
  const peers = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    socket.once("data", () => {
      const drip = setInterval(() => socket.write(" "), 5);
      socket.once("close", () => clearInterval(drip));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });

  try {
    const started = performance.now();
    await expect(submitResult(endpoint, REQUEST, 0.03)).rejects.toThrow("timed out");
    expect(performance.now() - started).toBeLessThan(200);
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("validates the complete response across fragmented data", async () => {
  await withServerResponse(['{"version":2,"kind":', '"accepted"}\n'], async (endpoint) => {
    await expect(submitResult(endpoint, REQUEST)).resolves.toEqual({
      version: WIRE_VERSION,
      kind: "accepted",
    });
  });
});

test("rejects malformed, extra-line, and oversized responses", async () => {
  for (const chunks of [
    ["not-json\n"],
    ['{"version":2,"kind":"accepted"}\n', '{"version":2,"kind":"accepted"}\n'],
    ["x".repeat(256 * 1024 + 1)],
  ]) {
    await withServerResponse(chunks, async (endpoint) => {
      await expect(submitResult(endpoint, REQUEST)).rejects.toThrow();
    });
  }
});

test("reports connection failure without hanging", async () => {
  await expect(
    submitResult(`/tmp/wf-missing-${crypto.randomUUID()}.sock`, REQUEST),
  ).rejects.toThrow();
});

async function withServerResponse(
  chunks: readonly string[],
  run: (endpoint: string) => Promise<void>,
): Promise<void> {
  const endpoint = `/tmp/wf-client-${crypto.randomUUID()}.sock`;
  const peers = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
    socket.once("data", () => {
      for (const chunk of chunks) socket.write(chunk);
      socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  try {
    await run(endpoint);
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}
