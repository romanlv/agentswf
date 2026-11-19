import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { LABEL_KIND, type Mark as LabelMark } from "../format/records";
import {
  CAPTURE_FILE,
  capturedKey,
  checkCaptured,
  findRealRun,
  findTrial,
  freeName,
  type Mark,
  readRealRun,
  writeCase,
} from "./capture";
import { runHelper } from "./code-graders";
import {
  type Context,
  envOf,
  loadDataset,
  refuseLabRun,
  tmpOf,
  withLock,
  workspaceOf,
} from "./command-context";
import { type DatasetInfo, folderDigest, readCases } from "./dataset";
import { buildCase } from "./folders";
import { appendLabel } from "./labels";
import { writeLabels } from "./record-copies";
import { Refusal } from "./refusal";
import type { StoredTrial } from "./store";
import { trialSettingsOf } from "./trial-settings";
import type { CaseWorkspace } from "./workspace";

// `capture` and `label`: a person's verdict on a trial, and a case made from a trial or a real run.

/**
 * `capture {run id}`: a case from a past run of the workflow. A trial's run has its case: its own
 * `files/` and `input.json` are copied, and `--good` drafts `expect` from the trial's facts. A real
 * run, from the project's `.awf/runs`, becomes cases through the dataset's `capture.ts`. Every key
 * is a draft, so no grader runs on it until the person finishes it.
 */
export async function captureCommand(context: Context, names: readonly string[]): Promise<number> {
  const { options } = context;
  const [given, ...extra] = names;
  if (!given) {
    throw new Refusal(
      "capture needs a trial's id, which report --case {case} lists, or a real run's awf run id",
    );
  }
  if (extra.length > 0) {
    throw new Refusal(`capture takes one id; got ${names.length}: ${names.join(" ")}`);
  }
  if (options.good === (options.needsWork !== undefined)) {
    throw new Refusal(
      options.good
        ? 'capture takes --good or --needs-work "{note}", not both'
        : 'capture needs --good or --needs-work "{note}": how the run went',
    );
  }
  const mark: Mark = options.good
    ? { mark: "good" }
    : { mark: "needs-work", note: options.needsWork! };
  const workspace = workspaceOf(context);
  refuseLabRun(workspace, given, "capture");
  const { info } = loadDataset(workspace, options.dataset);
  return withLock(workspace, () => captureLocked(context, workspace, info, given, mark));
}

async function captureLocked(
  context: Context,
  workspace: CaseWorkspace,
  info: DatasetInfo,
  given: string,
  mark: Mark,
): Promise<number> {
  const say = (dir: string, from: string) =>
    context.stdout(
      `wrote ${relative(context.cwd, dir) || dir}, ${from}: its key is a draft to finish`,
    );

  const trial = findTrial(workspace.store, given);
  if (trial) {
    if (trial.record.dataset !== info.name) {
      throw new Refusal(
        `trial ${given} is of dataset ${trial.record.dataset}: --dataset ${trial.record.dataset}`,
      );
    }
    const source = join(info.dir, "cases", trial.record.case);
    if (!existsSync(source))
      throw new Refusal(`case ${trial.record.case} is no longer in ${info.name}`);
    const inputFile = join(source, "input.json");
    const dir = writeCase(info, freeName(info, trial.record.case), {
      filesFrom: join(source, "files"),
      ...(existsSync(inputFile) ? { input: JSON.parse(readFileSync(inputFile, "utf8")) } : {}),
      key: capturedKey(given, mark, trial.record.facts),
    });
    say(
      dir,
      `from trial ${trial.record.trial} of case ${trial.record.case} in run ${trial.record.run}`,
    );
    // The case says what a good result is; the trial it came from keeps the person's verdict.
    labelTrial(
      workspace,
      trial,
      mark.mark,
      mark.mark === "needs-work" ? mark.note : undefined,
      context.environment.now ?? (() => new Date()),
    );
    if (folderDigestOfCase(info, trial.record.case, tmpOf(context)) !== trial.record.input) {
      context.stderr(
        `note: case ${trial.record.case} changed since that trial ran; its files were copied as they are now`,
      );
    }
    return 0;
  }

  const found = findRealRun(
    [workspace.root, ...(workspace.repository ? [workspace.repository] : [])],
    given,
  );
  if (!found) {
    throw new Refusal(
      `no trial or run ${given}: neither a trial in ${workspace.store} nor a run in ${join(workspace.root, ".awf/runs")}`,
    );
  }
  const file = join(info.dir, CAPTURE_FILE);
  if (!existsSync(file)) {
    throw new Refusal(
      `run ${given} is a real run: ${relative(context.cwd, file) || file} turns one into cases, and ${info.name} has none`,
    );
  }
  const work = mkdtempSync(join(tmpOf(context), "awf-lab-capture-"));
  let answer: { cases?: unknown; error?: string };
  try {
    answer = (await runHelper(
      { mode: "capture", file, input: { run: readRealRun(found), root: workspace.root } },
      {
        root: workspace.root,
        work,
        env: envOf(context),
        timeoutMs: trialSettingsOf(info.name, info.dataset).setupTimeoutMs,
        name: "capture",
      },
    )) as typeof answer;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (answer.error !== undefined) throw new Refusal(`${file}: ${answer.error}`);
  const run = readRealRun(found);
  if (mark.mark === "good" && run.outcome !== "completed") {
    throw new Refusal(
      `run ${given} of ${run.workflow} ${run.outcome === "running" ? "has not ended" : `ended ${run.outcome}`}: --good takes a completed run; --needs-work "{note}" captures it`,
    );
  }
  const taken = new Set<string>();
  for (const each of checkCaptured(file, answer.cases)) {
    const name = freeName(info, each.name, taken);
    taken.add(name);
    const dir = writeCase(info, name, {
      ...(each.files ? { files: each.files } : {}),
      ...(each.input !== undefined ? { input: each.input } : {}),
      key: capturedKey(given, mark, each.facts),
    });
    say(dir, `from ${run.workflow}'s run ${given}`);
  }
  return 0;
}

/** A case as a trial would be built from it now, for its digest. */
function folderDigestOfCase(info: DatasetInfo, name: string, under: string): string | undefined {
  const tmp = mkdtempSync(join(under, "awf-lab-capture-case-"));
  try {
    const found = readCases(info).find((c) => c.name === name);
    if (!found) return undefined;
    buildCase(info.dir, found, tmp);
    return folderDigest(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * `label`: the person's verdict on one trial, found by its workflow run's id, as `capture` finds
 * it. A coding agent the person told what was wrong runs it too, and a web interface would.
 */
export function label(context: Context, names: readonly string[]): number {
  const { options } = context;
  const given = [options.good, options.needsWork !== undefined, options.clear].filter(Boolean);
  if (names.length === 0) {
    throw new Refusal("label needs a trial's id, which report --case {case} lists");
  }
  if (names.length > 1) {
    throw new Refusal(`label takes one trial's id; got ${names.length}: ${names.join(" ")}`);
  }
  if (given.length !== 1) {
    throw new Refusal(
      `label ${given.length === 0 ? "needs" : "takes one of"} --good, --needs-work "{note}" or --clear`,
    );
  }
  const workspace = workspaceOf(context);
  const trialId = names[0]!;
  refuseLabRun(workspace, trialId, "label");
  const trial = findTrial(workspace.store, trialId);
  if (!trial) {
    throw new Refusal(
      `no trial ${trialId} in ${workspace.store}; awf-lab report --case {case} lists each trial's id`,
    );
  }
  const mark = options.good ? "good" : options.clear ? "cleared" : "needs-work";
  labelTrial(
    workspace,
    trial,
    mark,
    options.needsWork,
    context.environment.now ?? (() => new Date()),
  );
  const { record } = trial;
  context.stdout(
    mark === "cleared"
      ? `cleared the label of ${record.case} trial ${record.trial}`
      : `labeled ${record.case} trial ${record.trial} ${mark}${options.needsWork ? `: ${options.needsWork}` : ""}`,
  );
  return 0;
}

function labelTrial(
  workspace: CaseWorkspace,
  trial: StoredTrial,
  mark: LabelMark,
  note: string | undefined,
  now: () => Date,
): void {
  appendLabel(workspace.store, trial.record.dataset, {
    kind: LABEL_KIND,
    runId: trial.record.runId!,
    case: trial.record.case,
    mark,
    ...(note ? { note } : {}),
    at: now().toISOString(),
  });
  if (workspace.records) writeLabels(workspace.store, workspace.records);
}
