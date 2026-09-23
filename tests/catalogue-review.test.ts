import { afterAll, describe, expect, test } from "bun:test";
import { matchesAny } from "../examples/catalogue-review/paths";
import {
  presentCatalogueResult,
  reportCatalogueResult,
} from "../examples/catalogue-review/present";
import {
  type CatalogueResult,
  defineCatalogueReview,
  type Lens,
} from "../examples/catalogue-review/workflow";
import { runWorkflow } from "../packages/engine/src";
import { createTempRunDirs, future, submit } from "../packages/engine/src/testing";
import type { AgentRuntimeConfig, AgentSessionAdapter } from "../packages/harness/src/adapter";
import { createSingleSessionHostFactory } from "../packages/harness/src/single-session-host";
import { createFakeAdapter } from "../packages/harness/src/testing/fake";

const runDirs = createTempRunDirs();
afterAll(() => runDirs.cleanup());

const LENSES: Lens[] = [
  { id: "database", page: "rules.md#database", rules: "- Keep migrations idempotent." },
  { id: "deploys", page: "rules.md#deploys", rules: "- Keep old clients working." },
];

const executable = defineCatalogueReview({
  name: "catalogue-review",
  description: "fixture",
  lenses: LENSES,
});

const prepare = (...argv: string[]) => executable.prepare({ argv, cwd: "/repo" });

describe("catalogue review entry point", () => {
  test("with no arguments, reviews the branch against origin/main through every lens", () => {
    expect(prepare()).toEqual({
      range: "origin/main...HEAD",
      lenses: LENSES,
      skipped: [],
      runtime: "claude",
    });
  });

  test("--range and --lenses narrow it, and an unknown lens names the known ones", () => {
    expect(prepare("--range", "HEAD~1..HEAD", "--lenses", "deploys")).toMatchObject({
      range: "HEAD~1..HEAD",
      lenses: [LENSES[1]],
    });
    expect(() => prepare("--lenses", "db")).toThrow("known: database, deploys");
    expect(() => prepare("--range")).toThrow("--range needs a value");
    expect(() => prepare("target")).toThrow("unknown option target");
  });

  test("with changed files, a lens runs only when one matches its paths, unless named", () => {
    const scoped = defineCatalogueReview({
      name: "catalogue-review",
      description: "fixture",
      lenses: [
        { ...LENSES[0]!, paths: ["db/**", "**/*.sql"] },
        { ...LENSES[1]!, paths: ["deploy/**"] },
        { id: "docs", page: "rules.md#docs", rules: "- Say what is." },
      ],
      changedFiles: (range) => (range === "origin/main...HEAD" ? ["api/queries/report.sql"] : []),
    });
    const run = (...argv: string[]) => scoped.prepare({ argv, cwd: "/repo" });

    expect(run()).toMatchObject({ skipped: ["deploys"] });
    expect(run().lenses.map((lens) => lens.id)).toEqual(["database", "docs"]);
    expect(run("--range", "A...B")).toMatchObject({ skipped: ["database", "deploys"] });
    expect(run("--lenses", "deploys")).toMatchObject({ lenses: [{ id: "deploys" }], skipped: [] });
  });

  test("globs: ** spans directories, including none; * and ? stay in one segment", () => {
    expect(matchesAny("db/migrations/0001.sql", ["db/**"])).toBe(true);
    expect(matchesAny("0001.sql", ["**/*.sql"])).toBe(true);
    expect(matchesAny("api/q/report.sql", ["**/*.sql"])).toBe(true);
    expect(matchesAny("api/q/report.sql", ["api/*.sql"])).toBe(false);
    expect(matchesAny("ui-admin/src/a.tsx", ["ui-*/**"])).toBe(true);
    expect(matchesAny("a.spec.ts", ["?.spec.ts"])).toBe(true);
    expect(matchesAny("dbx/a.sql", ["db/**"])).toBe(false);
  });

  test("verifies the most severe findings first, observations included, on the verifier runtime", async () => {
    const raw = (severity: string, line: number) => ({
      source: "catalogue",
      rule: "idempotent migrations",
      severity,
      file: "db/0001.sql",
      line,
      claim: `${severity} claim`,
      evidence: "seen",
    });
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const lens = context.activation.labels?.lens;
          await submit(
            context.binding!,
            lens === "database"
              ? { findings: [raw("observation", 1), raw("issue", 2)] }
              : lens === "deploys"
                ? { findings: [raw("observation", 5)] }
                : { refuted: false, reason: "holds", attribution: "valid" },
          );
        },
      }),
    });
    const judged = defineCatalogueReview({
      name: "catalogue-review",
      description: "fixture",
      lenses: LENSES,
      verifierRuntime: "judge",
      maxVerifyPerLens: 1,
    });

    const result = await runWorkflow(
      judged.definition,
      judged.prepare({ argv: [], cwd: "/repo" }),
      {
        runRoot: runDirs.tempRunDir(),
        runtime: runtime(adapter),
        deadline: future(),
        cwd: "/repo",
      },
    );

    expect(
      result.value.findings.map((finding) => [
        finding.lens,
        finding.line,
        finding.verification.kind,
      ]),
    ).toEqual([
      ["database", 2, "confirmed"],
      ["deploys", 5, "confirmed"],
      ["database", 1, "not-checked"],
    ]);
    const models = (key: string) =>
      adapter.activations
        .filter((activation) => activation.key.startsWith(key))
        .map((activation) => activation.execution.model);
    expect(models("lens:")).toEqual(["fake", "fake"]);
    expect(models("verifier:")).toEqual(["judge", "judge"]);
  });

  test("lenses see their rules inline, and verifiers see the rules the finding cites", async () => {
    const adapter = createFakeAdapter({
      script: (context) => ({
        act: async () => {
          const labels = context.activation.labels ?? {};
          const raw =
            typeof labels.lens === "string"
              ? {
                  findings:
                    labels.lens === "database"
                      ? [
                          {
                            source: "catalogue",
                            rule: "idempotent migrations",
                            severity: "issue",
                            file: "db/0001.sql",
                            line: 3,
                            claim: "CREATE TYPE is not guarded",
                            evidence: "no IF NOT EXISTS",
                          },
                        ]
                      : [],
                }
              : { refuted: false, reason: "the enum add is unguarded", attribution: "valid" };
          await submit(context.binding!, raw);
        },
      }),
    });

    const result = await runWorkflow(executable.definition, prepare(), {
      runRoot: runDirs.tempRunDir(),
      runtime: runtime(adapter),
      deadline: future(),
      cwd: "/repo",
    });

    expect(result.value.failures).toEqual([]);
    expect(result.value.findings).toEqual([
      expect.objectContaining({
        lens: "database",
        file: "db/0001.sql",
        verification: { kind: "confirmed", reason: "the enum add is unguarded" },
      }),
    ]);
    const prompts = adapter.turns.map((turn) => turn.prompt);
    expect(prompts.find((prompt) => prompt.includes("Keep migrations idempotent"))).toContain(
      "git diff origin/main...HEAD",
    );
    expect(prompts.find((prompt) => prompt.includes("Try to refute"))).toContain(
      "Keep migrations idempotent",
    );
    expect(
      adapter.activations.every((activation) =>
        activation.instructions?.includes("Do not modify files"),
      ),
    ).toBe(true);
  });
});

describe("catalogue review report", () => {
  const finding = {
    source: "catalogue" as const,
    rule: "idempotent migrations",
    lens: "database",
    page: "rules.md#database",
    evidence: "no IF NOT EXISTS guard around the type",
  };

  const result: CatalogueResult = {
    range: "origin/main...HEAD",
    lenses: ["database", "deploys"],
    skipped: ["frontend"],
    findings: [
      {
        ...finding,
        severity: "minor",
        file: "db/0002.sql",
        claim: "The index is created twice",
        verification: { kind: "refuted", reason: "the second statement drops it first" },
      },
      {
        ...finding,
        severity: "minor",
        file: "db/0001.sql",
        line: 9,
        claim: "The down migration drops the type first",
        verification: { kind: "confirmed", reason: "the column still uses it" },
      },
      {
        ...finding,
        severity: "issue",
        file: "db/0001.sql",
        line: 3,
        claim: "CREATE TYPE is not guarded",
        suggestion: "Wrap it in a DO block",
        verification: { kind: "confirmed", reason: "a rerun fails on the existing type" },
      },
    ],
    failures: [{ stage: "lens", subject: "deploys", reason: "turn deadline exceeded" }],
    usage: [],
  };

  test("the summary lists each finding to act on in a line, by file, and the failures", () => {
    expect(presentCatalogueResult(result)).toBe(
      [
        "Reviewed origin/main...HEAD through 2 lenses: database, deploys",
        "Skipped, no matching files changed: frontend",
        "2 confirmed findings · 1 refuted · 0 not checked · 1 failed agent",
        "",
        "CONFIRMED",
        "",
        "db/0001.sql",
        "  1. [issue] line 3 CREATE TYPE is not guarded",
        "  2. [minor] line 9 The down migration drops the type first",
        "",
        "FAILED",
        "- lens deploys: turn deadline exceeded",
      ].join("\n"),
    );
  });

  test("the report carries the evidence, numbered as in the summary, and what was refuted", () => {
    expect(reportCatalogueResult(result)).toBe(
      [
        "# Review of `origin/main...HEAD`",
        "",
        "Lenses: database, deploys. Skipped, no matching files changed: frontend.",
        "",
        "2 confirmed findings · 1 refuted · 0 not checked · 1 failed agent.",
        "",
        "## Confirmed",
        "",
        "Each of these survived a separate attempt to refute it. Fix it, or say why it does not hold.",
        "",
        "### `db/0001.sql`",
        "",
        "**1. issue, line 3** · database · idempotent migrations",
        "",
        "CREATE TYPE is not guarded",
        "",
        "- Evidence: no IF NOT EXISTS guard around the type",
        "- Suggestion: Wrap it in a DO block",
        "- Verifier: a rerun fails on the existing type",
        "",
        "**2. minor, line 9** · database · idempotent migrations",
        "",
        "The down migration drops the type first",
        "",
        "- Evidence: no IF NOT EXISTS guard around the type",
        "- Verifier: the column still uses it",
        "",
        "## Refuted",
        "",
        "Raised and then disproved; listed so they are not chased again.",
        "",
        "- `db/0002.sql` (database · idempotent migrations): The index is created twice",
        "  - Why not: the second statement drops it first",
        "",
        "## Did not complete",
        "",
        "- lens `deploys`: turn deadline exceeded",
      ].join("\n"),
    );
  });

  test("wraps long text under its own indent", () => {
    const claim = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const report = presentCatalogueResult({
      range: "A...B",
      lenses: ["database"],
      skipped: [],
      findings: [
        {
          ...finding,
          severity: "issue",
          file: "a.sql",
          claim,
          verification: { kind: "not-checked" },
        },
      ],
      failures: [],
      usage: [],
    });
    const lines = report.split("\n");
    expect(lines.every((line) => line.length <= 100)).toBe(true);
    expect(lines.filter((line) => line.startsWith("     word")).length).toBeGreaterThan(1);
  });
});

function runtime(adapter: AgentSessionAdapter): AgentRuntimeConfig {
  return {
    aliases: {
      claude: { harness: "fake", model: "fake" },
      judge: { harness: "fake", model: "judge" },
    },
    host: createSingleSessionHostFactory(adapter),
  };
}
