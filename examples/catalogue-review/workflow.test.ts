import { describe, expect, test } from "bun:test";
import { answer, reply, testWorkflow } from "@agentswf/engine/workflow-testing";
import { matchesAny } from "./paths";
import { presentCatalogueResult, reportCatalogueResult } from "./present";
import { FINDINGS_SCHEMA, type RawFinding, VERDICT_SCHEMA } from "./schema";
import { type CatalogueResult, defineCatalogueReview, type Lens } from "./workflow";

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

const unguarded = {
  source: "catalogue",
  rule: "idempotent migrations",
  severity: "issue",
  file: "db/0001.sql",
  line: 3,
  claim: "CREATE TYPE is not guarded",
  evidence: "no IF NOT EXISTS",
} satisfies RawFinding;
const holds = answer(VERDICT_SCHEMA, { refuted: false, reason: "it holds", attribution: "valid" });

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
});

describe("catalogue review run", () => {
  test("verifies the most severe findings first, observations included, on the verifier runtime, and a lens runs on its own runtime", async () => {
    const raw = (severity: RawFinding["severity"], line: number): RawFinding => ({
      ...unguarded,
      severity,
      line,
      claim: `${severity} claim`,
    });
    const judged = defineCatalogueReview({
      name: "catalogue-review",
      description: "fixture",
      lenses: [LENSES[0]!, { ...LENSES[1]!, runtime: "cheap" }],
      verifierRuntime: "judge",
      maxVerifyPerLens: 1,
    });
    const run = await testWorkflow(judged, judged.prepare({ argv: [], cwd: "/repo" }), {
      runtimes: {
        cheap: { harness: "codex", model: "cheap" },
        judge: { harness: "codex", model: "judge" },
      },
      agents: {
        "lens:database": answer(FINDINGS_SCHEMA, {
          findings: [raw("observation", 1), raw("issue", 2)],
        }),
        "lens:deploys": answer(FINDINGS_SCHEMA, { findings: [raw("observation", 5)] }),
        "verifier:*": holds,
      },
    });

    expect(
      run.value.findings.map((finding) => [finding.lens, finding.line, finding.verification.kind]),
    ).toEqual([
      ["database", 2, "confirmed"],
      ["deploys", 5, "confirmed"],
      ["database", 1, "not-checked"],
    ]);
    const alias = (key: string) => run.agentOf(key).execution.alias;
    expect([alias("lens:database"), alias("lens:deploys")]).toEqual(["claude", "cheap"]);
    expect([alias("verifier:0"), alias("verifier:1")]).toEqual(["judge", "judge"]);
    expect(run.logs.map((log) => log.message)).toContain("database: 1 findings not verified");
  });

  test("lenses see their rules inline, and verifiers see the rules the finding cites", async () => {
    const run = await testWorkflow(executable, prepare(), {
      agents: {
        "lens:database": answer(FINDINGS_SCHEMA, { findings: [unguarded] }),
        "lens:deploys": answer(FINDINGS_SCHEMA, { findings: [] }),
        "verifier:*": answer(VERDICT_SCHEMA, {
          refuted: false,
          reason: "the enum add is unguarded",
          attribution: "valid",
        }),
      },
    });

    expect(run.value.failures).toEqual([]);
    expect(run.value.findings).toEqual([
      expect.objectContaining({
        lens: "database",
        file: "db/0001.sql",
        verification: { kind: "confirmed", reason: "the enum add is unguarded" },
      }),
    ]);
    expect(run.turnsOf("lens:database")[0]!.prompt).toContain("Keep migrations idempotent");
    expect(run.turnsOf("lens:database")[0]!.prompt).toContain("git diff origin/main...HEAD");
    expect(run.turnsOf("verifier:0")[0]!.prompt).toContain("Try to refute");
    expect(run.turnsOf("verifier:0")[0]!.prompt).toContain("Keep migrations idempotent");
    expect(run.agents.every((agent) => agent.instructions?.includes("Do not modify files"))).toBe(
      true,
    );
  });

  test("a rule the verifier finds misattributed makes the finding general", async () => {
    const run = await testWorkflow(executable, prepare("--lenses", "database"), {
      agents: {
        "lens:database": answer(FINDINGS_SCHEMA, { findings: [unguarded] }),
        "verifier:0": answer(VERDICT_SCHEMA, {
          refuted: false,
          reason: "the rule is about data, not types",
          attribution: "invalid",
        }),
      },
    });
    const [finding] = run.value.findings;
    expect(finding).toMatchObject({
      source: "general",
      attributionFailure: "the rule is about data, not types",
      verification: { kind: "confirmed" },
    });
    expect(finding).not.toHaveProperty("rule");
  });

  test("a catalogue finding that names no rule is general", async () => {
    const { rule: _, ...ruleless } = unguarded;
    const run = await testWorkflow(executable, prepare("--lenses", "database"), {
      agents: {
        "lens:database": answer(FINDINGS_SCHEMA, { findings: [ruleless] }),
        "verifier:0": answer(VERDICT_SCHEMA, {
          refuted: true,
          reason: "guarded upstream",
          attribution: "not-applicable",
        }),
      },
    });
    expect(run.value.findings[0]).toMatchObject({
      source: "general",
      verification: { kind: "refuted", reason: "guarded upstream" },
    });
  });

  test("a lens or a verifier that fails is a failure in the result, and the rest go on", async () => {
    const run = await testWorkflow(executable, prepare(), {
      agents: {
        "lens:database": answer(FINDINGS_SCHEMA, { findings: [unguarded] }),
        "lens:deploys": reply.failed("harness crashed"),
        "verifier:0": reply.timedOut("verifier timed out"),
      },
    });
    expect(run.value.failures).toEqual([
      { stage: "lens", subject: "deploys", reason: "harness crashed" },
      { stage: "verify", subject: "database:db/0001.sql:3", reason: "verifier timed out" },
    ]);
    expect(run.value.findings).toEqual([
      expect.objectContaining({ lens: "database", verification: { kind: "not-checked" } }),
    ]);
  });

  test("two lenses with one id are refused", async () => {
    const run = await testWorkflow(executable, { ...prepare(), lenses: [LENSES[0]!, LENSES[0]!] });
    expect(() => run.value).toThrow("lens ids must be unique");
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
    });
    const lines = report.split("\n");
    expect(lines.every((line) => line.length <= 100)).toBe(true);
    expect(lines.filter((line) => line.startsWith("     word")).length).toBeGreaterThan(1);
  });
});
