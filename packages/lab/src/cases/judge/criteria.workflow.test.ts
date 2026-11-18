import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answer, noAnswer, testWorkflow } from "agentswf/testing";
import { TRIAL_ENV } from "../format/trial-env";
import { writeGradeFolder } from "../lab/workflow-graders";
import judge, { settle, voteSchema } from "./criteria.workflow";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const was = process.env[TRIAL_ENV.grade];
afterEach(() => {
  if (was === undefined) delete process.env[TRIAL_ENV.grade];
  else process.env[TRIAL_ENV.grade] = was;
});

const MUST = "the summary names the trip's date";
const MUST_NOT = "the reply promises a refund";
const SECRET_FACT = "otter-quartz-violet";
const KEY_FILE_TEXT = "only the key folder holds this line";

/** A grade folder as the lab writes it for the judge: the key's criteria, `expect`, a `key/` file. */
function gradeFolder(previous?: object): void {
  const root = mkdtempSync(join(tmpdir(), "criteria-judge-"));
  roots.push(root);
  const caseDir = join(root, "built");
  mkdirSync(caseDir);
  writeFileSync(join(caseDir, "ticket.md"), "The trip is on the 14th.");
  const keyDir = join(root, "key");
  mkdirSync(keyDir);
  writeFileSync(join(keyDir, "notes.md"), KEY_FILE_TEXT);
  const kept = join(root, "kept");
  mkdirSync(kept);
  writeFileSync(join(kept, "summary.md"), "Trip on the 14th.");
  writeGradeFolder(
    join(root, "grade"),
    {
      case: {
        name: "trip",
        dir: caseDir,
        input: {},
        key: {
          kind: "awf.case-key/0",
          expect: { secret: SECRET_FACT },
          must: [MUST],
          "must-not": [MUST_NOT],
        },
        keyDir,
      },
      facts: { summary: "Trip on the 14th." },
      stages: {},
      result: { sent: true },
      scratch: null,
      kept,
      work: root,
      env: {},
      params: {},
      ...(previous ? { previous: previous as never } : {}),
    },
    true,
  );
  process.env[TRIAL_ENV.grade] = join(root, "grade");
}

const vote = (field: "must" | "must-not", verdict: string, extra: object = {}) =>
  answer(voteSchema(field), {
    verdict,
    why: `${verdict}, by the summary`,
    fromSavedFiles: false,
    ...extra,
  });
const args = { args: { harness: "claude", model: "claude-haiku-5-5", voters: 3 } };

describe("the criteria judge", () => {
  test("three voters per criterion; the majority decides, a 2–1 split marked", async () => {
    gradeFolder();
    const run = await testWorkflow(judge, {
      ...args,
      agents: {
        "c1-voter1": vote("must", "met"),
        "c1-voter2": vote("must", "met"),
        "c1-voter3": vote("must", "unmet"),
        "c2-voter*": vote("must-not", "violated"),
      },
    });
    expect(run.value.verdict).toBe("failed");
    expect(run.value.parts.map((p) => [p.about, p.verdict, p.settled])).toEqual([
      [`must: ${MUST}`, "passed", "majority"],
      [`must-not: ${MUST_NOT}`, "failed", "agreed"],
    ]);
    expect(run.value.parts[0].votes.map((v: { label: string }) => v.label)).toEqual([
      "met",
      "met",
      "unmet",
    ]);
    expect(run.value.reasons).toEqual([
      { about: `must-not: ${MUST_NOT}`, text: "violated, by the summary" },
    ]);
  });

  test("a voter with no answer and the other two split leaves the criterion unsettled", async () => {
    gradeFolder();
    const run = await testWorkflow(judge, {
      ...args,
      agents: {
        "c1-voter1": vote("must", "met"),
        "c1-voter2": vote("must", "unmet"),
        "c1-voter3": noAnswer.silent(),
        "c2-voter*": vote("must-not", "not violated"),
      },
    });
    expect(run.value.parts[0]).toMatchObject({ verdict: "undecided", settled: "unsettled" });
    expect(run.value.verdict).toBe("undecided");
  });

  test("two voters who agree decide when the third gives no answer", async () => {
    gradeFolder();
    const run = await testWorkflow(judge, {
      ...args,
      agents: {
        "c1-voter1": vote("must", "met"),
        "c1-voter2": vote("must", "met"),
        "c1-voter3": noAnswer.silent(),
        "c2-voter*": vote("must-not", "not violated"),
      },
    });
    expect(run.value.parts[0]).toMatchObject({ verdict: "passed", settled: "agreed" });
    expect(run.value.verdict).toBe("passed");
  });

  test("no voter's prompt holds the marker, expect, a key/ file or the agents' logs", async () => {
    gradeFolder();
    const run = await testWorkflow(judge, {
      ...args,
      agents: { "c1-voter*": vote("must", "met"), "c2-voter*": vote("must-not", "not violated") },
    });
    expect(run.turns).toHaveLength(6);
    for (const turn of run.turns) {
      expect(turn.prompt).not.toContain(SECRET_FACT);
      expect(turn.prompt).not.toContain("expect");
      expect(turn.prompt).not.toContain(KEY_FILE_TEXT);
      expect(turn.prompt).not.toContain("marker");
      expect(turn.prompt).toContain("Trip on the 14th.");
    }
    // Each voter is given its criterion alone.
    expect(run.turnsOf("c1-voter1")[0]!.prompt).toContain(MUST);
    expect(run.turnsOf("c1-voter1")[0]!.prompt).not.toContain(MUST_NOT);
  });

  test("with previous.json, only a changed criterion is judged", async () => {
    const kept = {
      about: `must: ${MUST}`,
      verdict: "passed",
      settled: "agreed",
      why: "judged before",
      votes: [],
    };
    gradeFolder({ key: "a".repeat(64), parts: [kept] });
    const run = await testWorkflow(judge, {
      ...args,
      agents: { "c2-voter*": vote("must-not", "not violated") },
    });
    expect(run.value.parts[0]).toEqual(kept);
    expect(run.agents.map((a) => a.key).sort()).toEqual(["c2-voter1", "c2-voter2", "c2-voter3"]);
  });

  test("a criterion any voter judged from saved files is marked read, not run", async () => {
    gradeFolder();
    const run = await testWorkflow(judge, {
      ...args,
      agents: {
        "c1-voter1": vote("must", "met", { fromSavedFiles: true }),
        "c1-voter*": vote("must", "met"),
        "c2-voter*": vote("must-not", "not violated"),
      },
    });
    expect(run.value.parts[0].data).toMatchObject({ readNotRun: true });
    expect(run.value.parts[1].data.readNotRun).toBeUndefined();
  });

  test("a voter that timed out fails the judge's run: never a verdict", async () => {
    gradeFolder();
    const run = await testWorkflow(judge, {
      ...args,
      agents: {
        "c1-voter1": vote("must", "met"),
        "c1-voter2": noAnswer.timedOut(),
        "c1-voter3": vote("must", "met"),
        "c2-voter*": vote("must-not", "not violated"),
      },
    });
    expect(() => run.value).toThrow("voter 2 on must 1 timed-out");
  });

  test("a criterion left unsettled before is judged again", async () => {
    const unsettled = {
      about: `must: ${MUST}`,
      verdict: "undecided",
      settled: "unsettled",
      votes: [],
    };
    const kept = {
      about: `must-not: ${MUST_NOT}`,
      verdict: "passed",
      settled: "agreed",
      votes: [],
    };
    gradeFolder({ key: "a".repeat(64), parts: [unsettled, kept] });
    const run = await testWorkflow(judge, {
      ...args,
      agents: { "c1-voter*": vote("must", "met") },
    });
    expect(run.value.parts[0]).toMatchObject({ verdict: "passed", settled: "agreed" });
    expect(run.value.parts[1]).toEqual(kept);
  });
});

test("five voters: a majority is three of them, whether or not all answered", () => {
  const vote = (verdict: string) => ({ verdict, why: "" }) as never;
  expect(
    settle("must", [vote("met"), vote("met"), vote("unmet"), vote("unmet"), undefined]),
  ).toMatchObject({ verdict: "undecided", settled: "unsettled" });
  expect(
    settle("must", [vote("met"), vote("met"), vote("met"), vote("unmet"), undefined]),
  ).toMatchObject({ verdict: "passed", settled: "majority" });
});
