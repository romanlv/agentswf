/**
 * The dependency rules from `docs/foundation.md` §6, checked mechanically.
 *
 * TypeScript will not catch these on its own: workspace packages are symlinked into one
 * `node_modules`, so any package can import any other and still typecheck. The rules are the
 * design; this is what makes breaking one an error rather than a note in a document.
 */

import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import { Glob } from "bun";
import { extractImports, hasUnresolvedDynamicImport } from "./boundary-imports";
import {
  allowsComputedWorkflowImport,
  containsPath,
  escapedPathImport,
  WORKSPACE_MANIFEST_GLOBS,
} from "./boundary-paths";

const ROOT = join(import.meta.dir, "..");

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
};

/**
 * A runtime builtin: anything `node:` or `bun:`, and every name the running Bun lists as built in,
 * which is Node's modules without their prefix (`fs` is as impure as `node:fs`) plus `bun`.
 */
const RUNTIME_BUILTIN = new RegExp(
  `^(node:.*|bun:.*|(${builtinModules.map((name) => name.replace(/[/.]/g, "\\$&")).join("|")})(/.*)?)$`,
);

const RULES: Rule[] = [
  { dir: "packages/contract", allow: [], pure: true },
  // Pricing and totals, positioned to be lifted out whole (foundation §8): records in, figures out.
  {
    dir: "packages/engine/src/accounting",
    allow: ["@wf/contract", "@wf/contract/*"],
    pure: true,
  },
  { dir: "packages/harness", allow: ["@wf/contract", "@wf/contract/*"] },
  {
    dir: "packages/cli-agent",
    allow: ["@wf/contract", "@wf/contract/*"],
    forbid: [
      { pattern: /^@wf\/(engine|harness)/, reason: "cli-agent reaches the engine only over wire" },
      { pattern: /^(?:node:)?fs(?:\/|$)/, reason: "cli-agent never performs run-directory I/O" },
    ],
  },
  // "Approved pure schema authoring libraries" is not a list the checker can hold; what it can hold
  // is that nothing here reaches a runtime, which is what made them approvable.
  // A consumer of the engine (ADR 0002): it runs workflows and reads their records, and never
  // reaches into the engine or a harness.
  {
    dir: "packages/autoresearch",
    allow: ["@wf/contract", "@wf/contract/*", "@wf/engine"],
    forbid: [
      {
        pattern: /^@wf\/(engine\/|harness)/,
        reason: "autoresearch uses the engine's public entry only, and never a harness",
      },
    ],
  },
  // The format and the decisions about it stay pure; only the files named here do I/O.
  {
    dir: "packages/autoresearch/src/review",
    files: "*.ts",
    except: [
      "*.test.ts",
      "*.workflow.ts",
      "git.ts",
      "gitlab.ts",
      "collect.ts",
      "verify.ts",
      "seal.ts",
      "draft-key.ts",
      "index.ts",
    ],
    pure: true,
  },
  {
    dir: "examples",
    allow: ["@wf/contract/workflow"],
    forbid: [
      {
        pattern: /^@wf\/(engine|harness)/,
        reason: "a workflow is written against the author surface, never the runtime",
      },
    ],
    pure: true,
  },
];

/** Any mention, so `globalThis.Bun` and aliases are caught too: an import ban misses the global. */
const ANY_BUN = /\bBun\b/;
const BUN_FILE_IO = /(^|[^\w.])Bun\s*\.\s*(file|write)\s*\(/;

const problems: string[] = [];

for (const rule of RULES) {
  const abs = join(ROOT, rule.dir);
  const excepted = (rule.except ?? []).map((pattern) => new Glob(pattern));
  let covered = 0;
  for await (const file of new Glob(rule.files ?? "**/*.ts").scan({ cwd: abs, absolute: true })) {
    if (excepted.some((glob) => glob.match(relative(abs, file)))) continue;
    covered++;
    const source = await Bun.file(file).text();
    const where = relative(ROOT, file);

    if (rule.pure && ANY_BUN.test(source)) {
      problems.push(`${where}: uses the Bun global; ${rule.dir} is pure`);
    }
    if (rule.dir === "packages/cli-agent" && BUN_FILE_IO.test(source)) {
      problems.push(`${where}: cli-agent never performs run-directory I/O`);
    }
    if (hasUnresolvedDynamicImport(source) && !allowsComputedWorkflowImport(where)) {
      problems.push(`${where}: contains a computed import whose boundary cannot be verified`);
    }

    for (const spec of extractImports(source)) {
      const escaped = escapedPathImport(abs, file, spec);
      if (escaped) {
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
      if (spec === "bun" || !spec.startsWith("@wf/")) continue;
      if (rule.allow && !rule.allow.some((a) => match(a, spec))) {
        problems.push(`${where}: imports ${spec}, which ${rule.dir} may not depend on`);
      }
    }
  }
  if (covered === 0) problems.push(`${rule.dir}: the rule covers no files; is it stale?`);
}

// Rule 4: a cross-package import has to be a declared dependency, not just a hoisted symlink.
const manifests: string[] = [];
for (const pattern of WORKSPACE_MANIFEST_GLOBS) {
  for await (const manifest of new Glob(pattern).scan({ cwd: ROOT, absolute: true })) {
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
    if (hasUnresolvedDynamicImport(source) && !allowsComputedWorkflowImport(relative(ROOT, file))) {
      const problem = `${relative(ROOT, file)}: contains a computed import whose boundary cannot be verified`;
      if (!problems.includes(problem)) problems.push(problem);
    }
    for (const spec of extractImports(source)) {
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:")) {
        const target = escapedPathImport(directory, file, spec);
        if (!target) continue;
        const owner = packageInfo.find((candidate) => containsPath(candidate.directory, target));
        if (owner && !declared.has(owner.pkg.name)) {
          problems.push(
            `${relative(ROOT, file)}: imports ${spec}, but ${pkg.name} does not declare ${owner.pkg.name}`,
          );
        }
        continue;
      }
      if (!spec.startsWith("@wf/")) continue;
      const owner = spec.split("/").slice(0, 2).join("/");
      if (owner === pkg.name || declared.has(owner)) continue;
      problems.push(
        `${relative(ROOT, file)}: imports ${spec}, but ${pkg.name} does not declare ${owner}`,
      );
    }
  }
}

function match(allowed: string, spec: string): boolean {
  return allowed.endsWith("/*") ? spec.startsWith(allowed.slice(0, -1)) : spec === allowed;
}

if (problems.length > 0) {
  console.error(problems.sort().join("\n"));
  console.error(`\n${problems.length} boundary violation(s). See docs/foundation.md §6.`);
  process.exit(1);
}
console.log("boundaries ok");
