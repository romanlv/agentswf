import { messageOf } from "../errors";

/**
 * Why `file` isn't the module whose default export is `workflow`, as awf loads it; undefined when
 * it is. The program imported it already, so this import is its module cache's.
 */
export async function exportProblem(workflow: unknown, file: string): Promise<string | undefined> {
  let exported: unknown;
  try {
    exported = ((await import(file)) as { default?: unknown }).default;
  } catch (error) {
    return `its file, ${file}, could not be imported: ${messageOf(error)}`;
  }
  return exported === workflow
    ? undefined
    : `its file, ${file}, doesn't export it as its default, as awf loads a workflow; file is the path of the module whose default export it is`;
}
