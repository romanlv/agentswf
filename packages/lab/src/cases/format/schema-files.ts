import { WorkspaceSchema } from "../../shared/config";
import { FinalSchema, LoopSchema, ProposalSchema, TrySchema } from "./loop";
import { CaseReportSchema, ScoredSchema } from "./output";
import {
  GradeFileSchema,
  LabelRecordSchema,
  PreviousSchema,
  RunRecordSchema,
  ScoreRecordSchema,
  TrialRecordSchema,
} from "./records";
import { DatasetSchema, KeySchema } from "./settings";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

/** The case kind's published JSON Schemas, by file name under `packages/lab/schema/`. */
export const CASE_SCHEMA_FILES = {
  "awf-lab.schema.json": { title: "awf-lab workspace", schema: WorkspaceSchema },
  "case-dataset.schema.json": { title: "awf-lab dataset of cases", schema: DatasetSchema },
  "case-key.schema.json": { title: "awf-lab case key, its frontmatter", schema: KeySchema },
  "case-run.schema.json": { title: "awf-lab run of cases", schema: RunRecordSchema },
  "case-trial.schema.json": { title: "awf-lab case trial", schema: TrialRecordSchema },
  "case-score.schema.json": { title: "awf-lab case score", schema: ScoreRecordSchema },
  "case-grade.schema.json": { title: "awf-lab grade folder's grade.json", schema: GradeFileSchema },
  "case-previous.schema.json": {
    title: "awf-lab grade folder's previous.json",
    schema: PreviousSchema,
  },
  "case-report.schema.json": { title: "awf-lab report --json", schema: CaseReportSchema },
  "case-scored.schema.json": { title: "awf-lab score --json", schema: ScoredSchema },
  "case-label.schema.json": { title: "awf-lab label", schema: LabelRecordSchema },
  "case-loop.schema.json": { title: "awf-lab loop's loop.json", schema: LoopSchema },
  "case-try.schema.json": { title: "awf-lab loop's try.json", schema: TrySchema },
  "case-proposal.schema.json": { title: "awf-lab loop's proposal.json", schema: ProposalSchema },
  "case-final.schema.json": { title: "awf-lab loop's final check", schema: FinalSchema },
} as const;

export type CaseSchemaName = keyof typeof CASE_SCHEMA_FILES;

export function renderCaseSchemaFile(name: CaseSchemaName): string {
  const { title, schema } = CASE_SCHEMA_FILES[name];
  return `${JSON.stringify({ $schema: DRAFT, title, ...schema }, null, 2)}\n`;
}
