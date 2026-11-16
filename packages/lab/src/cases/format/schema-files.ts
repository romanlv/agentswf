import { RunRecordSchema, ScoreRecordSchema, TrialRecordSchema } from "./records";
import { DatasetSchema, KeySchema } from "./settings";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

/** The case kind's published JSON Schemas, by file name under `packages/lab/schema/`. */
export const CASE_SCHEMA_FILES = {
  "case-dataset.schema.json": { title: "awf-lab dataset of cases", schema: DatasetSchema },
  "case-key.schema.json": { title: "awf-lab case key, its frontmatter", schema: KeySchema },
  "case-run.schema.json": { title: "awf-lab run of cases", schema: RunRecordSchema },
  "case-trial.schema.json": { title: "awf-lab case trial", schema: TrialRecordSchema },
  "case-score.schema.json": { title: "awf-lab case score", schema: ScoreRecordSchema },
} as const;

export type CaseSchemaName = keyof typeof CASE_SCHEMA_FILES;

export function renderCaseSchemaFile(name: CaseSchemaName): string {
  const { title, schema } = CASE_SCHEMA_FILES[name];
  return `${JSON.stringify({ $schema: DRAFT, title, ...schema }, null, 2)}\n`;
}
