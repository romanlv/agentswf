import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type DefinedScorer,
  type DefinedVariant,
  REVIEW_SCORER_KIND,
  REVIEW_VARIANT_KIND,
} from "../format/variant";

const RESOLVE_HINT =
  "a file outside awf finds the package through a link: `bun link` in {awf}/packages/lab, " +
  "then `bun link @agentswf/lab` in the file's repository";

async function load(file: string): Promise<Record<string, unknown>> {
  let loaded: unknown;
  try {
    // Loaded afresh, so a process that loads a file again after an edit sees its new version.
    for (const path of new Set([file, realpathSync(file)])) {
      if (require.cache[path]) delete require.cache[path];
    }
    loaded = (await import(pathToFileURL(file).href)).default;
  } catch (error) {
    const text = String(error);
    throw new Error(`${file}: ${text}${text.includes("@agentswf/lab") ? `\n${RESOLVE_HINT}` : ""}`);
  }
  if (typeof loaded !== "object" || loaded === null) {
    throw new Error(`${file}: the default export is not a variant or scorer`);
  }
  const value = loaded as Record<string, unknown>;
  const argv = value.argv;
  if (
    typeof value.workflow !== "object" ||
    value.workflow === null ||
    !(value.file instanceof URL) ||
    !Array.isArray(argv) ||
    !argv.every((argument) => typeof argument === "string") ||
    typeof value.timeout !== "string"
  ) {
    throw new Error(
      `${file}: needs workflow (the imported workflow), file (its URL), argv (strings) and timeout`,
    );
  }
  await sameWorkflow(file, value.workflow, value.file);
  return value;
}

/** The file `awf run` will load must be the one the types came from: the same module, so the same object. */
async function sameWorkflow(file: string, workflow: object, url: URL): Promise<void> {
  let path: string;
  let exported: unknown;
  try {
    path = realpathSync(fileURLToPath(url));
    exported = (await import(pathToFileURL(path).href)).default;
  } catch (error) {
    throw new Error(`${file}: file ${url.href}: ${String(error)}`);
  }
  if (exported !== workflow) {
    throw new Error(`${file}: workflow is not the default export of file ${path}`);
  }
}

/** A variant file's default export, as `defineReviewVariant` made it. */
export async function loadVariant(file: string): Promise<DefinedVariant> {
  const value = await load(file);
  if (value.kind !== REVIEW_VARIANT_KIND || typeof value.read !== "function") {
    throw new Error(`${file}: the default export is not a defineReviewVariant(…)`);
  }
  return value as unknown as DefinedVariant;
}

/** A scorer file's default export, as `defineReviewScorer` made it. */
export async function loadScorer(file: string): Promise<DefinedScorer> {
  const value = await load(file);
  if (value.kind !== REVIEW_SCORER_KIND) {
    throw new Error(`${file}: the default export is not a defineReviewScorer(…)`);
  }
  return value as unknown as DefinedScorer;
}
