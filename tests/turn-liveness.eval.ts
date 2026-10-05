import { mkdir, mkdtemp, readFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OutputRecord } from "../packages/contract/src/records";
import { readOperationEvents } from "../packages/engine/src/operation-events";
import { runOperatorCli } from "../packages/engine/src/operator-cli";
import { assertLiveOptIn, interruption } from "./live";
import { type Evidence, MODES, type Mode, problems } from "./turn-liveness-evidence";

// One Claude pane, 1–3 minutes and <$1 list price per scenario; subscription placement.
if (import.meta.main) {
  assertLiveOptIn();
  const mode = (process.argv[2] ?? "host") as Mode;
  if (!MODES.includes(mode)) throw new Error(`mode must be ${MODES.join(", ")}`);
  const directory = await mkdtemp(join(tmpdir(), "awf-liveness-"));
  const cwd = join(directory, "work");
  await mkdir(cwd);
  const runRoot = join(directory, "runs");
  await mkdir(runRoot);
  const output: string[] = [];
  const cancel = new AbortController();
  let injected = false;
  let injectionError: string | undefined;
  let finished = false;
  const faults = (async () => {
    if (mode !== "cancel" && mode !== "lost-route") return;
    while (!finished) {
      for await (const path of new Bun.Glob("*/*/calls/*/liveness.jsonl").scan({
        cwd: runRoot,
        absolute: true,
      })) {
        const rows = (await readFile(path, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        if (mode === "cancel" && rows.some((row) => row.kind === "dispatched")) {
          injected = true;
          cancel.abort("probe cancellation after dispatch");
          return;
        }
        if (mode === "lost-route" && rows.some((row) => row.kind === "waiting")) {
          const launcher = (await readFile(join(cwd, "route.txt"), "utf8")).trim();
          if (!/^\/(?:private\/)?tmp\/awf-[A-Za-z0-9]+\/a[A-Za-z0-9]+\/wf$/.test(launcher))
            throw new Error("unexpected route path");
          const runId = path.split("/").at(-4)!;
          const operationId = path.split("/").at(-2)!;
          const sandboxRoot = join(homedir(), ".awf", "sandboxes", "turn-liveness-proof", runId);
          let witnessed = false;
          for await (const native of new Bun.Glob("**/projects/*/*.jsonl").scan({
            cwd: sandboxRoot,
            absolute: true,
          })) {
            for (const line of (await readFile(native, "utf8")).split("\n")) {
              if (!line) continue;
              const row = JSON.parse(line);
              const content = row.message?.content;
              if (
                row.type === "user" &&
                typeof content === "string" &&
                content.includes(operationId) &&
                content.includes(launcher)
              )
                witnessed = true;
            }
          }
          if (!witnessed) throw new Error("route not witnessed in this operation's native prompt");
          const endpoint = join(dirname(launcher), "s.sock");
          if (!(await readFile(launcher, "utf8")).includes(endpoint))
            throw new Error("launcher endpoint mismatch");
          await unlink(endpoint);
          injected = true;
          return;
        }
      }
      await Bun.sleep(100);
    }
  })().catch((error) => {
    injectionError = String(error);
    cancel.abort("fault injection failed");
  });
  let code = 1;
  try {
    code = await runOperatorCli(
      [
        "run",
        "--run-root",
        runRoot,
        "--timeout",
        "5m",
        "--json",
        join(import.meta.dir, "fixtures/turn-liveness.workflow.ts"),
        "--",
        mode,
      ],
      {
        cwd,
        signal: AbortSignal.any([interruption(), cancel.signal]),
        stdout: (text) => output.push(text),
        stderr: (text) => console.error(text),
      },
    );
  } finally {
    finished = true;
    await faults;
  }
  const record: OutputRecord | undefined = output.length
    ? JSON.parse(output.join("\n"))
    : undefined;
  const evidence: Evidence = [];
  if (record)
    for await (const path of new Bun.Glob("calls/*/liveness.jsonl").scan({
      cwd: record.artifacts,
    })) {
      const read = await readOperationEvents(record.artifacts, path.split("/")[1]!);
      evidence.push({ events: read.records, incomplete: read.incomplete });
    }
  const route =
    mode === "lost-route"
      ? {
          removed: injected,
          status: await readFile(join(cwd, "route-status.txt"), "utf8").catch(() => ""),
          error: await readFile(join(cwd, "route-error.txt"), "utf8").catch(() => ""),
        }
      : undefined;
  const errors = problems(mode, code, record, evidence, route);
  if (injectionError) errors.push(injectionError);
  if (mode === "cancel" && !injected) errors.push("cancellation was not injected after dispatch");
  console.log(
    JSON.stringify(
      {
        ok: errors.length === 0,
        mode,
        exitCode: code,
        estimateUsd: record?.accounting.totals.estimate,
        directory,
        problems: errors,
        record,
      },
      null,
      2,
    ),
  );
  process.exitCode = errors.length ? 1 : 0;
}
