import Type from "typebox";

// `awf-lab.json`: a workspace of datasets of cases.

export const CONFIG_FILE = "awf-lab.json";
export const WORKSPACE_KIND = "awf.lab-workspace/1";

const Text = Type.String({ minLength: 1 });

export const AgentSchema = Type.Object(
  {
    harness: Text,
    model: Text,
    /** The criteria judge's voters per criterion, odd: 3 when absent. */
    voters: Type.Optional(Type.Integer({ minimum: 1, maximum: 9, multipleOf: 1 })),
  },
  { additionalProperties: false },
);
export type Agent = Type.Static<typeof AgentSchema>;

const FIELDS = {
  kind: Type.Literal(WORKSPACE_KIND),
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
  hide: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      uniqueItems: true,
      description:
        "Paths in the code folder, relative to it, the lab's box hides as it hides keys: tracked files that hold or quote a key, such as an older lab's fixtures.",
    }),
  ),
};

export const WorkspaceSchema = Type.Object(
  { $schema: Type.Optional(Type.String()), ...FIELDS },
  { additionalProperties: false },
);
export type WorkspaceConfig = Type.Static<typeof WorkspaceSchema>;

/** The older lab's fields, retired with it, each with where it went, or null when nowhere. */
export const RETIRED_FIELDS: Readonly<Record<string, string | null>> = {
  clone: "a case's own files, built by env.ts",
  datasets: "a folder of evals/ per dataset, holding dataset.json",
  dataset: "--dataset",
  results: "the store, and records",
  runs: "the store",
  variants: "--param or --vary, read by env.ts",
  scorers: "dataset.json's graders",
  scorer: "dataset.json's graders",
  comparisons: "compare in the dataset's graders.ts",
  comparison: "compare in the dataset's graders.ts",
  trials: "--trials",
  baseline: "the reference column",
  budget: "--budget",
  sandbox: "dataset.json's sandbox",
  seed: null,
  holdout: "dataset.json's holdout",
};
