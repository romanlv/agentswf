/**
 * The dependency rules from `docs/foundation.md` §6, checked mechanically.
 *
 * TypeScript will not catch these on its own: workspace packages are symlinked into one
 * `node_modules`, so any package can import any other and still typecheck. The rules are the
 * design; this is what makes breaking one an error rather than a note in a document.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Glob } from "bun";
import { extractImports, hasUnresolvedDynamicImport } from "./boundary-imports";
import {
  allowsComputedWorkflowImport,
  containsPath,
  escapedPathImport,
  WORKSPACE_MANIFEST_GLOBS,
} from "./boundary-paths";

type Rule = {
  /** Workspace directory, relative to the repo root. */
  dir: string;
  /** Files under `dir` the rule covers; every `.ts` file by default. */
  files?: string;
  /** Files under `dir` the rule leaves out, so anything new is covered unless named here. */
  except?: string[];
  /** Bare specifiers this unit may import, by exact match or `pkg/*` prefix. */
  allow?: string[];
  /** Reject any import matching this, with the reason to print. */
  forbid?: { pattern: RegExp; reason: string }[];
  /** Reaches no runtime: imports no runtime builtin and never names the `Bun` global. */
  pure?: true;
  /**
   * Where a path import may point, relative to the repo root. By default anywhere under `dir`;
   * when given, it decides for every path import, inside `dir` or out.
   */
  paths?: (target: string) => boolean;
};

/**
 * A runtime builtin: anything `node:` or `bun:`, and every name the running Bun lists as built in,
 * which is Node's modules without their prefix (`fs` is as impure as `node:fs`) plus `bun`.
 */
const RUNTIME_BUILTIN = new RegExp(
  `^(node:.*|bun:.*|(${builtinModules.map((name) => name.replace(/[/.]/g, "\\$&")).join("|")})(/.*)?)$`,
);

/**
 * The seam's modules sit directly in `src`. Every directory beside them is a provider, except
 * `testing`, and nothing reaches into a provider but the provider itself.
 */
const SANDBOX_SOURCE = "packages/sandbox/src";

function rules(root: string): Rule[] {
  const source = join(root, SANDBOX_SOURCE);
  const directories = existsSync(source)
    ? readdirSync(source, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  const seam = (target: string) =>
    dirname(target) === SANDBOX_SOURCE && !directories.includes(basename(target));
  const own = (directory: string) => (target: string) =>
    seam(target) || containsPath(`${SANDBOX_SOURCE}/${directory}`, target);
  return [
    ...RULES,
    ...LAB_RULES.filter((rule) => existsSync(join(root, rule.dir))),
    ...(existsSync(source) ? [{ dir: SANDBOX_SOURCE, files: "*.ts", paths: seam }] : []),
    ...directories.flatMap((name): Rule[] => {
      if (name === "testing") return [{ dir: `${SANDBOX_SOURCE}/testing`, paths: own("testing") }];
      const provider = {
        dir: `${SANDBOX_SOURCE}/${name}`,
        allow: ["@agentswf/contract", "@agentswf/contract/*"],
        forbid: [
          {
            pattern: /^@agentswf\/sandbox/,
            reason: "a provider imports the seam by path, not a sibling",
          },
        ],
      };
      // A provider's tests run the conformance suite against it.
      return [
        { ...provider, except: ["**/*.test.ts"], paths: own(name) },
        {
          ...provider,
          files: "**/*.test.ts",
          paths: (target) => own(name)(target) || own("testing")(target),
        },
      ];
    }),
  ];
}

/** How two columns' numbers become a verdict: imports nothing, and serves any dataset. */
const COMPARE = "packages/lab/src/shared/compare";
/** What the lab's folders share: the process seam, `awf-lab.json`, the checks, the comparison. */
const SHARED = "packages/lab/src/shared";
/** The case kind: no word of any one workflow's domain. */
const CASES = "packages/lab/src/cases";

const DECISION_PROVIDER = /^packages\/engine\/src\/decisions\/openrouter(\.ts)?$/;
const DECISION_FAKE = /^packages\/engine\/src\/decisions\/fake(\.ts)?$/;

/** Any entry of `@agentswf/sandbox` but its main one, and `allowed`. */
function providerImport(reason: string, allowed?: string): { pattern: RegExp; reason: string } {
  return {
    pattern: new RegExp(`^@agentswf/sandbox/${allowed ? `(?!${allowed}$)` : ""}.`),
    reason,
  };
}

/** The engine alone issues participant refs, so no other package reaches the function that does. */
const ISSUES_REFS = {
  pattern: /^@agentswf\/contract\/participant$/,
  reason: "only the engine issues a participant ref",
};

const AGENT_CLI = "packages/engine/src/agent-cli";

const CLIENT = "packages/engine/src/client";

const RULES: Rule[] = [
  { dir: "packages/contract", allow: [], pure: true },
  // A program's client hosts no run: it reaches the run record and in.jsonl, never the
  // operator's runtime, a provider or the author surface the loader serves (story 040). What it
  // loads transitively is `clientReachProblems`'.
  {
    dir: CLIENT,
    except: ["**/*.test.ts"],
    forbid: [providerImport("the client launches attempts; it opens no sandbox")],
    paths: (target) =>
      target !== "packages/engine/src/operator-runtime.ts" &&
      !target.startsWith("packages/engine/src/decisions/"),
  },
  // Pricing and totals, positioned to be lifted out whole (foundation §8): records in, figures out.
  {
    dir: "packages/engine/src/accounting",
    allow: ["@agentswf/contract", "@agentswf/contract/*"],
    forbid: [ISSUES_REFS],
    pure: true,
  },
  // The engine's policy over `run.jsonl`'s lines (story 041): what `readRun` publishes is the
  // format; what the engine does with it is decided here, lines in, decisions out.
  {
    dir: "packages/engine/src/run-policy",
    allow: ["@agentswf/contract", "@agentswf/contract/*"],
    forbid: [ISSUES_REFS],
    pure: true,
  },
  // Adapters launch through the seam's types; which provider runs them is the operator's. Tests
  // may use the fake provider.
  {
    dir: "packages/harness",
    except: ["**/*.test.ts"],
    allow: ["@agentswf/contract", "@agentswf/contract/*", "@agentswf/sandbox"],
    forbid: [providerImport("harness knows the sandbox seam, never a provider"), ISSUES_REFS],
  },
  {
    dir: "packages/harness",
    files: "**/*.test.ts",
    allow: [
      "@agentswf/contract",
      "@agentswf/contract/*",
      "@agentswf/sandbox",
      "@agentswf/sandbox/testing",
    ],
    forbid: [
      providerImport("harness knows the sandbox seam, never a provider", "testing"),
      ISSUES_REFS,
    ],
  },
  // Only the composition root installs a provider; the rest of the engine sees the seam.
  {
    dir: "packages/engine",
    except: ["src/operator-runtime.ts", "src/workflow-testing/**", "**/*.test.ts"],
    forbid: [providerImport("only operator-runtime.ts imports a sandbox provider")],
  },
  // A workflow's test runs on the second composition root (ADR 0006): it installs the fakes where
  // operator-runtime.ts installs providers. It runs under any test runner, so never imports one.
  {
    dir: "packages/engine/src/workflow-testing",
    except: ["**/*.test.ts"],
    forbid: [
      // `testing` itself would bring the conformance suite, which imports `bun:test`.
      providerImport(
        "a workflow's test installs the fake sandbox provider, by its own path, never a real one",
        "testing/fake",
      ),
      { pattern: /^bun:test$/, reason: "a workflow's test helper imports no test runner" },
    ],
    paths: (target) => containsPath("packages/engine/src", target),
  },
  {
    dir: "packages/engine",
    files: "**/*.test.ts",
    forbid: [providerImport("only operator-runtime.ts imports a sandbox provider", "testing")],
  },
  // The same for decision providers, which the engine holds itself: only the composition root
  // installs OpenRouter, and the fake is for tests.
  {
    dir: "packages/engine/src",
    except: ["operator-runtime.ts", "**/*.test.ts"],
    paths: (target) => !DECISION_PROVIDER.test(target) && !DECISION_FAKE.test(target),
  },
  {
    dir: "packages/engine/src",
    files: "operator-runtime.ts",
    paths: (target) => !DECISION_FAKE.test(target),
  },
  {
    dir: "packages/engine/src",
    files: "**/*.test.ts",
    except: ["decisions/openrouter.test.ts"],
    paths: (target) => !DECISION_PROVIDER.test(target),
  },
  // The seam depends on nothing in harness: `runProcess` accepts its command, not the reverse.
  {
    dir: "packages/sandbox",
    allow: ["@agentswf/contract", "@agentswf/contract/*"],
    forbid: [
      {
        pattern: /^@agentswf\/(harness|engine)/,
        reason: "the sandbox package imports contract only",
      },
      ISSUES_REFS,
    ],
  },
  // The agent's side of the wire: bundled into one file the agent's sandbox can read, it reaches the
  // engine around it only over the control plane.
  {
    dir: AGENT_CLI,
    allow: ["@agentswf/contract", "@agentswf/contract/*"],
    forbid: [
      { pattern: /^@agentswf\/(engine|harness)/, reason: "wfa reaches the engine only over wire" },
      { pattern: /^(?:node:)?fs(?:\/|$)/, reason: "wfa never performs run-directory I/O" },
      ISSUES_REFS,
    ],
    paths: (target) => containsPath(AGENT_CLI, target),
  },
  // "Approved pure schema authoring libraries" is not a list the checker can hold; what it can hold
  // is that nothing here reaches a runtime, which is what made them approvable.
  // A consumer of the engine (ADR 0002): it runs workflows through `awf run` and reads their
  // records, and never links the engine or a harness.
  {
    dir: "packages/lab",
    allow: ["@agentswf/contract", "@agentswf/contract/*"],
    forbid: [
      {
        pattern: /^@agentswf\/(engine|harness)/,
        reason: "lab runs workflows through `awf run`, and never links the engine or a harness",
      },
      ISSUES_REFS,
    ],
  },
  // Serves any dataset: imports nothing, not even contract, and reaches no runtime.
  {
    dir: COMPARE,
    except: ["**/*.test.ts"],
    allow: [],
    forbid: [{ pattern: /^[^./]/, reason: "compare imports nothing but itself" }],
    pure: true,
  },
  { dir: COMPARE, files: "**/*.test.ts", allow: [] },
  // An example imports what an author outside the repository does: `agentswf/workflow`, and
  // `agentswf/typebox` for its schemas.
  {
    dir: "examples",
    except: ["**/*.test.ts", "**/*.driver.ts", "**/evals/**", "nudges/ledger.ts"],
    forbid: [
      {
        pattern: /^(@agentswf\/|agentswf(?!\/(workflow|typebox)$))/,
        reason:
          "a workflow is written against the author surface, agentswf/workflow and agentswf/typebox",
      },
    ],
    pure: true,
  },
  // A time read from state needs state that outlives the process, which a workflow keeps in files
  // (034's Q9): the nudges example's ledger is the one example module that writes one.
  {
    dir: "examples",
    files: "nudges/ledger.ts",
    allow: [],
    forbid: [
      {
        pattern: /^@agentswf\//,
        reason: "the ledger is the workflow's own state, not a use of awf",
      },
    ],
  },
  // A program that drives a workflow's runs, as one outside the repository does: it imports the
  // workflow and agentswf/client, and may use the runtime, as a webhook handler does (story 040).
  {
    dir: "examples",
    files: "**/*.driver.ts",
    forbid: [
      {
        pattern: /^(@agentswf\/|agentswf(?!\/(workflow|client)$))/,
        reason: "a program drives runs through agentswf/client",
      },
    ],
  },
  // A workflow's cases are written against the lab's case surface, as an author's evals are: they
  // import the workflow and its modules, `@agentswf/lab/cases`, and may use the runtime.
  {
    dir: "examples",
    files: "**/evals/**/*.ts",
    forbid: [
      {
        pattern: /^(@agentswf\/(?!lab\/cases$)|agentswf(?!\/(workflow|typebox)$))/,
        reason:
          "a workflow's cases use @agentswf/lab/cases, agentswf/workflow and agentswf/typebox",
      },
    ],
  },
  // A workflow's test is written against the testing surface, as an author outside the repository
  // writes one; it may read and write files, as its fakes do.
  {
    dir: "examples",
    files: "**/*.test.ts",
    forbid: [
      {
        pattern: /^(@agentswf\/|agentswf(?!\/(workflow|typebox|testing)$))/,
        reason:
          "a workflow's test uses agentswf/workflow, agentswf/typebox and agentswf/testing alone",
      },
    ],
  },
];

/**
 * The lab: the case kind imports only itself and the shared folder, the shared folder only itself.
 * Each stays pure but for the files named as doing I/O.
 */
const ownShared = (target: string) => containsPath(SHARED, target);
const ownCases = (target: string) => containsPath(CASES, target) || containsPath(SHARED, target);
/** The lab's side never loads an `agentswf`: it starts a folder's own `awf` as a process. */
const NO_AGENTSWF = {
  pattern: /^agentswf(\/|$)/,
  reason: "the lab starts a folder's own awf as a process, and never loads an agentswf",
};
/** For a rule whose folder's paths another rule checks, so a path import is reported once. */
const checkedElsewhere = () => true;
const LAB_RULES: Rule[] = [
  { dir: SHARED, paths: ownShared, forbid: [NO_AGENTSWF] },
  {
    dir: SHARED,
    except: ["**/*.test.ts", "runner.ts", "config-file.ts", "allowance.ts"],
    pure: true,
    paths: checkedElsewhere,
  },
  { dir: CASES, paths: ownCases },
  // What runs in a project's own process: the running engine's author surface, nothing else of awf.
  {
    dir: `${CASES}/env`,
    except: ["**/*.test.ts", "fixtures/**"],
    allow: [],
    forbid: [
      {
        pattern: /^(@agentswf\/|agentswf(?!\/workflow$))/,
        reason:
          "@agentswf/lab/cases runs in a project's process: it imports agentswf/workflow, which the running engine serves, and no @agentswf package",
      },
    ],
    paths: checkedElsewhere,
  },
  // The lab's own criteria judge: a workflow the lab's `awf` runs, reading its grade folder.
  {
    dir: `${CASES}/judge`,
    except: ["**/*.test.ts"],
    forbid: [
      {
        pattern: /^(@agentswf\/|agentswf(?!\/workflow$))/,
        reason:
          "the criteria judge is a workflow: it imports agentswf/workflow and its own folders",
      },
    ],
    paths: (target: string) => ownCases(target) && !containsPath(`${CASES}/lab`, target),
  },
  // A loop's proposer: a workflow the lab's `awf` runs in the lab's box.
  {
    dir: `${CASES}/loop`,
    except: ["**/*.test.ts"],
    forbid: [
      {
        pattern: /^(@agentswf\/|agentswf(?!\/workflow$))/,
        reason: "the proposer is a workflow: it imports agentswf/workflow and the case formats",
      },
    ],
    paths: (target: string) => ownCases(target) && !containsPath(`${CASES}/lab`, target),
  },
  {
    dir: `${CASES}/format`,
    except: ["**/*.test.ts"],
    pure: true,
    paths: checkedElsewhere,
    forbid: [NO_AGENTSWF],
  },
  {
    dir: `${CASES}/lab`,
    except: ["**/*.test.ts"],
    forbid: [NO_AGENTSWF],
    paths: checkedElsewhere,
  },
  {
    dir: `${CASES}/lab`,
    paths: checkedElsewhere,
    except: [
      "**/*.test.ts",
      "cli.ts",
      "box.ts",
      "capture.ts",
      "code-graders.ts",
      "command-context.ts",
      "compare.ts",
      "criteria.ts",
      "dataset.ts",
      "folders.ts",
      "git.ts",
      "grading.ts",
      "inspect.ts",
      "labels.ts",
      "loop.ts",
      "loop-code.ts",
      "loop-command.ts",
      "loop-records.ts",
      "record-copies.ts",
      "reuse.ts",
      "run-command.ts",
      "runs.ts",
      "scaffold.ts",
      "score.ts",
      "store.ts",
      "trial.ts",
      "workflow-graders.ts",
      "workspace.ts",
    ],
    pure: true,
  },
];

/** Words of one workflow's domain, which the case kind never names (story 044). */
const DOMAIN_WORDS = /\b(mail|review|finding)/i;

/** `source` without its comments, strings and template text kept. */
function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Each file under the case kind whose name, identifiers or strings name a domain word; a test and
 * its fixtures are examples, and may.
 */
async function domainWordProblems(root: string): Promise<string[]> {
  const dir = join(root, CASES);
  if (!existsSync(dir)) return [];
  const problems: string[] = [];
  for await (const file of new Glob("**/*").scan({ cwd: dir, absolute: true })) {
    const where = relative(root, file);
    if (/\.test\.ts$/.test(file) || /(^|\/)fixtures\//.test(relative(dir, file))) continue;
    if (DOMAIN_WORDS.test(relative(dir, file))) {
      problems.push(
        `${where}: its name holds a word of one workflow's domain (mail, review, finding)`,
      );
      continue;
    }
    if (!file.endsWith(".ts")) continue;
    const word = withoutComments(await Bun.file(file).text()).match(DOMAIN_WORDS);
    if (word) {
      problems.push(
        `${where}: names "${word[0]}", a word of one workflow's domain; the case kind knows none`,
      );
    }
  }
  return problems;
}

/** Any mention, so `globalThis.Bun` and aliases are caught too: an import ban misses the global. */
const ANY_BUN = /\bBun\b/;
const BUN_FILE_IO = /(^|[^\w.])Bun\s*\.\s*(file|write)\s*\(/;

/** Every violation under `root`, a checkout laid out like this one. */
export async function boundaryProblems(root: string): Promise<string[]> {
  const problems = [...(await clientReachProblems(root)), ...(await domainWordProblems(root))];

  for (const rule of rules(root)) {
    const abs = join(root, rule.dir);
    if (!existsSync(abs)) {
      problems.push(`${rule.dir}: the rule covers no files; is it stale?`);
      continue;
    }
    const excepted = (rule.except ?? []).map((pattern) => new Glob(pattern));
    let covered = 0;
    for await (const file of new Glob(rule.files ?? "**/*.ts").scan({ cwd: abs, absolute: true })) {
      if (excepted.some((glob) => glob.match(relative(abs, file)))) continue;
      covered++;
      const source = await Bun.file(file).text();
      const where = relative(root, file);

      if (rule.pure && ANY_BUN.test(source)) {
        problems.push(`${where}: uses the Bun global; ${rule.dir} is pure`);
      }
      if (rule.dir === CLIENT && /\bserveAuthorSurface\b/.test(source)) {
        problems.push(`${where}: the client never serves the author surface to the program`);
      }
      if (rule.dir === AGENT_CLI && BUN_FILE_IO.test(source)) {
        problems.push(`${where}: wfa never performs run-directory I/O`);
      }
      if (hasUnresolvedDynamicImport(source) && !allowsComputedWorkflowImport(where)) {
        problems.push(`${where}: contains a computed import whose boundary cannot be verified`);
      }

      for (const spec of extractImports(source)) {
        const escaped = escapedPathImport(abs, file, spec);
        if (rule.paths) {
          if (isPathImport(spec) && !rule.paths(relative(root, pathTarget(file, spec)))) {
            problems.push(`${where}: path import ${spec} reaches what ${rule.dir} may not`);
            continue;
          }
        } else if (escaped) {
          problems.push(`${where}: path import ${spec} escapes ${rule.dir}`);
          continue;
        }
        if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:")) continue;
        const forbidden = rule.forbid?.find((f) => f.pattern.test(spec));
        if (forbidden) {
          problems.push(`${where}: imports ${spec} — ${forbidden.reason}`);
          continue;
        }
        if (spec === "bun:test") continue;
        if (rule.pure && RUNTIME_BUILTIN.test(spec)) {
          problems.push(`${where}: imports ${spec} — ${rule.dir} is pure: no runtime builtins`);
          continue;
        }
        if (spec === "bun" || !spec.startsWith("@agentswf/")) continue;
        if (rule.allow && !rule.allow.some((a) => match(a, spec))) {
          problems.push(`${where}: imports ${spec}, which ${rule.dir} may not depend on`);
        }
      }
    }
    if (covered === 0) problems.push(`${rule.dir}: the rule covers no files; is it stale?`);
  }

  // Rule 7: a cross-package import has to be a declared dependency, not just a hoisted symlink.
  const manifests: string[] = [];
  for (const pattern of WORKSPACE_MANIFEST_GLOBS) {
    for await (const manifest of new Glob(pattern).scan({ cwd: root, absolute: true })) {
      manifests.push(manifest);
    }
  }
  const packageInfo = await Promise.all(
    manifests.map(async (manifest) => ({
      manifest,
      directory: dirname(manifest),
      pkg: (await Bun.file(manifest).json()) as {
        name: string;
        dependencies?: Record<string, string>;
      },
    })),
  );

  for (const { directory, pkg } of packageInfo) {
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    for await (const file of new Glob("**/*.ts").scan({ cwd: directory, absolute: true })) {
      const source = await Bun.file(file).text();
      if (
        hasUnresolvedDynamicImport(source) &&
        !allowsComputedWorkflowImport(relative(root, file))
      ) {
        const problem = `${relative(root, file)}: contains a computed import whose boundary cannot be verified`;
        if (!problems.includes(problem)) problems.push(problem);
      }
      for (const spec of extractImports(source)) {
        if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:")) {
          const target = escapedPathImport(directory, file, spec);
          if (!target) continue;
          const owner = packageInfo.find((candidate) => containsPath(candidate.directory, target));
          if (owner && !declared.has(owner.pkg.name)) {
            problems.push(
              `${relative(root, file)}: imports ${spec}, but ${pkg.name} does not declare ${owner.pkg.name}`,
            );
          }
          continue;
        }
        if (!spec.startsWith("@agentswf/")) continue;
        const owner = spec.split("/").slice(0, 2).join("/");
        if (owner === pkg.name || declared.has(owner)) continue;
        problems.push(
          `${relative(root, file)}: imports ${spec}, but ${pkg.name} does not declare ${owner}`,
        );
      }
    }
  }
  return problems.sort();
}

function isPathImport(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:");
}

function pathTarget(file: string, spec: string): string {
  if (spec.startsWith("file:")) return new URL(spec).pathname;
  return spec.startsWith("/") ? spec : resolve(dirname(file), spec);
}

function match(allowed: string, spec: string): boolean {
  return allowed.endsWith("/*") ? spec.startsWith(allowed.slice(0, -1)) : spec === allowed;
}

if (import.meta.main) {
  const problems = await boundaryProblems(join(import.meta.dir, ".."));
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(`\n${problems.length} boundary violation(s). See docs/foundation.md §6.`);
    process.exit(1);
  }
  console.log("boundaries ok");
}

/**
 * What a program loads with `agentswf/client`, followed import by import: never the operator's
 * runtime, or a sandbox or decision provider, which host runs (story 040).
 */
async function clientReachProblems(root: string): Promise<string[]> {
  const entry = join(root, CLIENT, "published.ts");
  if (!existsSync(entry)) return [];
  const forbidden = (path: string) =>
    path === "packages/engine/src/operator-runtime.ts" ||
    path === "packages/engine/src/decisions/openrouter.ts" ||
    path === "packages/engine/src/decisions/fake.ts" ||
    /^packages\/sandbox\/src\/[^/]+\//.test(path);
  const seen = new Map<string, string | undefined>([[entry, undefined]]);
  const queue = [entry];
  const problems: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    // What loads at run time: a type-only import or export is erased.
    const source = (await Bun.file(file).text()).replace(
      /\b(import|export)\s+type\s[^;]*?\bfrom\s*["'][^"']+["']/gs,
      "",
    );
    for (const spec of extractImports(source)) {
      const target = resolveWorkspaceImport(root, file, spec);
      if (target === undefined || seen.has(target)) continue;
      seen.set(target, file);
      const where = relative(root, target);
      if (forbidden(where)) {
        const chain: string[] = [where];
        for (let at = seen.get(target); at !== undefined; at = seen.get(at))
          chain.unshift(relative(root, at));
        problems.push(`agentswf/client reaches ${where}, which hosts runs: ${chain.join(" → ")}`);
        continue;
      }
      queue.push(target);
    }
  }
  return problems;
}

/** A workspace file `spec` names from `file`; undefined for a builtin or a third-party package. */
function resolveWorkspaceImport(root: string, file: string, spec: string): string | undefined {
  const withExtension = (path: string) =>
    [path, `${path}.ts`, join(path, "index.ts")].find(
      (candidate) => existsSync(candidate) && candidate.endsWith(".ts"),
    );
  if (spec.startsWith(".")) return withExtension(join(dirname(file), spec));
  const match = /^@agentswf\/([^/]+)(\/.*)?$/.exec(spec);
  if (!match) return undefined;
  const manifest = join(root, "packages", match[1]!, "package.json");
  if (!existsSync(manifest)) return undefined;
  const exports = (
    JSON.parse(readFileSync(manifest, "utf8")) as { exports?: Record<string, string> }
  ).exports;
  const target = exports?.[`.${match[2] ?? ""}`];
  return target === undefined ? undefined : join(dirname(manifest), target);
}
