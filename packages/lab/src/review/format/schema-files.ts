import {
  AnswerKeySchema,
  CollectRecordSchema,
  FixtureSchema,
  FixtureSetSchema,
  VotesSchema,
} from "./format";
import { ListSchema, ReportSchema, RunSchema, SchemasSchema, ShowSchema } from "./output";
import { PartialRecordSchema } from "./partial";
import { PartialScoreSchema, ScoreSchema, TrialSchema } from "./records";
import { FindingsRecordSchema, ScoreRecordSchema, ScorerResultSchema } from "./scoring";
import { WorkspaceConfigSchema } from "./workspace";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

/** The published JSON Schemas, by file name under `packages/lab/schema/`. */
export const SCHEMA_FILES = {
  "review-fixture.schema.json": { title: "awf review fixture", schema: FixtureSchema },
  "review-key.schema.json": { title: "awf review answer key", schema: AnswerKeySchema },
  "fixture-set.schema.json": { title: "awf fixture set", schema: FixtureSetSchema },
  "collect-record.schema.json": { title: "awf collect record", schema: CollectRecordSchema },
  "key-votes.schema.json": { title: "awf key votes", schema: VotesSchema },
  "review-findings.schema.json": { title: "awf-lab trial", schema: TrialSchema },
  "review-findings.v1.schema.json": {
    title: "awf-lab trial, first version",
    schema: FindingsRecordSchema,
  },
  "review-judgement.schema.json": { title: "awf review judgement", schema: ScorerResultSchema },
  "review-score.schema.json": { title: "awf-lab score", schema: ScoreSchema },
  "review-score.v1.schema.json": {
    title: "awf-lab score, first version",
    schema: ScoreRecordSchema,
  },
  "review-partial.schema.json": { title: "awf-lab partial score", schema: PartialScoreSchema },
  "review-partial.v1.schema.json": {
    title: "awf-lab partial score, first version",
    schema: PartialRecordSchema,
  },
  "awf-lab.schema.json": { title: "awf-lab workspace", schema: WorkspaceConfigSchema },
  "lab-list.schema.json": { title: "awf-lab list", schema: ListSchema },
  "lab-run.schema.json": { title: "awf-lab run and score", schema: RunSchema },
  "lab-report.schema.json": { title: "awf-lab report", schema: ReportSchema },
  "lab-show.schema.json": { title: "awf-lab show", schema: ShowSchema },
  "lab-schemas.schema.json": { title: "awf-lab schema", schema: SchemasSchema },
} as const;

export type SchemaName = keyof typeof SCHEMA_FILES;

/** The format id a schema's documents carry, when it has one. */
export function formatOf(name: SchemaName): string | undefined {
  const properties = (SCHEMA_FILES[name].schema as { properties?: Record<string, unknown> })
    .properties;
  const format = properties?.format as { const?: unknown } | undefined;
  return typeof format?.const === "string" ? format.const : undefined;
}

export function renderSchemaFile(name: SchemaName): string {
  const { title, schema } = SCHEMA_FILES[name];
  return `${JSON.stringify({ $schema: DRAFT, title, ...schema }, null, 2)}\n`;
}
