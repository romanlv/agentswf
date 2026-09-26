// bun awf run packages/autoresearch/src/review/fixtures.workflow.ts -- \
//   --project group/name --mrs 12,34 --clone ~/code/name --out ~/code/autoresearch/fixtures/draft
//
// Builds review fixtures (story 005). For each MR, code freezes it with `collect` unless its fixture
// already exists, then an agent drafts its answer key unless it has one. Code checks every key
// against the fixture and hands a failing draft back to the agent; independent graders then vote on
// what code can't check. Existing fixtures are checked, never changed; `--keys redraft` redrafts
// keys that are stale or fail their checks, and `--keys none` skips keys. Last, it seals the whole
// folder as a set: `set.json` pins every fixture that passes its checks and the set's rules by
// digest, and lists every MR left out with why.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  type WorkflowInvocation,
} from "@wf/contract/workflow";
import { collect } from "./collect";
import { type Drafted, draftKey, PROCEDURE } from "./draft-key";
import { glabSource } from "./gitlab";
import { inKey, sealSet } from "./seal";
import { fixtureId } from "./set";
import { describeProblems } from "./validate";
import { verifyFixture } from "./verify";

type Args = {
  project: string;
  mrs: number[];
  clone: string;
  out: string;
  version?: number;
  hostname?: string;
  keys: "draft" | "redraft" | "none";
  attempts: number;
  concurrency: number;
  drafter: ExecutionConfig;
  graders: ExecutionConfig[];
};

type Built = {
  mr: number;
  fixture: "collected" | "existing" | "excluded" | "failed";
  key: "drafted" | "existing" | "stale" | "none" | "failed";
  detail: string;
};

type Result = { built: Built[]; set: string };

const executable = defineExecutableWorkflow<Args, Result>({
  definition: {
    meta: {
      name: "build-review-fixtures",
      description: "Freeze GitLab MRs as review fixtures and draft their answer keys.",
      whenToUse: "Use to build or complete a review fixture set from a list of MRs (story 005).",
    },
    async run(workflow, args) {
      const source = glabSource(args.hostname ? { hostname: args.hostname } : {});
      const built = await workflow.parallel(
        args.mrs,
        async (mr): Promise<Built> => {
          const dir = join(args.out, fixtureId(args.project, mr));
          const log = (text: string) => workflow.log(`!${mr}: ${text}`);
          let fixture: Built["fixture"] = "existing";
          let keyProblems = "";
          if (existsSync(dir)) {
            const problems = await verifyFixture(dir, {
              project: args.project,
              number: mr,
              clone: args.clone,
            }).catch((error) => [{ path: dir, message: String(error) }]);
            if (!problems.every(inKey)) {
              return {
                mr,
                fixture: "failed",
                key: "none",
                detail: describeProblems(dir, problems),
              };
            }
            keyProblems = problems.length > 0 ? describeProblems(dir, problems) : "";
          } else {
            try {
              const result = await collect(
                {
                  project: args.project,
                  mr,
                  clone: args.clone,
                  out: args.out,
                  version: args.version,
                },
                { source, log },
              );
              if (result.status === "excluded") {
                return {
                  mr,
                  fixture: "excluded",
                  key: "none",
                  detail: `${result.reason}: ${result.detail}`,
                };
              }
              fixture = "collected";
            } catch (error) {
              return { mr, fixture: "failed", key: "none", detail: String(error) };
            }
          }
          const keyFile = join(dir, "key", "key.json");
          if (existsSync(keyFile)) {
            const stale = !keyProblems && (await Bun.file(keyFile).json()).procedure !== PROCEDURE;
            if (!keyProblems && !stale) return { mr, fixture, key: "existing", detail: "" };
            if (args.keys !== "redraft") {
              return keyProblems
                ? { mr, fixture, key: "failed", detail: keyProblems }
                : { mr, fixture, key: "stale", detail: "drafted under older instructions" };
            }
          }
          if (args.keys === "none") return { mr, fixture, key: "none", detail: "" };
          log("Draft the answer key");
          const drafted = await draftKey(workflow, {
            dir,
            clone: args.clone,
            drafter: args.drafter,
            graders: args.graders,
            attempts: args.attempts,
          }).catch((error): Drafted => ({ status: "failed", detail: String(error) }));
          if (drafted.status === "failed")
            return { mr, fixture, key: "failed", detail: drafted.detail };
          const { issues, refuted, excluded } = drafted.key;
          const split = drafted.votes.issues.filter(
            (v) => new Set(v.votes.map((x) => x.severity)).size > 1,
          ).length;
          return {
            mr,
            fixture,
            key: "drafted",
            detail: `${issues.length} issues, ${refuted.length} refuted, ${excluded.length} excluded; severity votes split on ${split} of ${drafted.votes.issues.length} (attempt ${drafted.attempts})`,
          };
        },
        { concurrency: args.concurrency, label: "Build fixtures" },
      );
      workflow.log("Seal the set");
      // An MR that failed to collect is listed too, so the set says what it lacks; its folder
      // replaces the exclusion once a later run collects it.
      const sealed = await sealSet(args.out, {
        clone: args.clone,
        builder: "build-review-fixtures",
        procedure: PROCEDURE,
        excluded: built
          .filter(
            (b) =>
              b.fixture === "excluded" ||
              (b.fixture === "failed" &&
                !existsSync(join(args.out, fixtureId(args.project, b.mr)))),
          )
          .map((b) => ({
            project: args.project,
            number: b.mr,
            reason: b.fixture === "failed" ? `collect failed: ${b.detail}` : b.detail,
          })),
      }).catch((error) => ({ status: "broken" as const, detail: String(error) }));
      const set =
        sealed.status === "broken"
          ? `set.json not written; fix or remove these first:\n${sealed.detail}`
          : `set.json ${sealed.status}: ${sealed.set.fixtures.length} fixtures, ${sealed.set.excluded.length} excluded`;
      return { built, set };
    },
  },
  prepare: parseArgs,
  present: ({ built, set }) =>
    [
      ...built.map(
        (b) => `!${b.mr}: fixture ${b.fixture}, key ${b.key}${b.detail ? ` — ${b.detail}` : ""}`,
      ),
      set,
    ].join("\n"),
});

function parseArgs(invocation: WorkflowInvocation): Args {
  const values = new Map<string, string>();
  const argv = [...invocation.argv];
  while (argv.length > 0) {
    const flag = argv.shift()!;
    const value = argv.shift();
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error(`expected --flag value, got ${flag}`);
    }
    values.set(flag.slice(2), value);
  }
  const known = [
    "project",
    "mrs",
    "clone",
    "out",
    "version",
    "hostname",
    "keys",
    "attempts",
    "concurrency",
    "drafter",
    "graders",
  ];
  for (const name of values.keys()) {
    if (!known.includes(name)) throw new Error(`unknown flag --${name}`);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  const positive = (name: string, value: string) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1)
      throw new Error(`--${name} must be a positive integer`);
    return number;
  };
  const optional = (name: string, fallback: number) => {
    const value = values.get(name);
    return value === undefined ? fallback : positive(name, value);
  };
  const mrs = [
    ...new Set(
      required("mrs")
        .split(",")
        .map((mr) => positive("mrs", mr.trim())),
    ),
  ];
  const version = values.get("version");
  if (version !== undefined && mrs.length !== 1) throw new Error("--version needs exactly one MR");
  const keys = values.get("keys") ?? "draft";
  if (keys !== "draft" && keys !== "redraft" && keys !== "none") {
    throw new Error("--keys is draft, redraft or none");
  }
  return {
    project: required("project"),
    mrs,
    clone: resolve(invocation.cwd, required("clone")),
    out: resolve(invocation.cwd, required("out")),
    ...(version !== undefined ? { version: positive("version", version) } : {}),
    ...(values.has("hostname") ? { hostname: values.get("hostname")! } : {}),
    keys,
    attempts: optional("attempts", 3),
    concurrency: optional("concurrency", 2),
    drafter: runtimeOf(values.get("drafter") ?? DRAFTER),
    graders: (values.get("graders") ?? GRADERS).split(",").map((g) => runtimeOf(g.trim())),
  };
}

/**
 * Three graders from two model families, so a majority isn't one model agreeing with itself. Claude
 * run headless is billed per token, which `metered` consents to.
 */
const DRAFTER = "codex/gpt-6-sol";
const GRADERS = "codex/gpt-6-sol,claude/claude-sonnet-5,codex/gpt-6-luna";

function runtimeOf(spec: string): ExecutionConfig {
  const slash = spec.indexOf("/");
  if (slash < 1) throw new Error(`expected harness/model, got ${spec}`);
  const harness = spec.slice(0, slash);
  return {
    harness,
    model: spec.slice(slash + 1),
    placement: "headless",
    ...(harness === "claude" ? { metered: true as const } : {}),
  };
}

export const buildReviewFixtures = executable.definition;
export default executable;
