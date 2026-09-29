import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecutionConfig,
  isAnswered,
  type OutputSchema,
  type WorkflowContext,
} from "@agentswf/contract/workflow";
import { restore } from "../fixtures/git";
import type { GitLabDiscussion, GitLabMergeRequest, GitLabVersion } from "../fixtures/gitlab-types";
import { type OrderedVersion, orderVersions } from "../fixtures/review-start";
import { threads } from "../fixtures/threads";
import { openKeyRepo, SNAPSHOT_REF, verifyKey } from "../fixtures/verify";
import {
  type AnswerKey,
  type Fixture,
  KEY_FORMAT,
  type KeyBody,
  KeyBodySchema,
  SEVERITIES,
  VOTES_FORMAT,
  type Votes,
} from "../format/format";
import {
  ballotProblems,
  majority,
  SEVERITY_RUBRIC,
  type Severity,
  settleSeverity,
} from "../format/grading";
import type { Problem } from "../format/validate";

/**
 * The engine's answer schema has no `pattern`, so the agent is held to the shape without it; the
 * full check, patterns included, runs on every draft in `verifyKey`.
 */
const KEY_BODY = JSON.parse(
  JSON.stringify(KeyBodySchema, (name, value) => (name === "pattern" ? undefined : value)),
) as OutputSchema<KeyBody>;

type VoteAnswer = {
  issues: { id: string; real: boolean; severity: Severity; why: string }[];
  refuted: { id: string; wrong: boolean; why: string }[];
};

const item = (properties: Record<string, unknown>) => ({
  type: "array",
  items: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});
const TEXT = { type: "string", minLength: 1 };
const VOTE_ANSWER = {
  type: "object",
  properties: {
    issues: item({
      id: TEXT,
      real: { type: "boolean" },
      severity: { enum: [...SEVERITIES] },
      why: TEXT,
    }),
    refuted: item({ id: TEXT, wrong: { type: "boolean" }, why: TEXT }),
  },
  required: ["issues", "refuted"],
  additionalProperties: false,
} as unknown as OutputSchema<VoteAnswer>;

const NO_KEY = "You didn't answer with a key. Finish the procedure and answer.";
const NO_VOTE = "You didn't answer. Vote on every item and answer.";

/**
 * Changes whenever what the agents are told does, so keys drafted under older instructions can be
 * found and redrafted: the prompt functions' source as Bun prints it, the rubric, and the answer
 * schemas with their descriptions.
 */
export const PROCEDURE = new Bun.CryptoHasher("sha256")
  .update(
    [
      draftPrompt,
      retryPrompt,
      votePrompt,
      NO_KEY,
      NO_VOTE,
      SEVERITY_RUBRIC,
      JSON.stringify([KEY_BODY, VOTE_ANSWER]),
    ]
      .map(String)
      .join("\n"),
  )
  .digest("hex")
  .slice(0, 12);

export type Drafted =
  | { status: "drafted"; key: AnswerKey; votes: Votes; attempts: number }
  | { status: "failed"; detail: string };

const label = (runtime: ExecutionConfig) => `${runtime.harness}/${runtime.model}`;

/**
 * Drafts a fixture's answer key with one agent, and checks each draft in code against the fixture's
 * comments, frozen code and later pushes; a draft that fails goes back to the agent with what is
 * wrong. Then independent graders vote on every judgement code can't check, and the key keeps what
 * most voters agree on. `key/key.json` and `key/evidence/votes.json` are written only at the end.
 */
export async function draftKey(
  workflow: WorkflowContext,
  options: {
    dir: string;
    clone: string;
    drafter: ExecutionConfig;
    graders: readonly ExecutionConfig[];
    attempts: number;
  },
): Promise<Drafted> {
  const { dir, clone, drafter } = options;
  const workspace = mkdtempSync(join(tmpdir(), "awf-draft-key-"));
  const ballot = mkdtempSync(join(tmpdir(), "awf-vote-"));
  try {
    const fixture: Fixture = await Bun.file(join(dir, "fixture.json")).json();
    const gitlab = join(dir, "key", "evidence", "gitlab");
    const mr: GitLabMergeRequest = await Bun.file(join(gitlab, "merge-request.json")).json();
    const versions = orderVersions(
      (await Bun.file(join(gitlab, "versions.json")).json()) as GitLabVersion[],
    );
    const discussions: GitLabDiscussion[] = await Bun.file(join(gitlab, "discussions.json")).json();

    const repo = join(workspace, "repo");
    await openKeyRepo(dir, clone, repo);
    copyFileSync(join(dir, "request.md"), join(workspace, "request.md"));
    await Bun.write(
      join(workspace, "threads.json"),
      JSON.stringify(threads(discussions, versions, mr.author.username), null, 2),
    );

    const agent = await workflow.agents.open({
      key: `key:${fixture.id}`,
      runtime: drafter,
      cwd: workspace,
    });
    const replaced = await Bun.file(join(dir, "key", "key.json"))
      .json()
      .catch(() => undefined);
    const revision = Number.isInteger(replaced?.revision) ? replaced.revision + 1 : 1;
    let prompt = draftPrompt(fixture, versions, mr.author.username);
    let detail = "no attempt made";
    for (let attempt = 1; attempt <= options.attempts; attempt++) {
      const { outcome } = await agent.run({ prompt, schema: KEY_BODY, timeoutMs: 40 * 60_000 });
      if (!isAnswered(outcome)) {
        detail = `no key: ${outcome.kind}: ${outcome.reason}`;
        prompt = NO_KEY;
        continue;
      }
      const draft: AnswerKey = {
        format: KEY_FORMAT,
        fixture: fixture.id,
        revision,
        draftedBy: label(drafter),
        procedure: PROCEDURE,
        ...outcome.value,
      };
      const checked = await verifyKey(dir, draft, repo);
      if (!checked.ok) {
        detail = checked.problems.map((p) => `${p.path}: ${p.message}`).join("; ");
        workflow.log(`${fixture.id}: draft ${attempt} failed its checks: ${detail}`);
        prompt = retryPrompt(checked.problems, outcome.value);
        continue;
      }
      // Graders get what a reviewer gets, the frozen code and the request: no comments, no later
      // pushes, none of the drafter's files.
      await restore({
        bundle: join(dir, "snapshot.bundle"),
        ref: SNAPSHOT_REF,
        clone,
        target: join(ballot, "repo"),
      });
      copyFileSync(join(dir, "request.md"), join(ballot, "request.md"));
      const votes = await vote(workflow, draft, fixture, options.graders, ballot);
      const key = settle(draft, votes);
      const final = await verifyKey(dir, key, repo);
      if (!final.ok)
        throw new Error(`the settled key fails its checks: ${final.problems[0]!.message}`);
      await Bun.write(join(dir, "key", "key.json"), `${JSON.stringify(key, null, 2)}\n`);
      await Bun.write(
        join(dir, "key", "evidence", "votes.json"),
        `${JSON.stringify(votes, null, 2)}\n`,
      );
      return { status: "drafted", key, votes, attempts: attempt };
    }
    return { status: "failed", detail };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(ballot, { recursive: true, force: true });
  }
}

/**
 * The graders decide; the drafter doesn't vote, since it finds its own issues real. Each grader
 * judges every issue and refuted claim from the code alone.
 */
async function vote(
  workflow: WorkflowContext,
  key: AnswerKey,
  fixture: Fixture,
  graders: readonly ExecutionConfig[],
  ballot: string,
): Promise<Votes> {
  const nothing = key.issues.length === 0 && key.refuted.length === 0;
  const voters = graders.map((runtime, index) => `grader${index + 1}:${label(runtime)}`);
  // Every grader finishes before any failure is raised, so none is left running in a directory
  // the caller is about to delete.
  const settled = nothing
    ? []
    : await Promise.allSettled(
        graders.map((runtime, index) =>
          castVotes(workflow, voters[index]!, runtime, fixture, key, ballot),
        ),
      );
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  const answers = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const issues = key.issues.map((issue) => {
    const votes = answers.map(({ by, answer }) => {
      const { real, severity, why } = answer.issues.find((v) => v.id === issue.id)!;
      return { by, real, severity, why };
    });
    return {
      id: issue.id,
      real: majority(votes.map((v) => v.real)),
      severity: settleSeverity(votes.map((v) => v.severity)),
      votes,
    };
  });
  const refuted = key.refuted.map((claim) => {
    const votes = answers.map(({ by, answer }) => {
      const { wrong, why } = answer.refuted.find((v) => v.id === claim.id)!;
      return { by, wrong, why };
    });
    return { id: claim.id, wrong: majority(votes.map((v) => v.wrong)), votes };
  });
  return { format: VOTES_FORMAT, procedure: key.procedure, voters, issues, refuted };
}

/**
 * One grader, in its own session, judges every issue and refuted claim from the code alone. An
 * answer that skips, repeats or invents an item is sent back once; a grader that still can't
 * answer fails the key rather than leave it settled by fewer voters.
 */
async function castVotes(
  workflow: WorkflowContext,
  by: string,
  runtime: ExecutionConfig,
  fixture: Fixture,
  key: AnswerKey,
  ballot: string,
): Promise<{ by: string; answer: VoteAnswer }> {
  const agent = await workflow.agents.open({
    key: `vote:${fixture.id}:${by}`,
    runtime,
    cwd: ballot,
  });
  const asked = { issues: key.issues.map((i) => i.id), refuted: key.refuted.map((r) => r.id) };
  let prompt = votePrompt(fixture, key);
  let detail = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { outcome } = await agent.run({ prompt, schema: VOTE_ANSWER, timeoutMs: 20 * 60_000 });
    if (!isAnswered(outcome)) {
      detail = `${outcome.kind}: ${outcome.reason}`;
      prompt = NO_VOTE;
      continue;
    }
    const problems = ballotProblems(outcome.value, asked);
    if (problems.length === 0) return { by, answer: outcome.value };
    detail = problems.join("; ");
    prompt = `Your answer was incomplete: ${detail}. Answer again with exactly one vote for every item.`;
  }
  throw new Error(`${by} gave no complete vote: ${detail}`);
}

/** What most voters didn't agree on becomes an `unconfirmed` exclusion, so it counts neither way. */
function settle(draft: AnswerKey, votes: Votes): AnswerKey {
  const real = new Set(votes.issues.filter((v) => v.real).map((v) => v.id));
  const severity = new Map(votes.issues.map((v) => [v.id, v.severity]));
  const wrong = new Set(votes.refuted.filter((v) => v.wrong).map((v) => v.id));
  const unsettled = (
    sources: AnswerKey["issues"][number]["sources"],
    claim: string,
    detail: string,
  ) => ({ sources, reason: "unconfirmed" as const, claim, detail });
  return {
    ...draft,
    issues: draft.issues
      .filter((issue) => real.has(issue.id))
      .map((issue) => ({ ...issue, severity: severity.get(issue.id)! })),
    refuted: draft.refuted.filter((claim) => wrong.has(claim.id)),
    excluded: [
      ...draft.excluded,
      ...draft.issues
        .filter((issue) => !real.has(issue.id))
        .map((issue) =>
          unsettled(
            // An `accepted` note may be the only mention of its discussion; it has to stay accounted for.
            issue.confirmation.basis === "accepted"
              ? [...issue.sources, issue.confirmation.note]
              : issue.sources,
            issue.mechanism,
            `drafted as ${issue.id}; most voters didn't find it real`,
          ),
        ),
      ...draft.refuted
        .filter((claim) => !wrong.has(claim.id))
        .map((claim) =>
          unsettled(
            claim.sources,
            claim.claim,
            `drafted as refuted ${claim.id}; most voters didn't find it wrong`,
          ),
        ),
    ],
  };
}

function draftPrompt(
  fixture: Fixture,
  versions: readonly OrderedVersion[],
  author: string,
): string {
  const { snapshot } = fixture;
  return `You are drafting the answer key for a code review test.

The test replays merge request !${fixture.source.number}. A reviewer under test gets the code as it was when review started, plus the MR's title and description, and is scored on which real problems it finds. Your key is the list of those real problems. People and AI reviewers already reviewed this MR, and their comments are your leads. A real problem counts whoever raised it, but a comment is only a claim until you check it.

## Workspace (the current directory)

- \`repo/\`: a git repository. Branch \`review\` is the frozen code: version ${snapshot.version}, head ${snapshot.head}. The change under review is \`${snapshot.base}..review\`. Later pushes are refs \`refs/versions/<n>\`: \`git log review..refs/versions/<n>\` and \`git diff review refs/versions/<n>\` show what changed after review started.
- \`request.md\`: the title and description the reviewer sees.
- \`threads.json\`: every discussion on the MR, notes oldest first, each with the push it was written on (\`onVersion\`). \`mustAccount: true\` marks the discussions your key has to account for. The MR's author is ${author}. \`path\` and \`line\` are where GitLab shows a thread now, which can be a later version: find the code on \`review\` yourself.

Pushes (version ${snapshot.version} is frozen):
${versions.map((v) => `- version ${v.ordinal}: ${v.created_at}, head ${v.head_commit_sha}, base ${v.base_commit_sha}`).join("\n")}

## Procedure

1. Read \`request.md\` and the change: \`git -C repo diff ${snapshot.base} review\`.
2. Go through every thread with \`mustAccount\`. A note often makes several points: treat each point as its own claim. For each claim decide which of these it is:
   - **An issue**: a real problem in the frozen code. Check it in the code on \`review\`; don't take the comment's word for it. Cite in \`sources\` the notes that actually make the claim.
     Make it an issue only if you can point at the lines and say what input or situation goes wrong, or what it costs. Otherwise it is \`unconfirmed\`.
   - **Refuted**: the claim is wrong. \`false-premise\`: the code doesn't do what the claim says. \`not-a-defect\`: the behaviour it describes is intended or harmless. \`claim\` restates in one sentence what the comment asserted; \`why\` says why it's wrong.
   - **Excluded**: \`not-in-snapshot\` when the defect itself only appeared in a later push (a note whose \`onVersion\` is after the frozen version often names later code: check whether the underlying behaviour already exists on \`review\`, even if the lines it names don't; if it does, it's an issue); \`not-a-claim\` for praise, summaries, status updates, CI output, and questions that only asked for an explanation; \`preference\` for taste in style or naming only (a name that misstates what the code does is an issue, and a concern about behaviour or rollout is an issue or a refuted claim, never a preference); \`unconfirmed\` when you could not settle it either way. Every exclusion has a \`claim\`: what the note asserted, in one sentence (for a note that asserted nothing, what it was, like "praise for the tests"). \`detail\` adds why, when that isn't obvious.
3. Walk the later pushes too. For each version n after the frozen one, \`git -C repo log -p --no-merges --cherry-pick --right-only <previous>...refs/versions/<n> ^<base of n>\` shows the commits that push added (\`<previous>\` is \`review\` for the first, then the version before). Every commit that fixes a problem present in the frozen code is a lead, whether or not a comment asked for it; a problem only a commit shows gets that commit as its source, \`{commit}\`. A fixing commit often addresses several distinct problems: list each.
4. One issue is what a single fix resolves. Claims about the same defect, from any number of notes, are one issue that lists every note in \`sources\`; one note naming two defects that need separate fixes gives two issues. One note can appear in the sources of several items.
5. For each issue:
   - \`mechanism\`: what goes wrong, when, and what it causes, in one to three sentences. Describe the problem, never the fix, even if the comment gave the fix. Someone must be able to tell whether a differently worded finding is the same problem.
   - \`confirmation\`: \`fixed\` when a later push changed the code to deal with it; give that version and the commit it added that did it (from the log in step 3). \`accepted\` when the author agreed in a note but didn't fix it here, including deferring it to a follow-up; cite their note. \`verified\` otherwise; you traced it in the frozen code, and \`how\` says how in a sentence.
   - \`severity\`, by the rubric below. Independent graders then judge every issue and refuted claim from the code; the key keeps what most of them agree on, with their median severity.
   - \`category\`: \`correctness\` (logic, edge cases, concurrency, data, API contracts, resources), \`security\`, \`performance\`, \`tests\` (missing or wrong tests), \`design\` (wrong abstraction, coupling, poor fit with the rest of the code), \`maintainability\` (code that is needed but harder to change than it should be: complexity, duplication), \`docs-style\` (naming, formatting, comments, docs), \`slop\` (code or text that shouldn't exist at all: dead or unneeded code, abstractions nobody asked for, comments that restate the code, defensive checks for things that can't happen).
   - \`scope\`: \`change\` if this MR caused it or made it worse; \`context\` if it was already there, unchanged in effect, in code the MR didn't cause.
   - \`visibleIn\`: what a reviewer has to read to see it: \`diff\`, the rest of a changed \`file\`, or other files in the \`repo\`.
   - \`locations\`: paths and line ranges in the frozen code (branch \`review\`), counted from 1, where the problem is. Empty only when the problem is something missing and no line points at it.
6. Number issues K1, K2, … and refuted claims R1, R2, …. A comment source is a \`{discussion, note}\` pair from \`threads.json\`. Every \`mustAccount\` discussion must appear in the sources of at least one issue, refuted claim or exclusion.

## Severity

${SEVERITY_RUBRIC}

Don't change anything in \`repo/\` beyond reading it, and don't write outside this directory.

Answer with the key as JSON. It is long, so write it to a file and pipe that file to the answer command on standard input.`;
}

function votePrompt(fixture: Fixture, key: AnswerKey): string {
  const issues = key.issues.map(({ id, mechanism, category, scope, locations }) => ({
    id,
    mechanism,
    category,
    scope,
    locations,
  }));
  const refuted = key.refuted.map(({ id, claim }) => ({ id, claim }));
  return `You are checking another reviewer's conclusions about merge request !${fixture.source.number}. Branch \`review\` of \`repo/\` is the code as it was reviewed; \`request.md\` says what the MR is for. Don't trust the conclusions: read the code each item points at and judge it yourself.

For each issue:
- \`real\`: is this a real problem in this code, as described? false if the code doesn't behave that way, if the behaviour is intended and harmless, or if it is only a matter of taste. A false must name the code fact that shows it, with file and line.
- \`severity\`: by the rubric below, as if it were real.
- \`why\`: one sentence. For a \`must-fix\`, the realistic input or state that causes harm after merge; otherwise the reason for your call.

For each refuted claim:
- \`wrong\`: is the claim wrong about this code? Name the code fact, with file and line, either way.
- \`why\`: one sentence.

${SEVERITY_RUBRIC}

Issues:
${JSON.stringify(issues, null, 2)}

Refuted claims:
${JSON.stringify(refuted, null, 2)}

Answer every item by its \`id\`. Don't change anything in \`repo/\`.`;
}

function retryPrompt(problems: readonly Problem[], previous: KeyBody): string {
  return [
    "Your key was checked against the fixture and failed:",
    ...problems.map((p) => `- ${p.path}: ${p.message}`),
    "",
    "Fix these, check the code again where they point, and answer with the whole corrected key.",
    "Your previous answer was:",
    JSON.stringify(previous),
  ].join("\n");
}
