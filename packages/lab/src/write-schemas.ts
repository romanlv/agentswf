// bun packages/lab/src/write-schemas.ts — regenerates schema/*.schema.json from the formats.
import { join } from "node:path";
import { CASE_SCHEMA_FILES, renderCaseSchemaFile } from "./cases/format/schema-files";

const SCHEMA_DIR = join(import.meta.dir, "..", "schema");

for (const name of Object.keys(CASE_SCHEMA_FILES) as (keyof typeof CASE_SCHEMA_FILES)[]) {
  await Bun.write(join(SCHEMA_DIR, name), renderCaseSchemaFile(name));
  console.log(`wrote schema/${name}`);
}
