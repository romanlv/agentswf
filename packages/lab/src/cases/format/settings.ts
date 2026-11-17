import Type from "typebox";
import { AgentSchema } from "../../shared/config";

// The files a person writes and commits: `dataset.json` and a case's `key.md`. They start at `/0`;
// their next incompatible change makes them `/1`, with a converter in the lab.

export const DATASET_KIND = "awf.case-dataset/0";
export const KEY_KIND = "awf.case-key/0";

const Text = Type.String({ minLength: 1 });

/** `"30m"`, `"90s"`, `"2h"`: a duration as `awf run --timeout` takes it. */
export const DurationSchema = Type.String({ pattern: "^[1-9][0-9]*(ms|s|m|h)$" });

/** `"all"`, or a fraction of a case's trials that must pass, such as `"2/3"`. */
export const PassSchema = Type.String({
  pattern: "^(all|[1-9][0-9]*/[1-9][0-9]*)$",
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
    sandbox: Type.Literal("workflow", {
      description: "Trust the sandboxes the workflow opens itself: the one setting in /0.",
    }),
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

export const KeySchema = Type.Object(
  {
    kind: Type.Literal(KEY_KIND),
    marker: Type.String({ pattern: "^[a-z]+(-[a-z]+){2,}$" }),
    expect: Type.Optional(
      Type.Record(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]*$" }), FactSchema),
    ),
    must: Type.Optional(Type.Array(Criterion, { minItems: 1 })),
    "must-not": Type.Optional(Type.Array(Criterion, { minItems: 1 })),
    "known-failing": Type.Optional(Type.Literal(true)),
    pass: Type.Optional(PassSchema),
    draft: Type.Optional(Type.Literal(true)),
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
