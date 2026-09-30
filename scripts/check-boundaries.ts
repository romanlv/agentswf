/**
 * The dependency rules from `docs/foundation.md` §6, checked mechanically.
 *
 * TypeScript will not catch these on its own: workspace packages are symlinked into one
 * `node_modules`, so any package can import any other and still typecheck. The rules are the
 * design; this is what makes breaking one an error rather than a note in a document.
 */

import { existsSync, readdirSync } from "node:fs";
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
    ...reviewRules(root),
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

/**
 * `src/review` is organised by purpose, and a folder imports only the folders named for it: the
 * formats know nothing of ours, and evaluating never depends on building fixtures from a forge.
 */
const REVIEW = "packages/lab/src/review";
/** How two variants' numbers become a verdict: below every review folder, and knows none of them. */
const COMPARE = "packages/lab/src/compare";
const REVIEW_LAYERS: Readonly<Record<string, readonly string[]>> = {
  format: [],
  fixtures: ["format"],
  build: ["format", "fixtures"],
  judge: ["format", "fixtures"],
  metrics: ["format", "fixtures"],
  lab: ["format", "fixtures", "judge", "metrics"],
};

function reviewFolders(root: string): string[] {
  const source = join(root, REVIEW);
  return existsSync(source)
    ? readdirSync(source, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
}

function reviewRules(root: string): Rule[] {
  return reviewFolders(root)
    .filter((name) => Object.hasOwn(REVIEW_LAYERS, name))
    .map((name) => ({
      dir: `${REVIEW}/${name}`,
      paths: (target: string) =>
        containsPath(COMPARE, target) ||
        [name, ...REVIEW_LAYERS[name]!].some((layer) => containsPath(`${REVIEW}/${layer}`, target)),
    }));
}

/** A folder the table leaves out, or a module beside the entry, would escape the order. */
function reviewPlacementProblems(root: string): string[] {
  const source = join(root, REVIEW);
  if (!existsSync(source)) return [];
  return readdirSync(source, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return Object.hasOwn(REVIEW_LAYERS, entry.name)
        ? []
        : [
            `${REVIEW}/${entry.name}: a folder the review layers don't place; add it to REVIEW_LAYERS`,
          ];
    }
    return entry.name.endsWith(".ts") && entry.name !== "index.ts"
      ? [`${REVIEW}/${entry.name}: only the entry sits beside the review folders; move it into one`]
      : [];
  });
}

const DECISION_PROVIDER = /^packages\/engine\/src\/decisions\/openrouter(\.ts)?$/;
const DECISION_FAKE = /^packages\/engine\/src\/decisions\/fake(\.ts)?$/;

/** Any entry of `@agentswf/sandbox` but its main one, and `allowed`. */
function providerImport(reason: string, allowed?: string): { pattern: RegExp; reason: string } {
  return {
    pattern: new RegExp(`^@agentswf/sandbox/${allowed ? `(?!${allowed}$)` : ""}.`),
    reason,
  };
}

const RULES: Rule[] = [
  { dir: "packages/contract", allow: [], pure: true },
  // Pricing and totals, positioned to be lifted out whole (foundation §8): records in, figures out.
  {
    dir: "packages/engine/src/accounting",
    allow: ["@agentswf/contract", "@agentswf/contract/*"],
    pure: true,
  },
  // Adapters launch through the seam's types; which provider runs them is the operator's. Tests
  // may use the fake provider.
  {
    dir: "packages/harness",
    except: ["**/*.test.ts"],
    allow: ["@agentswf/contract", "@agentswf/contract/*", "@agentswf/sandbox"],
    forbid: [providerImport("harness knows the sandbox seam, never a provider")],
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
    forbid: [providerImport("harness knows the sandbox seam, never a provider", "testing")],
  },
  // Only the composition root installs a provider; the rest of the engine sees the seam.
  {
    dir: "packages/engine",
    except: ["src/operator-runtime.ts", "**/*.test.ts"],
    forbid: [providerImport("only operator-runtime.ts imports a sandbox provider")],
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
        pattern: /^@agentswf\/(harness|engine|wf)/,
        reason: "the sandbox package imports contract only",
      },
    ],
  },
  {
    dir: "packages/wf",
    allow: ["@agentswf/contract", "@agentswf/contract/*"],
    forbid: [
      { pattern: /^@agentswf\/(engine|harness)/, reason: "wf reaches the engine only over wire" },
      { pattern: /^(?:node:)?fs(?:\/|$)/, reason: "wf never performs run-directory I/O" },
    ],
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
    ],
  },
  // Serves any kind of case: imports nothing, not even contract, and reaches no runtime.
  { dir: "packages/lab/src/compare", except: ["**/*.test.ts"], allow: [], pure: true },
  // The format and the decisions about it stay pure; only the files named here do I/O.
  {
    dir: REVIEW,
    except: [
      "**/*.test.ts",
      "**/*.workflow.ts",
      "fixtures/git.ts",
      "fixtures/verify.ts",
      "fixtures/seal.ts",
      "build/gitlab.ts",
      "build/collect.ts",
      "build/draft-key.ts",
      "lab/cli.ts",
      "lab/execute.ts",
      "lab/provenance.ts",
      "lab/load.ts",
      "lab/runner.ts",
      "lab/store.ts",
      "lab/workspace.ts",
      "index.ts",
    ],
    pure: true,
    paths: (target) => containsPath(REVIEW, target) || containsPath(COMPARE, target),
  },
  {
    dir: "examples",
    allow: ["@agentswf/contract/workflow"],
    forbid: [
      {
        pattern: /^@agentswf\/(engine|harness)/,
        reason: "a workflow is written against the author surface, never the runtime",
      },
    ],
    pure: true,
  },
];

/** Any mention, so `globalThis.Bun` and aliases are caught too: an import ban misses the global. */
const ANY_BUN = /\bBun\b/;
const BUN_FILE_IO = /(^|[^\w.])Bun\s*\.\s*(file|write)\s*\(/;

/** Every violation under `root`, a checkout laid out like this one. */
export async function boundaryProblems(root: string): Promise<string[]> {
  const problems = reviewPlacementProblems(root);

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
      if (rule.dir === "packages/wf" && BUN_FILE_IO.test(source)) {
        problems.push(`${where}: wf never performs run-directory I/O`);
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
        if (spec === "bun:test") continue;
        if (rule.pure && RUNTIME_BUILTIN.test(spec)) {
          problems.push(`${where}: imports ${spec} — ${rule.dir} is pure: no runtime builtins`);
          continue;
        }
        const forbidden = rule.forbid?.find((f) => f.pattern.test(spec));
        if (forbidden) {
          problems.push(`${where}: imports ${spec} — ${forbidden.reason}`);
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
