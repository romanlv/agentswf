import Type from "typebox";

/** `awf-lab.json` at the workspace's root. Relative paths resolve from the file. */

const Text = Type.String({ minLength: 1 });

export const WorkspaceConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    clone: Type.String({
      minLength: 1,
      description: "The project's main-branch clone that case snapshots restore from.",
    }),
    datasets: Type.String({ minLength: 1, description: "The folder holding datasets." }),
    dataset: Type.String({
      minLength: 1,
      description: "The dataset a command uses unless --dataset names one.",
    }),
    results: Type.String({
      minLength: 1,
      description: "Where trials and scores go: {results}/{dataset}/…",
    }),
    runs: Type.String({
      minLength: 1,
      description: "Where awf run keeps run directories; not committed, records never need them.",
    }),
    variants: Type.Array(Text, {
      description: "Globs of *.variant.ts files; a variant is named by its file's stem.",
    }),
    scorers: Type.Array(Text, {
      description: "Globs of *.scorer.ts files; `panel`, the package's own, is always there.",
    }),
    scorer: Type.String({
      minLength: 1,
      description: "The scorer a command uses unless --scorer names one.",
    }),
    baseline: Type.Optional(
      Type.String({
        minLength: 1,
        description: "The variant a report compares against unless --baseline names one.",
      }),
    ),
    budget: Type.Optional(
      Type.Object(
        {
          usd: Type.Number({
            minimum: 0,
            description: "Priced at list prices, as a run's accounting estimates it.",
          }),
        },
        { additionalProperties: false },
      ),
    ),
    seed: Type.Optional(
      Type.String({ minLength: 1, description: "Orders cases for --cases {n}; awf-lab." }),
    ),
  },
  { additionalProperties: false, description: "An awf-lab workspace, in its second form." },
);

/** The first form's keys, each refused by name with the key that replaced it. */
export const RENAMED_CONFIG_KEYS: Readonly<Record<string, string>> = {
  sets: "datasets",
  set: "dataset",
  scores: "results",
  judges: "scorers",
  judge: "scorer",
};

export type WorkspaceConfig = Type.Static<typeof WorkspaceConfigSchema>;
