import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kindOf } from "./cli";

const top = mkdtempSync(join(tmpdir(), "awf-lab-kind-"));
afterAll(() => rmSync(top, { recursive: true, force: true }));

function folder(name: string, config?: object): string {
  const dir = join(top, name);
  mkdirSync(dir, { recursive: true });
  if (config) writeFileSync(join(dir, "awf-lab.json"), JSON.stringify(config));
  return dir;
}

describe("kindOf", () => {
  test("case and runs are the case kind's", () => {
    const review = folder("review", { datasets: "datasets" });
    expect(kindOf(["case", "new", "a/b"], review)).toBe("cases");
    expect(kindOf(["runs"], review)).toBe("cases");
  });

  test("a workspace naming review datasets goes to the review kind, as before", () => {
    const review = folder("review2", { datasets: "datasets", dataset: "x" });
    expect(kindOf(["run", "nop"], review)).toBe("review");
    expect(kindOf(["--scorer", "case", "report", "nop"], review)).toBe("review");
  });

  test("--dataset naming a folder of cases goes to the case kind, in any workspace", () => {
    const mixed = folder("mixed", { kind: "awf.lab-workspace/0", datasets: "datasets" });
    mkdirSync(join(mixed, "mail"));
    writeFileSync(
      join(mixed, "mail", "dataset.json"),
      JSON.stringify({ kind: "awf.case-dataset/0" }),
    );
    expect(kindOf(["run", "--dataset", "mail"], mixed)).toBe("cases");
    expect(kindOf(["run", "--dataset", "reviews"], mixed)).toBe("review");
  });

  test("without review datasets, or without a workspace, the case kind", () => {
    expect(kindOf(["run"], folder("cases", { kind: "awf.lab-workspace/0" }))).toBe("cases");
    const project = folder("project");
    folder("project/evals", { kind: "awf.lab-workspace/0" });
    expect(kindOf(["report"], project)).toBe("cases");
  });

  test("an awf-lab.json only in evals/ is the case kind's, whatever it holds, as only that kind looks there", () => {
    const project = folder("evals-review");
    folder("evals-review/evals", { kind: "awf.lab-workspace/0", datasets: "datasets" });
    expect(kindOf(["run"], project)).toBe("cases");
    const sub = folder("evals-review/app");
    expect(kindOf(["run"], sub)).toBe("cases");
  });
});
