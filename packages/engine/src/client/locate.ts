import { isAbsolute } from "node:path";
import { ClientError } from "@agentswf/contract/client";
import { messageOf } from "../errors";
import { checkProjectEngine } from "../project-engine";
import { projectOf, projectRunRoot } from "../projects";
import { asClientError } from "../refusals";
import { idProblem } from "../runs";
import type { AnyWorkflow } from "../workflow-loader";
import { exportProblem } from "./exported";

/** A workflow as the client finds it: its file, checked to export it, and its project's runs. */
export type Found = { workflow: AnyWorkflow; file: string; project: string; runRoot: string };

/**
 * Where `workflow`'s runs are: its `file`, which must export it as its default, in a project that
 * runs on this engine. `file` is imported, which the program's module cache already holds.
 */
export async function locate(workflow: AnyWorkflow, home: string): Promise<Found> {
  const name = workflow?.meta?.name;
  const file = (workflow as { file?: unknown })?.file;
  if (typeof file !== "string" || !isAbsolute(file))
    throw new ClientError(
      "file",
      `${name ?? "the workflow"} gives no file, by which a program finds it and its runs: file: import.meta.path`,
    );
  const exported = await exportProblem(workflow, file);
  if (exported) throw new ClientError("file", `${name}: ${exported}`);
  const problem = idProblem(name);
  if (problem) throw new ClientError("event", `meta.name: ${problem}`);
  let project: string;
  try {
    project = await projectOf(file, home);
  } catch (error) {
    throw new ClientError("project", messageOf(error));
  }
  try {
    checkProjectEngine(project, { file, client: true });
  } catch (error) {
    throw asClientError(error);
  }
  return { workflow, file, project, runRoot: projectRunRoot(project) };
}
