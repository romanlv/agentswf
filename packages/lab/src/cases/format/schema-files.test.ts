import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CASE_SCHEMA_FILES, type CaseSchemaName, renderCaseSchemaFile } from "./schema-files";

describe("case schema files", () => {
  test("match the formats; regenerate with bun packages/lab/src/write-schemas.ts", () => {
    for (const name of Object.keys(CASE_SCHEMA_FILES) as CaseSchemaName[]) {
      const file = join(import.meta.dir, "../../../schema", name);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(
        JSON.parse(renderCaseSchemaFile(name)),
      );
    }
  });
});
