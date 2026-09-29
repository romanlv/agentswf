import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { EXECUTABLE_WORKFLOW_KIND } from "@agentswf/contract/workflow";
import {
  REVIEW_SCORER_KIND,
  REVIEW_VARIANT_KIND,
  type ScorerSettings,
  type VariantSettings,
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
  const value = loaded as { kind?: unknown; review?: unknown } | null | undefined;
  // What `awf run` will load: the variant or scorer file is its workflow.
  if (value?.kind !== EXECUTABLE_WORKFLOW_KIND || typeof value.review !== "object") {
    throw new Error(`${file}: the default export is not a variant or scorer`);
  }
  const review = value.review as Record<string, unknown> | null;
  const argv = review?.argv;
  if (
    !review ||
    !Array.isArray(argv) ||
    !argv.every((argument) => typeof argument === "string") ||
    typeof review.timeout !== "string"
  ) {
    throw new Error(`${file}: needs workflow, argv (strings) and timeout`);
  }
  return review;
}

/** A variant file's settings, as `defineReviewVariant` made them. */
export async function loadVariant(file: string): Promise<VariantSettings> {
  const value = await load(file);
  if (value.kind !== REVIEW_VARIANT_KIND || typeof value.read !== "function") {
    throw new Error(`${file}: the default export is not a defineReviewVariant(…)`);
  }
  return value as unknown as VariantSettings;
}

/** A scorer file's settings, as `defineReviewScorer` made them. */
export async function loadScorer(file: string): Promise<ScorerSettings> {
  const value = await load(file);
  if (value.kind !== REVIEW_SCORER_KIND) {
    throw new Error(`${file}: the default export is not a defineReviewScorer(…)`);
  }
  return value as unknown as ScorerSettings;
}
