import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, WORKSPACE_KIND } from "../../shared/config";
import { DATASET_KIND, KEY_KIND } from "../format/settings";
import { DATASET_FILE, discoverDatasets, ENV_FILE, KEY_FILE, STUB_LINE } from "./dataset";
import STUB_BODY from "./env-stub.txt" with { type: "text" };
import { newMarker } from "./marker";
import { Refusal } from "./refusal";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const key = (marker: string) => `---
kind: ${KEY_KIND}
marker: ${marker}
# expect:
#   done: true
# must:
#   - a sentence a good result makes true
# must-not:
#   - a sentence a good result never makes true
---

Why this case exists.
`;

export type Made = { written: string[]; caseDir: string };

/**
 * `case new {dataset}/{case}`: the case folder and its key's marker; the first time, also
 * `awf-lab.json`, the dataset's `dataset.json`, reaching nothing outside, and a stub `env.ts`.
 */
export function newCase(evals: string, address: string): Made {
  const parts = address.split("/");
  let datasetName: string;
  let caseName: string;
  if (parts.length === 2) [datasetName, caseName] = parts as [string, string];
  else if (parts.length === 1) {
    const found = discoverDatasets(evals);
    if (found.length !== 1) {
      throw new Refusal(
        found.length === 0
          ? "case new takes {dataset}/{case} for the first case of a dataset"
          : `more than one dataset: case new takes {dataset}/{case} (${found.map((d) => d.name).join(", ")})`,
      );
    }
    datasetName = found[0]!.name;
    caseName = parts[0]!;
  } else throw new Refusal(`case new takes {dataset}/{case}, not ${address}`);
  for (const name of [datasetName, caseName]) {
    if (!NAME.test(name)) {
      throw new Refusal(
        `${name} is not a name: letters, digits, '.', '_' and '-', starting with a letter or digit`,
      );
    }
  }
  const datasetDir = join(evals, datasetName);
  const caseDir = join(datasetDir, "cases", caseName);
  if (existsSync(caseDir))
    throw new Refusal(`case ${datasetName}/${caseName} is already there: ${caseDir}`);
  const written: string[] = [];
  const write = (file: string, text: string) => {
    writeFileSync(file, text, { flag: "wx" });
    written.push(file);
  };
  mkdirSync(evals, { recursive: true });
  const config = join(evals, CONFIG_FILE);
  if (!existsSync(config)) write(config, `${JSON.stringify({ kind: WORKSPACE_KIND }, null, 2)}\n`);
  mkdirSync(datasetDir, { recursive: true });
  const datasetFile = join(datasetDir, DATASET_FILE);
  if (!existsSync(datasetFile)) {
    write(
      datasetFile,
      `${JSON.stringify({ kind: DATASET_KIND, sandbox: "workflow", agentReach: { network: [] } }, null, 2)}\n`,
    );
  }
  const envFile = join(datasetDir, ENV_FILE);
  if (!existsSync(envFile)) write(envFile, `${STUB_LINE} ${STUB_BODY}`);
  mkdirSync(join(caseDir, "files"), { recursive: true });
  write(join(caseDir, KEY_FILE), key(newMarker()));
  return { written, caseDir };
}
