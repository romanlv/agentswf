import Type from "typebox";

// `awf-lab.json`'s fields both kinds read. The review kind's own fields are its to check, when a
// review dataset is used; the case kind ignores them.

export const CONFIG_FILE = "awf-lab.json";
export const WORKSPACE_KIND = "awf.lab-workspace/0";

const Text = Type.String({ minLength: 1 });

export const AgentSchema = Type.Object(
  { harness: Text, model: Text },
  { additionalProperties: false },
);
export type Agent = Type.Static<typeof AgentSchema>;

/** The common fields, as properties, so the review kind's schema can hold them too. */
export const COMMON_FIELDS = {
  kind: Type.Optional(
    Type.Literal(WORKSPACE_KIND, {
      description: "Optional until a dataset of cases is used, which needs it.",
    }),
  ),
  judgeAgent: Type.Optional({
    ...AgentSchema,
    description: "The criteria judge's harness and model; a dataset.json may give its own.",
  }),
  store: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Where runs of cases are kept, in place of ~/.awf/lab/{project}-{first commit}; never inside the repository.",
    }),
  ),
  records: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "A folder inside evals/ the run, trial and score records are also written to, to be committed, so a fresh clone sees them.",
    }),
  ),
};

/** What the case kind reads; any other field is the review kind's. */
export const CommonConfigSchema = Type.Object(
  { $schema: Type.Optional(Type.String()), ...COMMON_FIELDS },
  { additionalProperties: true },
);
export type CommonConfig = Type.Static<typeof CommonConfigSchema>;
