import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { QuickCheckResult } from "../examples/quick-check/workflow";
import type { OutputRecord } from "../packages/contract/src/records";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import type { Trial } from "../packages/lab/src/review/format/records";
import { runLab } from "../packages/lab/src/review/lab/cli";
import { awfRunner } from "../packages/lab/src/review/lab/runner";
import { mechanism, workspace } from "./lab-workspace";

/**
 * `awf run --sandbox`, live (story 010). awf-lab runs a probe variant on a synthetic case: two
 * agents that name no sandbox, one running commands that must reach the checkout and the request
 * and nothing else, the other reading the request. Then other workflows under a run sandbox: one
 * that must run unchanged, one that opens its own sandbox and must be refused, and a spec that
 * can't open, which must end the run before it starts.
 */
const PROBE = join(import.meta.dir, "fixtures/run-sandbox/probe.workflow.ts");
const QUICK_CHECK = join(import.meta.dir, "../examples/quick-check/workflow.ts");
const SANDBOXES = join(import.meta.dir, "../examples/sandboxes/workflow.ts");
const CASE = "app-1";
/** What the case's key says, which no agent may see. */
export const KEY_TEXT = mechanism(CASE, 1);

/** The prober's commands, by what each checks; `{request}` and `{dataset}` are awf-lab's. */
export const COMMANDS = {
  request: "cat {request}",
  diff: "git diff --stat origin/main...HEAD 2>/dev/null",
  key: `cat {dataset}/${CASE}/key/key.json`,
  clone: "git -C CLONE log -1 --oneline",
  home: "ls HOME",
  gitlab: "curl -sS -m 5 -o /dev/null -I https://gitlab.com && echo reached",
  write: "touch probe-write && echo wrote",
} as const;

/**
 * Each command once its placeholders are filled, anchored at its start: the agent's `wf result`
 * is a command too, and quotes all of them.
 */
const MARKS: Record<keyof typeof COMMANDS, RegExp> = {
  request: /^(cat|head -1) \S*\/request\.md$/,
  diff: /^git diff --stat /,
  key: /^cat \S*\/key\.json$/,
  clone: /^git -C \S+ log -1/,
  home: /^ls \//,
  gitlab: /^curl .*gitlab\.com/,
  write: /^touch probe-write/,
};

export type Provider = "srt" | "docker";

/** What each provider's OS says when it refuses a read: docker never mounted the path at all. */
export const REFUSED: Record<Provider, string> = {
  srt: "Operation not permitted",
  docker: "No such file or directory",
};

/** One shell command an agent ran, as codex's transcript records it, not as the agent reports it. */
export type Execution = { command: string; exitCode: number; output: string };

export type Evidence = {
  provider: Provider;
  lab: {
    exitCode: number;
    log: string;
    trial?: Trial;
    record?: OutputRecord;
    /** Whether the key the prober must not read is on the host, so a refusal is not a wrong path. */
    keyOnHost: boolean;
    /** Every transcript of the trial's run's sandbox, joined. */
    transcripts: string;
    executions: Execution[];
  };
  quickCheck: { exitCode: number; stderr: string; record?: OutputRecord };
  ownSandbox: { exitCode: number; stderr: string };
  unopenable: { exitCode: number; stderr: string; printed: boolean; records: number };
};

/** The commands a codex transcript records: one JSON event per line. */
export function executionsOf(transcript: string): Execution[] {
  return transcript.split("\n").flatMap((line) => {
    const item = line.startsWith("{") ? JSON.parse(line).payload?.item : undefined;
    if (item?.type !== "CommandExecution") return [];
    return [
      { command: item.command.at(-1), exitCode: item.exit_code, output: item.aggregated_output },
    ];
  });
}

/** What went wrong, from what the runner gathered; empty when every check held. */
export function problems(evidence: Evidence): string[] {
  const found: string[] = [];
  const { lab } = evidence;
  if (lab.exitCode !== 0) found.push(`awf-lab run exited ${lab.exitCode}: ${lab.log}`);
  const trial = lab.trial;
  if (trial?.run.outcome !== "completed") {
    found.push(
      `the trial did not succeed: ${trial?.run.outcome ?? "no trial"} ${trial?.failure ?? ""}`,
    );
  } else if (JSON.stringify(trial.sandbox) !== JSON.stringify({ [evidence.provider]: {} })) {
    found.push(`the trial recorded sandbox ${JSON.stringify(trial.sandbox)}`);
  }
  const boxes = lab.record?.sandboxes ?? [];
  const box = boxes[0];
  if (boxes.length !== 1 || box?.key !== "run") {
    found.push(`the run's record lists sandboxes ${boxes.map((b) => b.key).join(", ") || "none"}`);
  } else {
    const agents = box.agents.map((agent) => agent.agent).sort();
    if (agents.join(",") !== "prober,reader") found.push(`sandbox run holds ${agents.join(", ")}`);
    if (!box.spec.cwd.endsWith("/checkout")) found.push(`sandbox run works in ${box.spec.cwd}`);
    const reads = box.spec.read ?? [];
    if (reads.length !== 1 || !reads[0]!.endsWith("/request.md")) {
      found.push(`sandbox run reads ${reads.join(", ")}`);
    }
    if ((box.spec.write ?? []).length > 0) found.push("sandbox run writes somewhere");
  }

  const refused = REFUSED[evidence.provider];
  const expect = (key: keyof typeof COMMANDS, ok: (run: Execution) => boolean, what: string) => {
    const runs = lab.executions.filter((run) => MARKS[key].test(run.command));
    if (runs.length === 0) found.push(`${key}: never ran`);
    for (const run of runs) {
      if (!ok(run))
        found.push(`${key}: ${what}; exit ${run.exitCode}: ${run.output.slice(0, 200)}`);
    }
  };
  // The reader's `head -1` is found by the request's mark too.
  expect(
    "request",
    (run) => run.exitCode === 0 && run.output.includes(`# Change ${CASE}`),
    "request unread",
  );
  expect("diff", (run) => run.output.includes("src/app.ts"), "change not seen");
  expect("key", (run) => run.exitCode !== 0 && run.output.includes(refused), "key not refused");
  expect("clone", (run) => run.exitCode !== 0, "clone readable");
  expect("home", (run) => run.exitCode !== 0 && run.output.includes(refused), "home not refused");
  expect("gitlab", (run) => !run.output.includes("reached"), "gitlab reached");
  expect("write", (run) => !run.output.includes("wrote"), "checkout writable");
  if (!lab.executions.some((run) => run.command.startsWith("head -1"))) {
    found.push("the reader never read the request");
  }
  if (!lab.keyOnHost) found.push("the key is not on the host, so its refusal proves nothing");
  const value = lab.record?.outcome === "completed" ? lab.record.value : undefined;
  if (`${lab.transcripts}${JSON.stringify(value ?? {})}`.includes(KEY_TEXT)) {
    found.push("the key reached an agent");
  }

  const { quickCheck } = evidence;
  const checks =
    quickCheck.record?.outcome === "completed"
      ? (quickCheck.record.value as QuickCheckResult).checks
      : [];
  const right = checks.flatMap((c) => c.answers).filter((a) => a.answer === a.expected).length;
  if (quickCheck.exitCode !== 0 || right !== 2) {
    found.push(
      `quick-check: exit ${quickCheck.exitCode}, ${right} of 2 answers right: ${quickCheck.stderr.split("\n").at(-1)}`,
    );
  }
  const quickBoxes = quickCheck.record?.sandboxes ?? [];
  const quickBox = quickBoxes[0];
  if (
    quickBoxes.length !== 1 ||
    quickBox?.key !== "run" ||
    quickBox.agents.map((a) => a.agent).join(",") !== "check:codex"
  ) {
    found.push(
      `quick-check's record lists sandboxes ${quickBoxes.map((b) => b.key).join(", ") || "none"}`,
    );
  } else if ((quickBox.spec.read ?? []).length > 0 || (quickBox.spec.write ?? []).length > 0) {
    found.push("quick-check's sandbox reaches past its working directory");
  }

  const { ownSandbox } = evidence;
  if (ownSandbox.exitCode === 0 || !ownSandbox.stderr.includes("a workflow cannot open its own")) {
    found.push(
      `a workflow opening its own sandbox was not refused: ${ownSandbox.stderr.split("\n")[0]}`,
    );
  }

  const { unopenable } = evidence;
  if (
    unopenable.exitCode === 0 ||
    !/the run's sandbox did not open: .*does not exist/.test(unopenable.stderr)
  ) {
    found.push(`a spec that can't open did not stop the run: exit ${unopenable.exitCode}`);
  }
  if (unopenable.printed || unopenable.records > 0) {
    found.push("a run whose sandbox didn't open left a record");
  }
  return found;
}

/** Runs everything, live, and gathers what `problems` reads. */
export async function gather(
  provider: Provider,
  signal: AbortSignal,
): Promise<{ evidence: Evidence; estimate: number; artifacts: string[] }> {
  const ws = await workspace();
  const config = join(ws.root, "awf-lab.json");
  const settings = { [provider]: {} };
  await writeFile(
    config,
    JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), sandbox: settings }),
  );
  const clone = join(ws.root, "project");
  const home = await realpath(homedir());
  const keyOnHost = existsSync(join(ws.root, "datasets", "first", CASE, "key", "key.json"));
  const commands = Object.values(COMMANDS).map((command) =>
    command.replace("CLONE", clone).replace("HOME", home),
  );
  await ws.variant(
    "probe",
    `import { defineReviewVariant } from "@agentswf/lab/review";
import probe from ${JSON.stringify(PROBE)};

export default defineReviewVariant({
  workflow: probe,
  argv: ["--request", "{request}", ...${JSON.stringify(commands)}],
  timeout: "8m",
  read: (result) => [
    ...result.results.map((r) => ({ text: r.command + "\\nexit " + r.exitCode + "\\n" + r.output })),
    { text: "first line: " + result.firstLine },
  ],
});
`,
  );
  const log: string[] = [];
  const exitCode = await runLab(["run", "probe", "--cases", CASE, "--yes"], {
    cwd: ws.root,
    stdout: (text) => log.push(text),
    stderr: (text) => {
      log.push(text);
      console.error(text);
    },
    runner: awfRunner(),
    confirm: async () => true,
  });
  const results = join(ws.root, "results", "first");
  const trialFile = [
    ...new Bun.Glob(`probe@*/${CASE}/*/findings.json`).scanSync({ cwd: results }),
  ][0];
  const trial = trialFile
    ? (JSON.parse(readFileSync(join(results, trialFile), "utf8")) as Trial)
    : undefined;
  const runs = join(ws.root, "runs");
  const record = [...new Bun.Glob("*/*/output.json").scanSync({ cwd: runs })]
    .map((file) => JSON.parse(readFileSync(join(runs, file), "utf8")) as OutputRecord)
    .find((candidate) => candidate.workflow.name === "run-sandbox-probe");
  const sandboxes = record ? join(record.artifacts, "sandboxes") : undefined;
  const transcripts =
    sandboxes && existsSync(sandboxes)
      ? readdirSync(sandboxes, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
          .join("\n")
      : "";

  const dir = await realpath(await mkdtemp(join(tmpdir(), "awf-run-sandbox-")));
  // Apart from the runs: a sandbox refuses to reach the run root.
  const work = join(dir, "work");
  await mkdir(work);
  const spec = join(dir, "sandbox.json");
  await writeFile(spec, JSON.stringify(settings));
  const unopenableSpec = join(dir, "unopenable.json");
  await writeFile(unopenableSpec, JSON.stringify({ read: [join(work, "nowhere")], ...settings }));
  const awf = async (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runOperatorCli(
      ["run", "--run-root", join(dir, "runs"), "--cwd", work, "--timeout", "5m", ...argv],
      { cwd: dir, signal, stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    );
    const text = out.join("\n").trim();
    return {
      exitCode: code,
      stderr: err.join("\n"),
      ...(text.startsWith("{") ? { record: JSON.parse(text) as OutputRecord } : {}),
    };
  };
  const quickCheck = await awf(["--sandbox", spec, "--json", QUICK_CHECK, "--", "codex"]);
  const ownSandbox = await awf(["--sandbox", spec, SANDBOXES]);
  const before = outputs(join(dir, "runs"));
  const unopenable = await awf(["--sandbox", unopenableSpec, "--json", QUICK_CHECK, "--", "codex"]);
  const evidence: Evidence = {
    provider,
    lab: {
      exitCode,
      log: log.join("\n"),
      ...(trial ? { trial } : {}),
      ...(record ? { record } : {}),
      keyOnHost,
      transcripts,
      executions: executionsOf(transcripts),
    },
    quickCheck: {
      exitCode: quickCheck.exitCode,
      stderr: quickCheck.stderr,
      ...(quickCheck.record ? { record: quickCheck.record } : {}),
    },
    ownSandbox: { exitCode: ownSandbox.exitCode, stderr: ownSandbox.stderr },
    unopenable: {
      exitCode: unopenable.exitCode,
      stderr: unopenable.stderr,
      printed: unopenable.record !== undefined,
      records: outputs(join(dir, "runs")) - before,
    },
  };
  const estimate =
    (record?.accounting.totals.estimate ?? 0) +
    (quickCheck.record?.accounting.totals.estimate ?? 0);
  return { evidence, estimate, artifacts: [ws.root, dir] };
}

function outputs(runs: string): number {
  return existsSync(runs) ? [...new Bun.Glob("*/*/output.json").scanSync({ cwd: runs })].length : 0;
}
