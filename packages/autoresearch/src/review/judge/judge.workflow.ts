// awf run packages/autoresearch/src/review/judge/judge.workflow.ts --cwd {checkout} -- \
//   [--panel codex/gpt-6-sol,claude/claude-sonnet-5] [--tiebreak codex/gpt-6-luna] \
//   --fixture {fixture dir} --findings {findings.json}
//
// The panel judge (story 008): two judges from different model families label every finding of
// a review against the fixture's key, in the frozen code it runs in, each answer checked in code
// and handed back once if it fails; a judge that fails again fails the judging. A third votes on
// the findings they split on. Its value is a
// checked `awf.review-judgement/1`, with every vote. awf-lab runs it; `PANEL_JUDGE` names it.
import { join, resolve } from "node:path";
import {
  defineExecutableWorkflow,
  type ExecutionConfig,
  isAnswered,
  type OutputSchema,
  type WorkflowContext,
  type WorkflowInvocation,
} from "@wf/contract/workflow";
import Type from "typebox";
import type { AnswerKey, Fixture } from "../format/format";
import { runtimeName, runtimeOf } from "../format/runtime";
import {
  FindingLabelSchema,
  JUDGEMENT_FORMAT,
  type Judgement,
  type ReviewFinding,
} from "../format/scoring";
import {
  checkAnswerKey,
  checkFixture,
  checkJudgementShape,
  checkReviewFindings,
  describeProblems,
} from "../format/validate";
import { checkJudgement, type LabelOptions, labelProblems } from "./check";
import { disputed, settle, type Vote } from "./panel";
import { judgePrompt, NO_ANSWER, retryPrompt, tiebreakPrompt } from "./prompt";

type Args = {
  cwd: string;
  fixture: string;
  findings: string;
  panel: [ExecutionConfig, ExecutionConfig];
  tiebreak: ExecutionConfig;
};

type Answer = { labels: Judgement["labels"]; missed: string };

/** The engine's answer schema has no `pattern`; every answer is checked in full in code. */
const ANSWER = JSON.parse(
  JSON.stringify(
    Type.Object(
      { labels: Type.Array(FindingLabelSchema), missed: Type.String() },
      { additionalProperties: false },
    ),
    (name, value) => (name === "pattern" ? undefined : value),
  ),
) as OutputSchema<Answer>;

type Case = { fixture: Fixture; request: string; key: AnswerKey; findings: ReviewFinding[] };

const executable = defineExecutableWorkflow<Args, Judgement>({
  definition: {
    meta: {
      name: "review-panel-judge",
      description:
        "Label a review's findings against a fixture's answer key with a panel of judges.",
      whenToUse: "Run by awf-lab to score a review run (story 008).",
    },
    async run(workflow, args) {
      const input = await readCase(args);
      if (input.findings.length === 0) {
        return { format: JUDGEMENT_FORMAT, labels: [], missed: "The review found nothing." };
      }
      const voters = args.panel.map((runtime, index) => ({
        by: `judge${index + 1}:${runtimeName(runtime)}`,
        runtime,
      }));
      const tiebreaker = { by: `tiebreak:${runtimeName(args.tiebreak)}`, runtime: args.tiebreak };
      const answers = await workflow.parallel(
        voters,
        (voter) => ask(workflow, voter, args.cwd, input, judgePrompt(input)),
        { label: "Judge" },
      );
      const [a, b] = answers as [Asked, Asked];
      // A panel is two families; one judge's labels alone are not its judgement. A judge that
      // failed twice fails the judging, which awf-lab records to retry.
      if (!a.ok || !b.ok) {
        const withheld = [a, b].flatMap((vote) => (vote.ok ? [] : [`${vote.by}: ${vote.detail}`]));
        throw new Error(`a judge withheld its vote: ${withheld.join("; ")}`);
      }
      const panel: [Vote, Vote] = [
        { by: a.by, role: "panel", labels: a.answer.labels },
        { by: b.by, role: "panel", labels: b.answer.labels },
      ];
      const split = disputed(panel[0].labels, panel[1].labels);
      let third: Vote | undefined;
      if (split.length > 0) {
        workflow.log(`The judges split on findings ${split.join(", ")}; the tiebreak votes`);
        const settled = panel[0].labels;
        const claimed = new Map(
          settled.flatMap((label) =>
            label.label === "hit" && !split.includes(label.finding)
              ? [[label.issue, label.finding] as const]
              : [],
          ),
        );
        const answered = await ask(
          workflow,
          tiebreaker,
          args.cwd,
          input,
          tiebreakPrompt({ ...input, asked: split, settled }),
          { asked: split, claimed },
        );
        if (answered.ok) {
          third = { by: answered.by, role: "tiebreak", labels: answered.answer.labels };
        } else workflow.log(`${answered.by} gave no valid vote; the split findings stay unsettled`);
      }
      const judgement: Judgement = {
        format: JUDGEMENT_FORMAT,
        labels: settle(panel[0], panel[1], third),
        missed: [a, b].map((vote) => `${vote.by}: ${vote.answer.missed}`).join("\n"),
        votes: [...panel, ...(third ? [third] : [])],
      };
      const checked = checkJudgement(judgement, input.findings, input.key);
      if (!checked.ok) {
        throw new Error(describeProblems("the settled judgement", checked.problems));
      }
      return checked.value;
    },
  },
  prepare: parseArgs,
  present: (judgement) =>
    judgement.labels
      .map(
        (label) =>
          `${label.finding}: ${label.label === "hit" ? `hit ${label.issue}` : label.label}`,
      )
      .join("\n"),
});

type Asked = { ok: true; by: string; answer: Answer } | { ok: false; by: string; detail: string };

/**
 * One judge, in a session of its own in the frozen code: an answer that fails its checks is handed
 * back once with what is wrong, and a judge that still can't answer withholds its vote.
 */
async function ask(
  workflow: WorkflowContext,
  voter: { by: string; runtime: ExecutionConfig },
  cwd: string,
  input: Case,
  first: string,
  options: LabelOptions = {},
): Promise<Asked> {
  const agent = await workflow.agents.open({ key: voter.by, runtime: voter.runtime, cwd });
  let prompt = first;
  let detail = "no attempt made";
  for (let attempt = 1; attempt <= 2; attempt++) {
    // This loop is the re-ask, so the engine's own nudge would only be a second one.
    const { outcome } = await agent.run({ prompt, schema: ANSWER, nudge: false });
    if (!isAnswered(outcome)) {
      detail = `${outcome.kind}: ${outcome.reason}`;
      if (outcome.kind === "timed-out" || outcome.kind === "cancelled") break;
      prompt = NO_ANSWER;
      continue;
    }
    const shaped = checkJudgementShape({ format: JUDGEMENT_FORMAT, ...outcome.value });
    const problems = shaped.ok
      ? labelProblems(shaped.value.labels, input.findings, input.key, { ...options, voter: true })
      : shaped.problems;
    if (problems.length === 0) return { ok: true, by: voter.by, answer: outcome.value };
    detail = problems.map((p) => `${p.path}: ${p.message}`).join("; ");
    workflow.log(`${voter.by}: answer ${attempt} failed its checks: ${detail}`);
    prompt = retryPrompt(problems);
  }
  return { ok: false, by: voter.by, detail };
}

async function readCase(args: Args): Promise<Case> {
  const fixture = checkFixture(await Bun.file(join(args.fixture, "fixture.json")).json());
  if (!fixture.ok) throw new Error(describeProblems("fixture.json", fixture.problems));
  const key = checkAnswerKey(await Bun.file(join(args.fixture, "key", "key.json")).json());
  if (!key.ok) throw new Error(describeProblems("key/key.json", key.problems));
  const findings = checkReviewFindings(await Bun.file(args.findings).json());
  if (!findings.ok) throw new Error(describeProblems(args.findings, findings.problems));
  const request = await Bun.file(join(args.fixture, "request.md")).text();
  return { fixture: fixture.value, request, key: key.value, findings: findings.value };
}

/** Two judges from different model families, so a majority isn't one model agreeing with itself. */
const PANEL = "codex/gpt-6-sol,claude/claude-sonnet-5";
const TIEBREAK = "codex/gpt-6-luna";

function parseArgs(invocation: WorkflowInvocation): Args {
  const values = new Map<string, string>();
  const argv = [...invocation.argv];
  while (argv.length > 0) {
    const flag = argv.shift()!;
    const value = argv.shift();
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error(`expected --flag value, got ${flag}`);
    }
    const name = flag.slice(2);
    if (!["fixture", "findings", "panel", "tiebreak"].includes(name)) {
      throw new Error(`unknown flag --${name}`);
    }
    if (values.has(name)) throw new Error(`--${name} is given twice`);
    values.set(name, value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return resolve(invocation.cwd, value);
  };
  const panel = (values.get("panel") ?? PANEL).split(",").map((spec) => runtimeOf(spec.trim()));
  if (panel.length !== 2) throw new Error("--panel names two judges, harness/model,harness/model");
  return {
    cwd: invocation.cwd,
    fixture: required("fixture"),
    findings: required("findings"),
    panel: [panel[0]!, panel[1]!],
    tiebreak: runtimeOf(values.get("tiebreak") ?? TIEBREAK),
  };
}

export const panelJudge = executable.definition;
export default executable;
