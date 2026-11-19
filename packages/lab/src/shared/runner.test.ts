import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awfRunEstimate } from "./runner";

const dir = mkdtempSync(join(tmpdir(), "awf-lab-runner-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An `awf` that prints this for `awf runs {ref} --json`, and exits so. */
function fakeAwf(name: string, printed: unknown, exitCode = 0) {
  const bin = join(dir, `${name}.ts`);
  writeFileSync(
    bin,
    `console.log(${JSON.stringify(typeof printed === "string" ? printed : JSON.stringify(printed))});\nprocess.exit(${exitCode});\n`,
  );
  return { bin, dir };
}

describe("a run's estimate read from its folder", () => {
  test("the estimate `awf runs --json` prints", async () => {
    const awf = fakeAwf("priced", { v: 2, run: { estimate: 0.25 } });
    expect(await awfRunEstimate(awf, dir, "w/r")).toBe(0.25);
  });

  test("a run with no estimate, or a folder awf can't read, is unpriced", async () => {
    expect(
      await awfRunEstimate(fakeAwf("unpriced", { v: 2, run: {} }), dir, "w/r"),
    ).toBeUndefined();
    expect(await awfRunEstimate(fakeAwf("refused", "{}", 1), dir, "w/r")).toBeUndefined();
    expect(await awfRunEstimate(fakeAwf("garbled", "not json"), dir, "w/r")).toBeUndefined();
  });

  test("a page of another version is refused loudly, never read as no spend", async () => {
    const awf = fakeAwf("newer", { v: 3, run: { estimate: 0.25 } });
    await expect(awfRunEstimate(awf, dir, "w/r")).rejects.toThrow(
      "awf runs w/r --json printed version 3; this lab reads version 2",
    );
  });
});
