import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ResultSubmitResponse, WIRE_VERSION } from "@agentswf/contract/wire";
import type { JsonValue, WorkflowContext, WorkflowDefinition } from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import type { AgentSessionAdapter } from "@agentswf/harness/adapter";
import { createFakeAdapter } from "@agentswf/harness/testing";
import Type from "typebox";
import { OPERATOR_ALIASES } from "./operator-aliases";
import { runWorkflow } from "./workflow-runner";

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

export { COUNT_SCHEMA } from "@agentswf/contract/testing";

export function future(milliseconds = 60_000): { unixMilliseconds: number } {
  return { unixMilliseconds: Date.now() + milliseconds };
}

/** Answers a call the way an agent's `wf` does: one framed request over its own socket. */
export async function submit(
  binding: { endpoint: string; operationId: string },
  value: unknown,
  session?: string,
): Promise<ResultSubmitResponse> {
  const response = await exchange(
    binding.endpoint,
    `${JSON.stringify({
      version: WIRE_VERSION,
      operationId: binding.operationId,
      raw: JSON.stringify(value),
      ...(session ? { session } : {}),
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

export const DOC = Type.Object({ path: Type.String() }, { additionalProperties: false });

/** A workflow of no arguments, named `staged` unless `meta` names it. */
export function workflowOf<Result extends JsonValue>(
  run: (workflow: WorkflowContext) => Promise<Result>,
  meta: { name?: string; version?: string } = {},
): WorkflowDefinition<null, Result> {
  const { name = "staged", version } = meta;
  return {
    meta: { name, description: name, ...(version === undefined ? {} : { version }) },
    run: (workflow) => run(workflow),
  };
}

/** Answers every turn with a `DOC`, and every compaction with a summary. */
export function answering(): AgentSessionAdapter {
  return createFakeAdapter({
    harnesses: ["codex"],
    script: (context) =>
      context.kind === "compact"
        ? { summary: "kept" }
        : {
            act: async () => {
              await submit(context.binding!, { path: "x" });
            },
          },
  });
}

/** One attempt of run r1 in `dir`, under `runRoot`, its agents answered by `answering()`. */
export async function runAttempt<Result extends JsonValue>(
  workflow: WorkflowDefinition<null, Result>,
  options: {
    runRoot: string;
    dir: string;
    attempt?: number;
    fromStage?: string;
    adapter?: AgentSessionAdapter;
    signal?: AbortSignal;
  },
) {
  const { runRoot, dir, attempt = 1, fromStage, adapter = answering(), signal } = options;
  await mkdir(dir, { recursive: true });
  return runWorkflow(workflow, null, {
    runRoot,
    run: { dir, id: "r1", attempt, ...(fromStage === undefined ? {} : { fromStage }) },
    runtime: { aliases: OPERATOR_ALIASES, host: createSingleSessionHostFactory(adapter) },
    deadline: future(),
    ...(signal === undefined ? {} : { signal }),
  });
}
