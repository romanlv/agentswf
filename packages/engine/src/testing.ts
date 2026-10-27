import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptRecord } from "@agentswf/contract/records";
import { type ResultSubmitResponse, WIRE_VERSION } from "@agentswf/contract/wire";
import {
  defineWorkflow,
  type EventWorkflowContext,
  type JsonValue,
  type OutputSchema,
  type WorkflowContext,
  type WorkflowDefinition,
} from "@agentswf/contract/workflow";
import { createSingleSessionHostFactory } from "@agentswf/harness";
import type { AgentSessionAdapter } from "@agentswf/harness/adapter";
import { createFakeAdapter } from "@agentswf/harness/testing";
import Type from "typebox";
import { writeJson } from "./files";
import { OPERATOR_ALIASES } from "./operator-aliases";
import { createRun, openRun, type Run, readAttempts } from "./runs";
import { type RunWorkflowOptions, runWorkflow, startWorkflow } from "./workflow-runner";

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

/** A project, `.awf/` at its root, with `source` at `flows/{name}`, and a home of its own. */
export function eventProject(
  dirs: ReturnType<typeof createTempRunDirs>,
  name: string,
  source: string,
): { root: string; file: string; home: string } {
  const root = dirs.tempRunDir();
  mkdirSync(join(root, ".awf"));
  mkdirSync(join(root, "flows"));
  const file = join(root, "flows", name);
  writeFileSync(file, source);
  return { root, file, home: dirs.tempRunDir() };
}

/** Polls `check` until it holds; throws after `ms`. */
export async function until(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

/** Writes the run's next attempt record, as `awf run` claims one, with `fields` over defaults. */
export async function writeAttempt(run: Run, fields: Partial<AttemptRecord>): Promise<void> {
  const n = (await readAttempts(run)).length + 1;
  mkdirSync(join(run.dir, "attempts"), { recursive: true });
  await writeJson(join(run.dir, "attempts", `${n}.json`), {
    version: 1,
    attempt: n,
    file: "/flows/case.ts",
    flags: {},
    started: new Date().toISOString(),
    ...fields,
  });
}

const Changes: OutputSchema<{ case: string }> = {
  type: "object",
  properties: { case: { type: "string" } },
  required: ["case"],
};
const caseEvents = { "dd.changes": Changes };

/** A workflow with one event, `dd.changes`, keyed by its case, whose body is `run`. */
export const caseRun = (
  run: (workflow: EventWorkflowContext<typeof caseEvents>) => Promise<JsonValue>,
) =>
  defineWorkflow({
    meta: { name: "dd-case", description: "A case." },
    file: import.meta.path,
    events: caseEvents,
    starts: ["dd.changes"],
    run,
  });

/** The options that start a `caseRun` under the key `k`. */
export const startCase = { id: "k", event: { name: "dd.changes" as const, data: { case: "k" } } };

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
      command: "result",
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

/**
 * One attempt of run r1 of `workflow` under `runRoot`, created by the first, its agents answered by
 * `answering()`. Its folder is `{runRoot}/{workflow}/r1`.
 */
export async function runAttempt<Result extends JsonValue>(
  workflow: WorkflowDefinition<null, Result>,
  options: {
    runRoot: string;
    attempt?: number;
    fromStage?: string;
    values?: Record<string, JsonValue>;
    adapter?: AgentSessionAdapter;
    signal?: AbortSignal;
  },
) {
  const { runRoot, attempt = 1, fromStage, values, adapter = answering(), signal } = options;
  const name = workflow.meta.name;
  const run = existsSync(join(runRoot, name, "r1"))
    ? await openRun(runRoot, name, "r1")
    : await createRun(runRoot, {
        id: "r1",
        workflow: name,
        argv: [],
        cwd: process.cwd(),
        sandbox: null,
      });
  return runWorkflow(workflow, null, {
    runRoot,
    run: {
      dir: run.dir,
      id: run.record.id,
      attempt,
      ...(fromStage === undefined ? {} : { fromStage }),
      ...(values === undefined ? {} : { values: new Map(Object.entries(values)) }),
    },
    runtime: { aliases: OPERATOR_ALIASES, host: createSingleSessionHostFactory(adapter) },
    deadline: future(),
    ...(signal === undefined ? {} : { signal }),
  });
}

/** `startWorkflow` as the first attempt of a new run of the workflow under `options.runRoot`. */
export async function startNew<Args extends JsonValue, Result extends JsonValue>(
  definition: WorkflowDefinition<Args, Result>,
  args: Args,
  options: Omit<RunWorkflowOptions, "run">,
) {
  const run = await createRun(options.runRoot, {
    workflow: definition.meta.name,
    argv: [],
    cwd: options.cwd ?? process.cwd(),
    sandbox: null,
  });
  return startWorkflow(definition, args, {
    ...options,
    run: { dir: run.dir, id: run.record.id, attempt: 1 },
  });
}

/** `runWorkflow` as the first attempt of a new run of the workflow under `options.runRoot`. */
export async function runNew<Args extends JsonValue, Result extends JsonValue>(
  definition: WorkflowDefinition<Args, Result>,
  args: Args,
  options: Omit<RunWorkflowOptions, "run">,
) {
  return (await startNew(definition, args, options)).result;
}
