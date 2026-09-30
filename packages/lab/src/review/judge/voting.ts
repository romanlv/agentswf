import type {
  ExecutionConfig,
  InlineSandboxSpec,
  WorkflowContext,
} from "@agentswf/contract/workflow";
import { isAnswered } from "@agentswf/contract/workflow";
import { runtimeName } from "../format/runtime";
import type { FindingLabel } from "../format/scoring";
import { ANSWER, claimedIn, type JudgedCase } from "./case";
import { labelProblems } from "./check";
import { disputed, settle, type Vote } from "./panel";
import { judgePrompt, NO_ANSWER, retryPrompt, tiebreakPrompt } from "./prompt";

/** Who labels what matching leaves; `sandbox`, when named, gives each agent a private one. */
export type Voters = {
  voters: ExecutionConfig[];
  tiebreak?: ExecutionConfig;
  sandbox?: "srt" | "docker";
  /** Each turn's bound; a turn past it is asked once more in a fresh session. */
  turnMs: number;
};

// Private, reading only the agent's working directory, the checkout, and reaching only its model.
const SANDBOXES: Record<"srt" | "docker", InlineSandboxSpec> = {
  srt: { srt: {} },
  docker: { docker: {} },
};

function restPrompt(
  input: JudgedCase,
  asked: readonly number[],
  claimed: ReadonlyMap<string, number>,
): string {
  if (asked.length === input.findings.length) return judgePrompt(input);
  const hit = [...claimed].map(([issue, by]) => `${issue} by finding ${by}`).join("; ") || "none";
  return `${judgePrompt(input)}

## What you are asked

The other findings are settled. Label only findings ${asked.join(", ")}, in order: your answer's \`labels\` has exactly one label for each of them and none for the others. Known issues already hit: ${hit}. Such an issue can't be hit again: a finding that gives its mechanism is a duplicate of the finding that hit it when that one comes first, and otherwise takes whichever other label fits it. \`missed\` can be empty.`;
}

type Voter = { by: string; runtime: ExecutionConfig; sandbox?: InlineSandboxSpec };
type Asked = { ok: true; labels: FindingLabel[]; missed: string } | { ok: false; detail: string };

/**
 * One agent's labels for `asked`, checked. An answer that fails its checks is handed back once,
 * and a missing one is asked for once. A turn that runs past `turnMs` gets one more turn in a
 * fresh session: every panel timeout measured was a voter that stopped making progress, which the
 * same session would not recover from. So an agent takes at most three turns, `3 × turnMs` in all.
 */
async function ask(
  workflow: WorkflowContext,
  voter: Voter,
  input: JudgedCase,
  prompt: string,
  rules: { asked: readonly number[]; claimed: ReadonlyMap<string, number> },
  turnMs: number,
): Promise<Asked> {
  const { by, runtime, sandbox } = voter;
  const open = (key: string) =>
    workflow.agents.open({ key, runtime, cwd: workflow.cwd, ...(sandbox ? { sandbox } : {}) });
  let agent = await open(by);
  let next = prompt;
  let fresh = false;
  let detail = "no attempt made";
  for (let turn = 1; turn <= 3; turn++) {
    // This loop is the re-ask, so the engine's own nudge would only be a second one.
    const { outcome } = await agent.run({
      prompt: next,
      schema: ANSWER,
      nudge: false,
      timeoutMs: turnMs,
    });
    if (isAnswered(outcome)) {
      const problems = labelProblems(outcome.value.labels, input.findings, input.key, {
        ...rules,
        voter: true,
      });
      if (problems.length === 0) {
        return { ok: true, labels: outcome.value.labels, missed: outcome.value.missed };
      }
      detail = problems.map((p) => `${p.path}: ${p.message}`).join("; ");
      workflow.log(`${by}: turn ${turn} failed its checks: ${detail}`);
      if (next !== prompt && !fresh) return { ok: false, detail };
      next = retryPrompt(problems);
      continue;
    }
    detail = `${outcome.kind}: ${outcome.reason}`;
    if (outcome.kind === "timed-out" && !fresh) {
      workflow.log(
        `${by}: turn ${turn} ran past ${Math.round(turnMs / 60_000)} min; asking once more, fresh`,
      );
      fresh = true;
      agent = await open(`${by}#fresh`);
      next = prompt;
      turn = 2; // the fresh session gets the last of the three turns
      continue;
    }
    if (outcome.kind !== "unanswered" || next === NO_ANSWER) return { ok: false, detail };
    next = NO_ANSWER;
  }
  return { ok: false, detail };
}

/**
 * Labels for every finding: `settled` as given, the rest by the voters. Returns the votes too, each
 * a full labelling with `settled` in place, as a judgement's `votes` holds them, and what each
 * voter said the review missed. One voter's labels stand alone; two vote as a panel, a split going
 * to the tiebreak, which sees neither vote. A voter that gives no valid answer fails the judging.
 * With nothing settled, this is the panel.
 */
export async function voteOnRest(
  workflow: WorkflowContext,
  input: JudgedCase,
  settled: ReadonlyMap<number, FindingLabel>,
  { voters, tiebreak, sandbox, turnMs }: Voters,
): Promise<{ labels: Map<number, FindingLabel>; votes: Vote[]; missed: string }> {
  const labels = new Map(settled);
  const asked = input.findings.map((_, i) => i).filter((i) => !settled.has(i));
  if (voters.length === 0 || asked.length === 0) return { labels, votes: [], missed: "" };
  if (voters.length > 2) throw new Error(`one or two voters, not ${voters.length}`);
  const claimed = claimedIn([...settled.values()]);
  const prompt = restPrompt(input, asked, claimed);
  const box = sandbox ? SANDBOXES[sandbox] : undefined;
  const named = voters.map((runtime, i) => ({
    runtime,
    ...(box ? { sandbox: box } : {}),
    by: `judge${i + 1}:${runtimeName(runtime)}`,
  }));
  const answers = await workflow.parallel(
    named,
    (voter) => ask(workflow, voter, input, prompt, { asked, claimed }, turnMs),
    { label: "Judge" },
  );
  const withheld = answers.flatMap((a, i) => (a.ok ? [] : [`${named[i]!.by}: ${a.detail}`]));
  if (withheld.length > 0) throw new Error(`a judge withheld its vote: ${withheld.join("; ")}`);
  const given = answers as Extract<Asked, { ok: true }>[];
  const missed = given.map((a, i) => `${named[i]!.by}: ${a.missed}`).join("\n");
  const full = (mine: readonly FindingLabel[]) =>
    input.findings.map((_, i) => mine.find((l) => l.finding === i) ?? settled.get(i)!);
  const votes = named.map(
    (v, i): Vote => ({ by: v.by, role: "panel", labels: full(given[i]!.labels) }),
  );
  if (votes.length === 1) {
    for (const label of votes[0]!.labels) labels.set(label.finding, label);
    return { labels, votes, missed };
  }
  const [a, b] = votes as [Vote, Vote];
  const split = disputed(a.labels, b.labels);
  let third: Vote | undefined;
  if (split.length > 0 && tiebreak) {
    workflow.log(`The judges split on findings ${split.join(", ")}; the tiebreak votes`);
    const by = `tiebreak:${runtimeName(tiebreak)}`;
    const answered = await ask(
      workflow,
      { by, runtime: tiebreak, ...(box ? { sandbox: box } : {}) },
      input,
      tiebreakPrompt({ ...input, asked: split, settled: a.labels }),
      { asked: split, claimed: claimedIn(a.labels, split) },
      turnMs,
    );
    if (answered.ok) {
      third = { by, role: "tiebreak", labels: answered.labels };
      votes.push(third);
    } else
      workflow.log(
        `${by} gave no valid vote (${answered.detail}); the split findings stay unsettled`,
      );
  }
  for (const label of settle(a, b, third)) labels.set(label.finding, label);
  return { labels, votes, missed };
}
