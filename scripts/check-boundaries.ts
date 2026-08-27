/**
 * The dependency rules from `docs/foundation.md` §6, checked mechanically.
 *
 * TypeScript will not catch these on its own: workspace packages are symlinked into one
 * `node_modules`, so any package can import any other and still typecheck. The rules are the
 * design; this is what makes breaking one an error rather than a note in a document.
 */
import { Glob } from "bun";
import { dirname, join, relative } from "node:path";

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
    dir: "examples",
    allow: ["@wf/contract/workflow"],
    forbid: [
      {
        pattern: /^@wf\/(engine|harness)/,
        reason: "a workflow is written against the author surface, never the runtime",
      },
    ],
  },
];

/** `Bun.file`, `Bun.write`, `Bun.spawn` — an import ban alone would miss the global. */
const BUN_GLOBAL = /(^|[^\w.])Bun\s*\./;

const problems: string[] = [];

for (const rule of RULES) {
  const abs = join(ROOT, rule.dir);
  for await (const file of new Glob("**/*.ts").scan({ cwd: abs, absolute: true })) {
    const source = await Bun.file(file).text();
    const where = relative(ROOT, file);

    if (rule.dir === "packages/contract" && BUN_GLOBAL.test(source)) {
      problems.push(`${where}: uses the Bun global; contract is types and pure functions only`);
    }

    for (const spec of imports(source)) {
      if (spec.startsWith(".") || spec === "bun:test") continue;
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
for await (const manifest of new Glob("{packages,examples,experiments}/*/package.json").scan({
  cwd: ROOT,
  absolute: true,
})) {
  const pkg = (await Bun.file(manifest).json()) as {
    name: string;
    dependencies?: Record<string, string>;
  };
  const declared = new Set(Object.keys(pkg.dependencies ?? {}));
  for await (const file of new Glob("**/*.ts").scan({ cwd: dirname(manifest), absolute: true })) {
    const source = await Bun.file(file).text();
    for (const spec of imports(source)) {
      if (!spec.startsWith("@wf/")) continue;
      const owner = spec.split("/").slice(0, 2).join("/");
      if (owner === pkg.name || declared.has(owner)) continue;
      problems.push(
        `${relative(ROOT, file)}: imports ${spec}, but ${pkg.name} does not declare ${owner}`,
      );
    }
  }
}

function imports(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
    const spec = match[1];
    if (spec) found.push(spec);
  }
  return found;
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
