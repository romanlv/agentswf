// bun packages/autoresearch/src/write-schemas.ts — regenerates schema/*.schema.json from format.ts.
import { join } from "node:path";
import { renderSchemaFile, SCHEMA_FILES } from "./review/format/schema-files";

const SCHEMA_DIR = join(import.meta.dir, "..", "schema");

for (const name of Object.keys(SCHEMA_FILES) as (keyof typeof SCHEMA_FILES)[]) {
  await Bun.write(join(SCHEMA_DIR, name), renderSchemaFile(name));
  console.log(`wrote schema/${name}`);
}
