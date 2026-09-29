import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKSPACE_MANIFEST_GLOBS = [
  "{packages,experiments}/*/package.json",
  "examples/package.json",
] as const;

/**
 * The modules whose dependency is selected by a user path: the operator's workflow loader, and
 * awf-lab's, which loads variant and judge files.
 */
export function allowsComputedWorkflowImport(repositoryPath: string): boolean {
  return (
    repositoryPath === "packages/engine/src/workflow-loader.ts" ||
    repositoryPath === "packages/lab/src/review/lab/load.ts"
  );
}

export function escapedPathImport(
  packageDirectory: string,
  importingFile: string,
  specifier: string,
): string | null {
  let target: string;
  if (specifier.startsWith(".")) target = resolve(dirname(importingFile), specifier);
  else if (isAbsolute(specifier)) target = specifier;
  else if (specifier.startsWith("file:")) {
    try {
      target = fileURLToPath(specifier);
    } catch {
      return specifier;
    }
  } else return null;
  return containsPath(packageDirectory, target) ? null : target;
}

export function containsPath(directory: string, target: string): boolean {
  const fromDirectory = relative(directory, target);
  return fromDirectory === "" || (fromDirectory !== ".." && !fromDirectory.startsWith("../"));
}
