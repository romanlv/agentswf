import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as workflowSurface from "@agentswf/contract/workflow";
import {
  EXECUTABLE_WORKFLOW_KIND,
  type ExecutableWorkflow,
  isJsonValue,
  type JsonValue,
} from "@agentswf/contract/workflow";
import { plugin } from "bun";
import * as typebox from "typebox";
import * as typeboxValue from "typebox/value";

/**
 * What a workflow in any folder imports without installing it, served from the engine's own
 * copies, so its schemas are the ones results are checked with. Part of the author surface:
 * adding a name is cheap, removing one breaks workflows.
 */
const AUTHOR_SURFACE: Record<string, Record<string, unknown>> = {
  "agentswf/workflow": workflowSurface,
  typebox,
  "typebox/value": typeboxValue,
};

let surfaceServed = false;

function serveAuthorSurface(): void {
  if (surfaceServed) return;
  surfaceServed = true;
  plugin({
    name: "agentswf author surface",
    setup(build) {
      for (const [name, exports] of Object.entries(AUTHOR_SURFACE)) {
        build.module(name, () => ({ exports, loader: "object" }));
      }
    },
  });
}

const WORKFLOW_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);

export type LoadedWorkflow = {
  file: string;
  executable: ExecutableWorkflow<JsonValue, JsonValue>;
};

export async function loadWorkflowFile(file: string, cwd: string): Promise<LoadedWorkflow> {
  if (file.includes("://") || file.startsWith("file:")) {
    throw new Error("workflow must be an explicit local file path");
  }
  const absolute = resolve(cwd, file);
  if (!WORKFLOW_EXTENSIONS.has(extname(absolute))) {
    throw new Error("workflow file must end in .ts, .mts, .js, or .mjs");
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(`workflow file not found: ${absolute}`);
  }
  if (!info.isFile()) throw new Error(`workflow path is not a file: ${absolute}`);

  serveAuthorSurface();
  const namespace: unknown = await import(pathToFileURL(absolute).href);
  const exported = record(namespace)?.default;
  if (!isExecutableWorkflow(exported)) {
    throw new Error(`default export must be an ${EXECUTABLE_WORKFLOW_KIND} executable workflow`);
  }
  return { file: absolute, executable: exported };
}

export function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (!isJsonValue(value)) throw new Error(`${label} must contain only JSON values`);
}

function isExecutableWorkflow(value: unknown): value is ExecutableWorkflow<JsonValue, JsonValue> {
  const executable = record(value);
  const definition = record(executable?.definition);
  const meta = record(definition?.meta);
  return (
    executable?.kind === EXECUTABLE_WORKFLOW_KIND &&
    typeof executable.prepare === "function" &&
    (executable.present === undefined || typeof executable.present === "function") &&
    (executable.report === undefined || typeof executable.report === "function") &&
    typeof definition?.run === "function" &&
    typeof meta?.name === "string" &&
    meta.name.trim() !== "" &&
    typeof meta.description === "string" &&
    meta.description.trim() !== ""
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
