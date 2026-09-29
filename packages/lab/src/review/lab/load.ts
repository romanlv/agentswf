import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  type DefinedJudge,
  type DefinedVariant,
  REVIEW_JUDGE_KIND,
  REVIEW_VARIANT_KIND,
} from "../format/variant";

const RESOLVE_HINT =
  "a file outside awf finds the package through its repository's tsconfig.json: " +
  '"compilerOptions": { "paths": { "@agentswf/lab/review": ["{awf}/packages/lab/src/review/index.ts"] } }';

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
    !(value.workflow instanceof URL) ||
    !Array.isArray(argv) ||
    !argv.every((argument) => typeof argument === "string") ||
    typeof value.timeout !== "string"
  ) {
    throw new Error(`${file}: needs workflow (a URL), argv (strings) and timeout`);
  }
  return value;
}

/** A variant file's default export, as `defineReviewVariant` made it. */
export async function loadVariant(file: string): Promise<DefinedVariant> {
  const value = await load(file);
  if (value.kind !== REVIEW_VARIANT_KIND || typeof value.read !== "function") {
    throw new Error(`${file}: the default export is not a defineReviewVariant(…)`);
  }
  return value as unknown as DefinedVariant;
}

/** A scorer file's default export, as `defineReviewJudge` made it. */
export async function loadScorer(file: string): Promise<DefinedJudge> {
  const value = await load(file);
  if (value.kind !== REVIEW_JUDGE_KIND) {
    throw new Error(`${file}: the default export is not a defineReviewJudge(…)`);
  }
  return value as unknown as DefinedJudge;
}
