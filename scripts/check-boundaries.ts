/**
 * The dependency rules from `docs/foundation.md` §6, checked mechanically.
 *
 * TypeScript will not catch these on its own: workspace packages are symlinked into one
 * `node_modules`, so any package can import any other and still typecheck. The rules are the
 * design; this is what makes breaking one an error rather than a note in a document.
 */

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
  /** Bare specifiers this unit may import, by exact match or `pkg/*` prefix. */
  allow?: string[];
  /** Reject any import matching this, with the reason to print. */
  forbid?: { pattern: RegExp; reason: string }[];
};

const NO_RUNTIME_API = [
  { pattern: /^node:/, reason: "contract is pure: no node builtins" },
  { pattern: /^bun(:|$)/, reason: "contract is pure: no bun builtins" },
];

const RULES: Rule[] = [
  { dir: "packages/contract", allow: [], forbid: NO_RUNTIME_API },
  { dir: "packages/harness", allow: ["@wf/contract", "@wf/contract/*"] },
  {
    dir: "packages/cli-agent",
    allow: ["@wf/contract", "@wf/contract/*"],
    forbid: [
      { pattern: /^@wf\/(engine|harness)/, reason: "cli-agent reaches the engine only over wire" },
      { pattern: /^(?:node:)?fs(?:\/|$)/, reason: "cli-agent never performs run-directory I/O" },
    ],
  },
  {
    dir: "examples",
    allow: ["@wf/contract/workflow"],
    forbid: [
      {
        pattern: /^@wf\/(engine|harness)/,
        reason: "a workflow is written against the author surface, never the runtime",
      },
      {
        // "Approved pure schema authoring libraries" is not a list the checker can hold; what it
        // can hold is that nothing here reaches a runtime, which is what made them approvable.
        pattern: /^(?:node:|bun$)/,
        reason: "a workflow is pure: schema authoring and prompts, never runtime I/O",
      },
    ],
  },
];

/** `Bun.file`, `Bun.write`, `Bun.spawn` — an import ban alone would miss the global. */
const BUN_GLOBAL = /(^|[^\w.])Bun\s*\./;
const BUN_FILE_IO = /(^|[^\w.])Bun\s*\.\s*(file|write)\s*\(/;

const problems: string[] = [];

for (const rule of RULES) {
  const abs = join(ROOT, rule.dir);
  for await (const file of new Glob("**/*.ts").scan({ cwd: abs, absolute: true })) {
    const source = await Bun.file(file).text();
    const where = relative(ROOT, file);

    if (rule.dir === "packages/contract" && BUN_GLOBAL.test(source)) {
      problems.push(`${where}: uses the Bun global; contract is types and pure functions only`);
    }
    if (rule.dir === "packages/cli-agent" && BUN_FILE_IO.test(source)) {
      problems.push(`${where}: cli-agent never performs run-directory I/O`);
    }
    if (rule.dir === "examples" && BUN_GLOBAL.test(source)) {
      problems.push(`${where}: uses the Bun global; a workflow is pure`);
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
