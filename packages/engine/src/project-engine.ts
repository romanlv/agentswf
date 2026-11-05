import { dirname } from "node:path";
import manifest from "../package.json" with { type: "json" };
import {
  type InstalledEngine,
  installedEngine,
  type ProjectEngine,
  projectEngine,
} from "./hand-over";

/** This engine's version, which every package of a release shares. */
export const ENGINE_VERSION: string = manifest.version;

/** Why an engine won't run a project's runs: `other-engine` or `no-engine`, as a client says it. */
export class EngineRefused extends Error {
  constructor(
    readonly code: "other-engine" | "no-engine",
    message: string,
  ) {
    super(message);
    this.name = "EngineRefused";
  }
}

/**
 * The engine a project's runs run on (ADR 0015): the `agentswf` installed above it; else, for a
 * project with none above it, the one its workflow files resolve, as in a workspace whose root
 * holds `.awf/` and whose packages each have a `node_modules`. Files that resolve two versions, or
 * one other than the project's, are refused: one project runs on one engine.
 */
export function engineOf(project: string, files: readonly string[] = []): ProjectEngine {
  const engine = projectEngine(project);
  let fromFiles: (InstalledEngine & { file: string }) | undefined;
  for (const file of files) {
    const found = installedEngine(dirname(file));
    if (!found) continue;
    const other = engine.kind === "installed" ? engine : fromFiles;
    if (other && other.version !== found.version)
      throw new EngineRefused(
        "other-engine",
        `${file} resolves agentswf ${found.version}, from ${found.root}, and ${engine.kind === "installed" ? `its project ${project}` : (fromFiles?.file ?? project)} ${other.version}: one project runs on one engine`,
      );
    fromFiles ??= { ...found, file };
  }
  if (engine.kind === "installed" || !fromFiles) return engine;
  const { file: _file, ...installed } = fromFiles;
  return { kind: "installed", ...installed };
}

/**
 * Refuses `project` unless this engine is the one its runs run on, as `engineOf` finds it with
 * `file`: at this version, or, for a project with none, any engine but a client's.
 */
export function checkProjectEngine(
  project: string,
  options: { file?: string; files?: readonly string[]; client?: boolean; version?: string } = {},
): void {
  const own = options.version ?? ENGINE_VERSION;
  const engine = engineOf(project, [
    ...(options.file === undefined ? [] : [options.file]),
    ...(options.files ?? []),
  ]);
  if (engine.kind === "declared")
    throw new EngineRefused(
      "no-engine",
      `${project} declares agentswf in ${engine.manifest} and has none installed: run bun install there`,
    );
  if (engine.kind === "installed" && engine.version !== own)
    throw new EngineRefused(
      "other-engine",
      options.client
        ? `${project} runs on its agentswf ${engine.version}, and this program's agentswf/client is ${own}: install one version in both`
        : `${project} runs on its agentswf ${engine.version}, and this awf is ${own}: run the project's, bunx awf, from ${engine.root}`,
    );
  if (engine.kind === "none" && options.client)
    throw new EngineRefused(
      "no-engine",
      `${project} has no agentswf installed, so it runs on whichever global awf is installed: bun add -d agentswf there`,
    );
}
