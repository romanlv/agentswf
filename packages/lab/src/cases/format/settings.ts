import Type from "typebox";
import { AgentSchema } from "../../shared/config";

// The files a person writes and commits: `dataset.json` and a case's `key.md`. They start at `/0`;
// their next incompatible change makes them `/1`, with a converter in the lab.

export const DATASET_KIND = "awf.case-dataset/0";
export const KEY_KIND = "awf.case-key/0";

const Text = Type.String({ minLength: 1 });

const DURATION_PATTERN = "^[1-9][0-9]*(ms|s|m|h)$";
const PASS_PATTERN = "^(all|[1-9][0-9]*/[1-9][0-9]*)$";

/** `"30m"`, `"90s"`, `"2h"`: a duration as `awf run --timeout` takes it. */
export const DurationSchema = Type.String({ pattern: DURATION_PATTERN });

/** `"all"`, or a fraction of a case's trials that must pass, such as `"2/3"`. */
export const PassSchema = Type.String({
  pattern: PASS_PATTERN,
  description: '"all", or the fraction of trials that must pass, such as "2/3".',
});

export { type Agent, AgentSchema } from "../../shared/config";

/** A domain as a sandbox spec names it: `example.com`, or `*.example.com` for its subdomains. */
const DomainSchema = Type.String({ pattern: "^(\\*\\.)?[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*$" });

export const AgentReachSchema = Type.Object(
  {
    network: Type.Array(DomainSchema, {
      description: "Domains the workflow's agents may reach, beyond their model domains.",
    }),
    webSearch: Type.Optional(Type.Boolean({ description: "false when absent." })),
    sockets: Type.Optional(
      Type.Boolean({ description: "Whether a sandbox may hold sockets; false when absent." }),
    ),
  },
  { additionalProperties: false },
);

export type AgentReach = Type.Static<typeof AgentReachSchema>;

export const DatasetSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    kind: Type.Literal(DATASET_KIND),
    sandbox: Type.Union(
      [
        Type.Literal("workflow", {
          description: "Trust the sandboxes the workflow opens itself.",
        }),
        Type.Object(
          { lab: Type.Literal("srt") },
          {
            additionalProperties: false,
            description:
              "The lab's box: the whole trial (awf run, env.ts, the workflow and its agents) in one srt sandbox that reads no key, the workflow's own sandboxes set aside.",
          },
        ),
      ],
      { description: "Where a trial runs: the workflow's own sandboxes, or the lab's box." },
    ),
    agentReach: AgentReachSchema,
    timeout: Type.Optional({
      ...DurationSchema,
      description: 'The limit of a trial\'s workflow body; "30m" when absent.',
    }),
    setupTimeout: Type.Optional({
      ...DurationSchema,
      description: 'The limit of setup, and again of observe with teardown; "10m" when absent.',
    }),
    realHosts: Type.Optional(
      Type.Array(Text, {
        description: "Hosts the workflow's own code may reach for real, beyond the engine's.",
      }),
    ),
    pass: Type.Optional(PassSchema),
    holdout: Type.Optional(
      Type.Array(Text, {
        uniqueItems: true,
        description:
          "Cases set aside for a final check: run, --failed and history leave them out, run --holdout runs them alone, and a loop's proposer never sees them.",
      }),
    ),
    reuseDays: Type.Optional(
      Type.Integer({
        minimum: 0,
        description:
          "How many days a stored trial may stand in for a new one when nothing that shaped it changed; 14 when absent, 0 never.",
      }),
    ),
    keep: Type.Optional(
      Type.Array(Text, { description: "Paths saved from the scratch folder after a trial." }),
    ),
    graders: Type.Optional(
      Type.Array(
        Type.Union([
          Text,
          Type.Object(
            { grader: Text, onDemand: Type.Optional(Type.Boolean()) },
            { additionalProperties: false },
          ),
          Type.Object(
            {
              workflow: Type.String({
                pattern: "^graders/.+\\.ts$",
                description: "A grader workflow in the dataset's graders/ folder.",
              }),
              readsFacts: Type.Optional(Type.Boolean()),
              onDemand: Type.Optional(
                Type.Boolean({
                  description: "Run only by score --grader; never decides a verdict.",
                }),
              ),
              timeout: Type.Optional({
                ...DurationSchema,
                description: "Its run's limit; the dataset's timeout when absent.",
              }),
            },
            { additionalProperties: false },
          ),
        ]),
        { description: "The dataset's own graders; exempt from /0 for now." },
      ),
    ),
    judgeAgent: Type.Optional(AgentSchema),
  },
  { additionalProperties: false, description: "A dataset of cases for one workflow." },
);

export type Dataset = Type.Static<typeof DatasetSchema>;

/** A fact's value: flat, so a key compares it exactly. */
export const FactSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
export type Fact = Type.Static<typeof FactSchema>;

const Criterion = Type.String({ minLength: 1 });
const MARKER_PATTERN = "^[a-z]+(-[a-z]+){2,}$";
const TAG_PATTERN = "^[a-z0-9][a-z0-9-]*$";
const FACT_NAME_PATTERN = "^[A-Za-z][A-Za-z0-9_]*$";

export const KeySchema = Type.Object(
  {
    kind: Type.Literal(KEY_KIND),
    marker: Type.String({ pattern: MARKER_PATTERN }),
    expect: Type.Optional(Type.Record(Type.String({ pattern: FACT_NAME_PATTERN }), FactSchema)),
    must: Type.Optional(Type.Array(Criterion, { minItems: 1 })),
    "must-not": Type.Optional(Type.Array(Criterion, { minItems: 1 })),
    "known-failing": Type.Optional(Type.Literal(true)),
    pass: Type.Optional(PassSchema),
    draft: Type.Optional(Type.Literal(true)),
    tags: Type.Optional(
      Type.Array(Type.String({ pattern: TAG_PATTERN }), {
        minItems: 1,
        uniqueItems: true,
        description:
          "Plain words the report groups cases by, and --tags picks them by; no grader reads them.",
      }),
    ),
    captured: Type.Optional(
      Type.Object(
        {
          run: Text,
          mark: Type.Union([Type.Literal("good"), Type.Literal("needs-work")]),
          note: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false, description: "What a good result looks like for one case." },
);

export type Key = Type.Static<typeof KeySchema>;

/** Why a `pass` that reads as a fraction is no share of trials: more than all of them. */
export function passProblem(pass: string | undefined): string | undefined {
  const [n, d] = (pass ?? "all").split("/").map(Number);
  return d !== undefined && n! > d
    ? `pass ${pass} is more than all: give all, or a fraction up to 1, such as 2/3`
    : undefined;
}

/** What each pattern of these files means, for a refusal to say in words. */
export const SETTINGS_PATTERNS: Readonly<Record<string, string>> = {
  [DURATION_PATTERN]: "a number and a unit, such as 30m or 90s",
  [PASS_PATTERN]: "all, or the share of trials that must pass, such as 2/3",
  [MARKER_PATTERN]: "three or more lowercase words joined by hyphens",
  [TAG_PATTERN]: "lowercase letters, digits and hyphens",
  [FACT_NAME_PATTERN]: "a letter, then letters, digits or _",
};
