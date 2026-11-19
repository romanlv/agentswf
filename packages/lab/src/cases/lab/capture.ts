import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import Type from "typebox";
import { checkSchema, describeProblems } from "../../shared/validate";
import { FactSchema, KEY_KIND } from "../format/settings";
import { type DatasetInfo, KEY_FILE } from "./dataset";
import { newMarker } from "./marker";
import { Refusal } from "./refusal";
import { readableRuns, type StoredTrial } from "./store";

export const CAPTURE_FILE = "capture.ts";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A string fact longer than this is prose, not a value a key can expect exactly. */
const LONG_TEXT = 60;

export type Mark = { mark: "good" } | { mark: "needs-work"; note: string };

/** What a dataset's `capture.ts` answers: one case per thing the run handled. */
const CasesSchema = Type.Array(
  Type.Object(
    {
      name: Type.String({ pattern: NAME.source }),
      input: Type.Optional(Type.Unknown()),
      files: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.String())),
      facts: Type.Optional(Type.Record(Type.String(), FactSchema)),
    },
    { additionalProperties: false },
  ),
  { minItems: 1 },
);
export type CapturedCase = Type.Static<typeof CasesSchema>[number];

/** The trial whose workflow run had this id, in any run of the store. */
export function findTrial(store: string, trialId: string): StoredTrial | undefined {
  for (const { trials } of readableRuns(store, { newest: true })) {
    const found = trials.find((t) => t.record.runId === trialId);
    if (found) return found;
  }
  return undefined;
}

/**
 * A real run's folder, `.awf/runs/{workflow}/{id}`, under these project folders. A run id is unique
 * only within its workflow: one found under two workflows is refused, naming both.
 */
export function findRealRun(projects: readonly string[], runId: string): string | undefined {
  const found = new Set<string>();
  for (const project of new Set(projects)) {
    const root = join(project, ".awf", "runs");
    if (!existsSync(root)) continue;
    for (const workflow of readdirSync(root)) {
      const dir = join(root, workflow, runId);
      if (existsSync(join(dir, "run.json"))) found.add(dir);
    }
  }
  if (found.size > 1) {
    throw new Refusal(
      `run ${runId} is in more than one workflow's runs: ${[...found].join(", ")}; capture takes one`,
    );
  }
  return [...found][0];
}

/** A real run as `capture` is given it: its `run.json` and, once it ended, its `out.json`. */
export function readRealRun(dir: string): {
  id: string;
  workflow: string;
  argv: string[];
  args?: unknown;
  outcome: string;
  result: unknown;
  dir: string;
} {
  const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as {
    id: string;
    workflow: string;
    argv?: string[];
    args?: unknown;
  };
  // How it ended is its last attempt's: a run being continued, or whose last attempt was lost,
  // has not ended, whatever an earlier attempt's output says.
  const attempts = existsSync(join(dir, "attempts"))
    ? readdirSync(join(dir, "attempts"))
        .map((name) => /^([1-9][0-9]*)\.json$/.exec(name)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number)
    : [];
  const last = Math.max(0, ...attempts);
  const attempt = last
    ? (JSON.parse(readFileSync(join(dir, "attempts", `${last}.json`), "utf8")) as {
        outcome?: string;
      })
    : {};
  const outFile = ["out.json", "output.json"].map((f) => join(dir, f)).find(existsSync);
  const out = outFile
    ? (JSON.parse(readFileSync(outFile, "utf8")) as {
        attempt?: number;
        outcome?: string;
        value?: unknown;
      })
    : {};
  const outcome = attempt.outcome ?? (last ? "running" : (out.outcome ?? "running"));
  const settled = out.attempt === undefined || out.attempt === last;
  return {
    id: run.id,
    workflow: run.workflow,
    argv: run.argv ?? [],
    ...(run.args !== undefined ? { args: run.args } : {}),
    outcome,
    result: outcome === "completed" && settled ? (out.value ?? null) : null,
    dir,
  };
}

/** `capture.ts`'s answer, checked: every name a case folder's, every file inside `files/`. */
export function checkCaptured(file: string, answer: unknown): CapturedCase[] {
  const checked = checkSchema(CasesSchema, answer);
  if (!checked.ok) throw new Refusal(describeProblems(`${file}'s cases`, checked.problems));
  for (const each of checked.value) {
    const paths = Object.keys(each.files ?? {}).map((p) => normalize(p));
    for (const path of paths) {
      if (isAbsolute(path) || path === "." || path.split(/[\\/]/).includes("..")) {
        throw new Refusal(`${file}: case ${each.name}: ${path} is no file inside its files/`);
      }
      if (paths.some((other) => other.startsWith(`${path}/`))) {
        throw new Refusal(`${file}: case ${each.name}: ${path} is a file and a folder`);
      }
    }
  }
  return checked.value;
}

/** The first of `name`, `name-2`, `name-3`… that no case of the dataset has. */
export function freeName(
  dataset: DatasetInfo,
  name: string,
  taken: Set<string> = new Set(),
): string {
  const used = (n: string) => taken.has(n) || existsSync(join(dataset.dir, "cases", n));
  if (!used(name)) return name;
  for (let n = 2; ; n++) if (!used(`${name}-${n}`)) return `${name}-${n}`;
}

/**
 * A captured case's key: a draft, so no grader runs on it until the person writes what a good
 * result is; `captured` names the run and its mark. With `--good`, `expect` drafts the facts the
 * run gave, `error` left out. Strings are quoted, as the key reader wants.
 */
export function capturedKey(
  runId: string,
  mark: Mark,
  facts: Record<string, string | number | boolean | null> | undefined,
): string {
  const expect =
    mark.mark === "good" && facts
      ? Object.entries(facts).filter(([name]) => name !== "error" && !name.startsWith("_"))
      : [];
  const isProse = ([, v]: [string, unknown]) => typeof v === "string" && v.length > LONG_TEXT;
  const plain = expect.filter((e) => !isProse(e));
  const prose = expect.filter(isProse);
  const lines = [
    "---",
    `kind: ${KEY_KIND}`,
    `marker: ${newMarker()}`,
    "draft: true",
    "captured:",
    `  run: ${JSON.stringify(runId)}`,
    `  mark: ${mark.mark}`,
    ...(mark.mark === "needs-work" ? [`  note: ${JSON.stringify(mark.note)}`] : []),
    // Prose an agent wrote won't come back word for word: left for the person, commented. With
    // nothing else, `expect:` itself is commented, as an empty one is no key.
    ...(plain.length > 0
      ? ["expect:", ...plain.map(([n, v]) => `  ${n}: ${JSON.stringify(v)}`)]
      : []),
    ...(prose.length > 0
      ? [
          ...(plain.length > 0 ? [] : ["# expect:"]),
          ...prose.map(
            ([n, v]) =>
              `  # ${n}: ${JSON.stringify(v)}  # text: matched exactly, it would fail; a must is likelier`,
          ),
        ]
      : []),
    "---",
    "",
    mark.mark === "good"
      ? `Captured from run ${runId}, a good result: check \`expect\` says what made it good, then remove \`draft: true\`.`
      : `Captured from run ${runId}, which needed work: ${mark.note}. Write what a good result is, then remove \`draft: true\`.`,
    "",
  ];
  return lines.join("\n");
}

/** Writes a case folder: its `files/`, its `input.json`, its draft key. */
export function writeCase(
  dataset: DatasetInfo,
  name: string,
  parts: { files?: Record<string, string>; filesFrom?: string; input?: unknown; key: string },
): string {
  const dir = join(dataset.dir, "cases", name);
  // Built whole beside the cases, then moved into place: a case is never there without its key.
  const building = mkdtempSync(join(dataset.dir, ".capture-"));
  try {
    mkdirSync(join(building, "files"));
    if (parts.filesFrom && existsSync(parts.filesFrom)) {
      cpSync(parts.filesFrom, join(building, "files"), { recursive: true });
    }
    for (const [path, text] of Object.entries(parts.files ?? {})) {
      mkdirSync(dirname(join(building, "files", path)), { recursive: true });
      writeFileSync(join(building, "files", path), text);
    }
    if (parts.input !== undefined) {
      writeFileSync(join(building, "input.json"), `${JSON.stringify(parts.input, null, 2)}\n`);
    }
    writeFileSync(join(building, KEY_FILE), parts.key);
    mkdirSync(join(dataset.dir, "cases"), { recursive: true });
    renameSync(building, dir);
  } finally {
    rmSync(building, { recursive: true, force: true });
  }
  return dir;
}
