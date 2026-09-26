import {
  AnswerKeySchema,
  CollectRecordSchema,
  FixtureSchema,
  FixtureSetSchema,
  VotesSchema,
} from "./format";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

/** The published JSON Schemas, by file name under `packages/autoresearch/schema/`. */
export const SCHEMA_FILES = {
  "review-fixture.schema.json": { title: "awf review fixture", schema: FixtureSchema },
  "review-key.schema.json": { title: "awf review answer key", schema: AnswerKeySchema },
  "fixture-set.schema.json": { title: "awf fixture set", schema: FixtureSetSchema },
  "collect-record.schema.json": { title: "awf collect record", schema: CollectRecordSchema },
  "key-votes.schema.json": { title: "awf key votes", schema: VotesSchema },
} as const;

export function renderSchemaFile(name: keyof typeof SCHEMA_FILES): string {
  const { title, schema } = SCHEMA_FILES[name];
  return `${JSON.stringify({ $schema: DRAFT, title, ...schema }, null, 2)}\n`;
}
