#!/usr/bin/env bun
/**
 * One-off for the stages change: awf's output.json now says `completed` and `reason` where it said
 * `succeeded` and `error`, and the lab's stored records follow, in place and with no format bump.
 * Run once on a results store, then delete this file.
 *
 *   bun packages/lab/scripts/migrate-run-words.ts <store-dir> [--dry-run]
 *
 * In the run object of review-findings, review-score, review-judgement and review-partial records:
 * `outcome: "succeeded"` becomes `"completed"` and the key `error` becomes `reason`, in place.
 * A partial names the score it rests on by that score's digest, so the digest is recomputed.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digestOf } from "../src/review/fixtures/seal";

const FORMATS = new Set([
  "awf.review-findings/1",
  "awf.review-findings/2",
  "awf.review-score/1",
  "awf.review-score/2",
  "awf.review-judgement/1",
  "awf.review-partial/1",
]);

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const dirs = args.filter((a) => !a.startsWith("--"));
if (dirs.length !== 1) {
  console.error("usage: bun packages/lab/scripts/migrate-run-words.ts <store-dir> [--dry-run]");
  process.exit(2);
}
const root = dirs[0]!;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith(".json")) yield path;
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The indent a file was written with, or null when it round-trips under none we know. */
function indentOf(text: string, value: unknown): string | number | null {
  const tail = text.endsWith("\n") ? "\n" : "";
  for (const indent of [2, "\t", 4, 0]) {
    if (JSON.stringify(value, null, indent) + tail === text) return indent;
  }
  return null;
}

function renameRun(run: Obj): { run: Obj; changed: boolean } {
  let changed = false;
  const out: Obj = {};
  for (const [key, value] of Object.entries(run)) {
    if (key === "error") {
      out.reason = value;
      changed = true;
    } else if (key === "outcome" && value === "succeeded") {
      out.outcome = "completed";
      changed = true;
    } else out[key] = value;
  }
  return { run: out, changed };
}

type Plan = {
  file: string;
  format: string;
  text: string;
  value: Obj;
  indent: string | number;
  oldDigest: string;
};

const counts = new Map<string, { seen: number; changed: number; already: number }>();
const problems: string[] = [];
const plans: Plan[] = [];
for (const file of walk(root)) {
  let text: string;
  let value: unknown;
  try {
    text = await Bun.file(file).text();
    value = JSON.parse(text);
  } catch (e) {
    problems.push(`${file}: unparseable (${(e as Error).message})`);
    continue;
  }
  if (!isObj(value) || typeof value.format !== "string" || !FORMATS.has(value.format)) continue;
  const indent = indentOf(text, value);
  if (indent === null) {
    problems.push(`${file}: formatting does not round-trip, left alone`);
    continue;
  }
  plans.push({ file, format: value.format, text, value, indent, oldDigest: digestOf(value) });
}

// Pass 1: the renamed records and their new digests.
const digests = new Map<string, string>();
const next = new Map<Plan, Obj>();
for (const plan of plans) {
  const { value } = plan;
  let out: Obj = value;
  if (isObj(value.run)) {
    const { run, changed } = renameRun(value.run);
    if (changed)
      out = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "run" ? run : v]));
  }
  next.set(plan, out);
  if (!plan.format.startsWith("awf.review-partial")) {
    const digest = digestOf(out);
    digests.set(plan.oldDigest, digest);
    digests.set(digest, digest);
  }
}

// Pass 2: a partial's link to the score it rests on (`base` in the stored record, `restFrom` in the reader).
let linksUpdated = 0;
for (const plan of plans) {
  if (!plan.format.startsWith("awf.review-partial")) continue;
  const out = next.get(plan)!;
  for (const key of ["base", "restFrom"]) {
    const link = out[key];
    if (!isObj(link) || typeof link.digest !== "string") continue;
    const target = digests.get(link.digest);
    if (target === undefined) {
      problems.push(`${plan.file}: ${key}.digest ${link.digest} matches no score in the store`);
      continue;
    }
    if (target === link.digest) continue;
    const updated = { ...link, digest: target };
    next.set(
      plan,
      Object.fromEntries(Object.entries(out).map(([k, v]) => [k, k === key ? updated : v])),
    );
    linksUpdated++;
  }
}

function atomicWrite(file: string, text: string) {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode: statSync(file).mode });
  renameSync(tmp, file);
}

// Partials first: an interrupted run then still finds each score's old or new digest in the store.
const ordered = [...plans].sort(
  (a, b) =>
    Number(b.format.startsWith("awf.review-partial")) -
    Number(a.format.startsWith("awf.review-partial")),
);
let filesChanged = 0;
for (const plan of ordered) {
  const entry = counts.get(plan.format) ?? { seen: 0, changed: 0, already: 0 };
  entry.seen++;
  const text =
    JSON.stringify(next.get(plan), null, plan.indent) + (plan.text.endsWith("\n") ? "\n" : "");
  if (text === plan.text) entry.already++;
  else {
    entry.changed++;
    filesChanged++;
    if (!dry) atomicWrite(plan.file, text);
  }
  counts.set(plan.format, entry);
}

console.log(`${dry ? "dry run, nothing written" : "migrated"}: ${root}`);
for (const format of [...counts.keys()].sort()) {
  const c = counts.get(format)!;
  console.log(
    `  ${format.padEnd(26)} seen ${c.seen}  changed ${c.changed}  unchanged (already migrated, or no run) ${c.already}`,
  );
}
console.log(`files changed: ${filesChanged}`);
console.log(`partial digests updated: ${linksUpdated}`);
console.log(`problems: ${problems.length}`);
for (const p of problems) console.log(`  ${p}`);
process.exit(problems.length > 0 ? 1 : 0);
