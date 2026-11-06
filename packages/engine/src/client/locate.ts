import { ClientError } from "@agentswf/contract/client";
import { messageOf } from "../errors";
import { checkProjectEngine } from "../project-engine";
import { projectOf, projectRunRoot } from "../projects";
import { asClientError } from "../refusals";
import type { AnyWorkflow } from "../workflow-loader";
import { fileOf, nameOf } from "./checks";
import { exportProblem } from "./exported";

/** A workflow as the client finds it: its file, checked to export it, and its project's runs. */
export type Found = { workflow: AnyWorkflow; file: string; project: string; runRoot: string };

/**
 * Where `workflow`'s runs are: its `file`, which must export it as its default, in a project that
 * runs on this engine. `file` is imported, which the program's module cache already holds.
 */
export async function locate(workflow: AnyWorkflow, home: string): Promise<Found> {
  const file = fileOf(workflow);
  const exported = await exportProblem(workflow, file);
  if (exported) throw new ClientError("file", `${workflow?.meta?.name}: ${exported}`);
  nameOf(workflow);
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
