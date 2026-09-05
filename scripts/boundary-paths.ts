import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const WORKSPACE_MANIFEST_GLOBS = [
  "{packages,experiments}/*/package.json",
  "examples/package.json",
] as const;

/** The trusted operator loader is the sole module whose dependency is selected by a user path. */
export function allowsComputedWorkflowImport(repositoryPath: string): boolean {
  return repositoryPath === "packages/engine/src/workflow-loader.ts";
}

export function escapedRelativeImport(
  packageDirectory: string,
  importingFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const target = resolve(dirname(importingFile), specifier);
  const fromPackage = relative(packageDirectory, target);
  return fromPackage === ".." || fromPackage.startsWith("../") ? target : null;
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
