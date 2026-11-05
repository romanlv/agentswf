import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunLine } from "@agentswf/contract/records";
import { runOperatorCli, takeLaunch } from "./operator-cli";
import type { RunCommand } from "./run-command";
import { claimRunLines, readRunLines, runLinesFile } from "./run-lines";
import { claimNext } from "./run-prepare";
import { statusOf } from "./run-state";
import {
  createRun,
  endAttempt,
  launchLog,
  processStart,
  readAttemptFiles,
  readAttempts,
  recordFailedLaunch,
} from "./runs";
import { createTempRunDirs, writeAttempt } from "./testing";
import type { LoadedWorkflow } from "./workflow-loader";

const dirs = createTempRunDirs();
afterAll(() => dirs.cleanup());

const AT = "2026-11-05T10:00:00.000Z";
const GONE = { pid: Bun.spawnSync(["true"]).pid, processStart: "2026-10-11T09:00:00Z" };

const stage = (attempt: number, name: string): RunLine => ({
  kind: "stage",
  attempt,
  at: AT,
  name,
  outcome: "succeeded",
  started: AT,
  value: name,
});

const text = (dir: string) => readFileSync(runLinesFile(dir), "utf8");

describe("run.jsonl's writer", () => {
  test("a claim creates the file and appends claimed", async () => {
    const dir = dirs.tempRunDir();
    await claimRunLines(dir, 1, AT);
    expect(text(dir)).toBe(`${JSON.stringify({ kind: "claimed", attempt: 1, at: AT })}\n`);
  });

  test("a torn last line is cut, not merged with the claim", async () => {
    const dir = dirs.tempRunDir();
    const first = await claimRunLines(dir, 1, AT);
    await first.append(stage(1, "plan"));
    const whole = text(dir);
    appendFileSync(runLinesFile(dir), '{"kind":"stage","attempt":1,"at":"2026-11-05T10:0');
    await claimRunLines(dir, 2, AT);
    expect(text(dir)).toBe(`${whole}${JSON.stringify({ kind: "claimed", attempt: 2, at: AT })}\n`);
    const { lines, view } = await readRunLines(dir);
    expect(lines.map((line) => line.kind)).toEqual(["claimed", "stage", "claimed"]);
    expect(view.stages.plan?.settled?.attempt).toBe(1);
  });

  test("a file holding only a torn line is emptied before the claim", async () => {
    const dir = dirs.tempRunDir();
    writeFileSync(runLinesFile(dir), '{"kind":"claim');
    await claimRunLines(dir, 1, AT);
    expect((await readRunLines(dir)).lines).toEqual([{ kind: "claimed", attempt: 1, at: AT }]);
  });

  test("an earlier attempt's line after a later claim is fenced", async () => {
    const dir = dirs.tempRunDir();
    const first = await claimRunLines(dir, 1, AT);
    await first.append(stage(1, "plan"));
    await claimRunLines(dir, 2, AT);
    // Attempt 1, not yet gone when attempt 2 claimed, appends once more.
    await first.append(stage(1, "build"));
    const { lines, view } = await readRunLines(dir);
    expect(lines).toHaveLength(4);
    expect(view.fenced).toBe(1);
    expect(Object.keys(view.stages)).toEqual(["plan"]);
  });

  test("lines keep the order they were appended in", async () => {
    const dir = dirs.tempRunDir();
    const lines = await claimRunLines(dir, 1, AT);
    await Promise.all(["a", "b", "c", "d"].map((name) => lines.append(stage(1, name))));
    expect(Object.keys((await readRunLines(dir)).view.stages)).toEqual(["a", "b", "c", "d"]);
  });

  test("a torn tail longer than the read-back chunk is cut whole", async () => {
    const dir = dirs.tempRunDir();
    const first = await claimRunLines(dir, 1, AT);
    await first.append(stage(1, "plan"));
    const whole = text(dir);
    appendFileSync(runLinesFile(dir), `{"kind":"stage","value":"${"x".repeat(200_000)}`);
    await claimRunLines(dir, 2, AT);
    expect(text(dir)).toBe(`${whole}${JSON.stringify({ kind: "claimed", attempt: 2, at: AT })}\n`);
  });

  test("a writer appends only its own attempt's lines", async () => {
    const dir = dirs.tempRunDir();
    const lines = await claimRunLines(dir, 2, AT);
    const claimed = text(dir);
    await expect(lines.append(stage(1, "plan"))).rejects.toThrow(
      "attempt 2 cannot append a line of attempt 1",
    );
    expect(text(dir)).toBe(claimed);
  });

  test("one run folder, however spelled, is one file and one queue", () => {
    const dir = dirs.tempRunDir();
    expect(runLinesFile(join(dir, "x", ".."))).toBe(runLinesFile(dir));
  });
});

describe("run.jsonl's reader", () => {
  test("a missing file reads as an empty run", async () => {
    const { lines, view } = await readRunLines(dirs.tempRunDir());
    expect(lines).toEqual([]);
    expect(view.stages).toEqual({});
  });

  test("text after the last newline is not read", async () => {
    const dir = dirs.tempRunDir();
    await claimRunLines(dir, 1, AT);
    appendFileSync(runLinesFile(dir), '{"kind":"stage"');
    expect((await readRunLines(dir)).lines).toHaveLength(1);
  });

  test("a complete line that isn't JSON is refused", async () => {
    const dir = dirs.tempRunDir();
    await claimRunLines(dir, 1, AT);
    appendFileSync(runLinesFile(dir), "{not json\n");
    await expect(readRunLines(dir)).rejects.toThrow("run.jsonl line 2: not JSON");
  });
});

describe("the claim", () => {
  test("a run without events also waits for its previous attempt", async () => {
    const root = dirs.tempRunDir();
    const run = await createRun(join(root, "runs"), {
      id: "k",
      workflow: "w",
      argv: [],
      cwd: root,
      sandbox: null,
    });
    // Attempt 1 failed, its process still closing.
    const previous = Bun.spawn({ cmd: ["sleep", "0.4"] });
    await Bun.sleep(50);
    await writeAttempt(run, {
      pid: previous.pid,
      processStart: processStart(previous.pid)!,
      ended: new Date().toISOString(),
      outcome: "failed",
    });
    const loaded = { file: "/flows/case.ts", workflow: { meta: { name: "w" } } } as LoadedWorkflow;
    const command = { continueId: "k" } as RunCommand;
    const gone = previous.exited.then(() => Date.now());
    const attempt = await claimNext(run, loaded, command, () => undefined, Date.now());
    const claimed = Date.now();
    expect(claimed).toBeGreaterThanOrEqual(await gone);
    expect(attempt.record.attempt).toBe(2);
    expect((await readRunLines(run.dir)).lines).toEqual([
      { kind: "claimed", attempt: 2, at: attempt.record.started },
    ]);
    // The claim's writer is the attempt's.
    await attempt.lines.append(stage(2, "plan"));
    expect((await readRunLines(run.dir)).view.stages.plan?.settled?.attempt).toBe(2);
  });
  test("a failed launch hides no attempt: the claim waits for the one before it, a crashed one is stopped and not resumed", async () => {
    const root = dirs.tempRunDir();
    const make = (id: string) =>
      createRun(join(root, "runs"), {
        id,
        workflow: "w",
        argv: [],
        cwd: root,
        sandbox: null,
        events: true,
      });
    const failed = (attempt: number) =>
      recordFailedLaunch(run, {
        attempt,
        launch: `l${attempt}`,
        file: "/flows/case.ts",
        started: new Date().toISOString(),
        reason: "down",
      });
    const run = await make("k");
    const ended = { ended: new Date().toISOString(), outcome: "failed" as const };
    await writeAttempt(run, { ...GONE, ...ended });
    await writeAttempt(run, { ...GONE, ...ended });
    // Attempt 3 parked, its process still closing its agents; then a launch never claimed 4.
    const closing = Bun.spawn({ cmd: ["sleep", "0.4"] });
    await Bun.sleep(50);
    const parked = { ended: new Date().toISOString(), outcome: "parked" as const };
    await writeAttempt(run, {
      pid: closing.pid,
      processStart: processStart(closing.pid)!,
      ...parked,
    });
    expect(await failed(4)).toBe(true);
    const status = statusOf(run, await readAttemptFiles(run));
    expect(status).toMatchObject({ state: "parked", attempts: [{}, {}, { attempt: 3 }] });
    expect(status.files.map((each) => each.attempt)).toEqual([1, 2, 3, 4]);
    const loaded = { file: "/flows/case.ts", workflow: { meta: { name: "w" } } } as LoadedWorkflow;
    const gone = closing.exited.then(() => Date.now());
    const command = { continueId: "k" } as RunCommand;
    const attempt = await claimNext(run, loaded, command, () => undefined, Date.now());
    expect(attempt.record.attempt).toBe(5);
    expect(Date.now()).toBeGreaterThanOrEqual(await gone);

    // Attempt 3 crashed; then a launch never claimed 4. What a continue stops, and whether it
    // reopens sessions, read the last attempt that ran: 3, with no ending.
    const crashed = await make("c");
    await writeAttempt(crashed, { ...GONE });
    await writeAttempt(crashed, { ...GONE, ...ended });
    await writeAttempt(crashed, { ...GONE });
    await recordFailedLaunch(crashed, {
      attempt: 4,
      launch: "l4",
      file: "/flows/case.ts",
      started: new Date().toISOString(),
      reason: "down",
    });
    const previous = (await readAttempts(crashed)).at(-1);
    expect(previous).toMatchObject({ attempt: 3 });
    expect(previous?.ended).toBeUndefined();
    expect(statusOf(crashed, await readAttemptFiles(crashed)).state).toBe("interrupted");
  });
  test("a claim records the launch that started it only when that launch is this run's", async () => {
    const root = dirs.tempRunDir();
    const run = await createRun(join(root, "runs"), {
      id: "k",
      workflow: "w",
      argv: [],
      cwd: root,
      sandbox: null,
    });
    const loaded = { file: "/flows/case.ts", workflow: { meta: { name: "w" } } } as LoadedWorkflow;
    const command = { continueId: "k" } as RunCommand;
    // A run an agent of another run starts inherits that run's launch, whose log isn't here.
    const nested = await claimNext(run, loaded, command, () => undefined, Date.now(), "other");
    expect(nested.record).not.toHaveProperty("launch");
    await endAttempt(nested, { outcome: "failed" });
    mkdirSync(join(run.dir, "launches"));
    writeFileSync(launchLog(run.dir, "mine"), "");
    const launched = await claimNext(run, loaded, command, () => undefined, Date.now(), "mine");
    expect(launched.record.launch).toBe("mine");
  });

  test("awf reads AWF_LAUNCH once and keeps it from what it spawns", async () => {
    process.env.AWF_LAUNCH = "parent";
    await runOperatorCli(["--version"], { stdout: () => undefined, stderr: () => undefined });
    expect(process.env.AWF_LAUNCH).toBeUndefined();
    // An injected environment is a copy without it; the launch is kept for the claim alone.
    const given = { environment: { PATH: "/bin", AWF_LAUNCH: "l1" } };
    const taken = takeLaunch(given);
    expect(taken.launchId).toBe("l1");
    expect(taken.environment).toEqual({ PATH: "/bin" });
    expect(given.environment.AWF_LAUNCH).toBe("l1");
  });
});
