// bun packages/lab/src/write-schemas.ts — regenerates schema/*.schema.json from both kinds' formats.
import { join } from "node:path";
import { CASE_SCHEMA_FILES, renderCaseSchemaFile } from "./cases/format/schema-files";
import { renderSchemaFile, SCHEMA_FILES } from "./review/format/schema-files";

const SCHEMA_DIR = join(import.meta.dir, "..", "schema");

for (const name of Object.keys(SCHEMA_FILES) as (keyof typeof SCHEMA_FILES)[]) {
  await Bun.write(join(SCHEMA_DIR, name), renderSchemaFile(name));
  console.log(`wrote schema/${name}`);
}
for (const name of Object.keys(CASE_SCHEMA_FILES) as (keyof typeof CASE_SCHEMA_FILES)[]) {
  await Bun.write(join(SCHEMA_DIR, name), renderCaseSchemaFile(name));
  console.log(`wrote schema/${name}`);
}
