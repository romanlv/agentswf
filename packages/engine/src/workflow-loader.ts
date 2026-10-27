import { stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as workflowSurface from "@agentswf/contract/workflow";
import {
  type EventSchemas,
  eventWorkflowProblem,
  isJsonValue,
  type JsonValue,
  WORKFLOW_KIND,
  type Workflow,
} from "@agentswf/contract/workflow";
import { plugin } from "bun";
import * as typebox from "typebox";
import * as typeboxValue from "typebox/value";
import { realPath } from "./files";
import { idProblem } from "./runs";

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

/** Serves the author surface to whatever this process imports next. */
export function serveAuthorSurface(): void {
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

/** A workflow as the engine takes one from a file, with `events` or without. */
export type AnyWorkflow = Workflow<JsonValue, JsonValue> | EventWorkflow;
export type EventWorkflow = Workflow<JsonValue, JsonValue, EventSchemas>;

export type LoadedWorkflow = { file: string; workflow: AnyWorkflow };

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
  const given = record(namespace)?.default;
  if (!isWorkflow(given)) throw new Error(`default export must be an ${WORKFLOW_KIND} workflow`);
  const { name, version } = given.meta;
  // The name is a folder its runs are kept in, and the version's major decides which records a
  // continue may reuse.
  const problem = idProblem(name);
  if (problem) throw new Error(`meta.name: ${problem}`);
  if (version !== undefined && (typeof version !== "string" || !SEMVER.test(version))) {
    throw new Error(
      `meta.version: ${JSON.stringify(version)} is not a semver version such as 1.2.0`,
    );
  }
  if (given.events !== undefined) {
    // As `tsc` would have checked them, for a file it never saw.
    const eventProblem = eventWorkflowProblem(given);
    if (eventProblem) throw new Error(eventProblem);
    if (realPath(given.file as string) !== realPath(absolute))
      throw new Error(
        `file is ${JSON.stringify(given.file)}; a workflow with events gives file: import.meta.path, ${absolute}`,
      );
  }
  return { file: absolute, workflow: given };
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (!isJsonValue(value)) throw new Error(`${label} must contain only JSON values`);
}

function isWorkflow(value: unknown): value is AnyWorkflow {
  const workflow = record(value);
  const meta = record(workflow?.meta);
  return (
    workflow?.kind === WORKFLOW_KIND &&
    typeof workflow.prepare === "function" &&
    (workflow.present === undefined || typeof workflow.present === "function") &&
    (workflow.report === undefined || typeof workflow.report === "function") &&
    (workflow.id === undefined || typeof workflow.id === "function") &&
    typeof workflow.run === "function" &&
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
