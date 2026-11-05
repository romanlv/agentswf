import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { TickResultJson } from "@agentswf/contract/records";
import { messageOf } from "./errors";
import { exists } from "./files";
import { ENGINE_VARIABLE, type InstalledEngine, type ProjectEngine } from "./hand-over";
import help from "./help/tick.txt" with { type: "text" };
import { ENGINE_VERSION, EngineRefused, engineOf } from "./project-engine";
import { listProjects, projectRunRoot } from "./projects";
import type { Out } from "./run-commands";
import { parsePlace } from "./run-commands";
import { runLockFile, withRunLock } from "./run-lock";
import { listRuns } from "./run-state";
import { readAttempts } from "./runs";
import { type Launch, wake } from "./wake";

export const tickUsage = help.trimEnd();

export async function tickCommand(
  argv: readonly string[],
  shellCwd: string,
  out: Out,
  context: {
    home: string;
    environment: Readonly<Record<string, string | undefined>>;
    launch?: Launch;
    now?: () => number;
  },
): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    out.stdout(tickUsage);
    return 0;
  }
  let parsed: ReturnType<typeof parsePlace>;
  try {
    parsed = parsePlace(argv, shellCwd);
    const unknown = parsed.rest.find((word) => word !== "--all");
    if (unknown !== undefined) throw new Error(`tick takes no ${unknown}`);
    if (parsed.rest.includes("--all") && parsed.place.repeat.length > 0)
      throw new Error("--all wakes every project's runs; it takes no --cwd or --run-root");
  } catch (error) {
    out.stderr(`awf: ${messageOf(error)}\n\n${tickUsage}`);
    return 2;
  }
  const { place, json } = parsed;
  const woke: TickResultJson["woke"] = [];
  let failed = false;
  const roots: string[] = [];
  /** Each project's runs on its own engine (ADR 0014): this one, or its own in a child. */
  const onItsEngine = async (project: string, root: string) => {
    let engine: ProjectEngine;
    try {
      engine = engineOf(project, await runFiles(root));
    } catch (error) {
      if (!(error instanceof EngineRefused)) throw error;
      failed = true;
      out.stderr(`awf: ${error.message}; its runs are not woken`);
      return;
    }
    if (engine.kind === "declared") {
      failed = true;
      out.stderr(
        `awf: ${project} declares agentswf in ${engine.manifest} and has none installed, so its runs are not woken: run bun install there`,
      );
    } else if (engine.kind === "installed" && engine.version !== ENGINE_VERSION) {
      // This is the engine the project's agentswf runs, and they disagree: another child would find
      // the same, without end.
      if (isOwnEngine(engine)) {
        failed = true;
        out.stderr(
          `awf: ${project}'s agentswf is ${engine.version} and its engine ${ENGINE_VERSION}, so its runs are not woken: run bun install there`,
        );
        return;
      }
      const ticked = await tickElsewhere(project, root, engine, context.environment, out);
      woke.push(...ticked.woke);
      if (!ticked.ok) failed = true;
    } else roots.push(root);
  };
  if (!parsed.rest.includes("--all")) {
    // A project's own run root is its engine's to tick; any other, the operator's, this one's.
    const root = resolve(place.runRoot);
    if (basename(root) === "runs" && basename(dirname(root)) === ".awf")
      await onItsEngine(dirname(dirname(root)), root);
    else roots.push(root);
  } else
    for (const project of await listProjects(context.home)) {
      if (!(await exists(project))) {
        failed = true;
        out.stderr(`awf: ${project}, in ~/.awf/projects, is gone; its runs are not woken`);
        continue;
      }
      // A project a plain run registered (ADR 0015) has nothing for a tick to wake; one on another
      // engine is that engine's to judge, whose records this one may not read.
      const root = projectRunRoot(project);
      if (!(await listRuns(root)).some((run) => run.record.events) && onThisEngine(project))
        continue;
      await onItsEngine(project, root);
    }
  for (const root of roots) {
    for (const run of await listRuns(root)) {
      if (!run.record.events) continue;
      const ref = `${run.record.workflow}/${run.record.id}`;
      try {
        const { workflow, id } = run.record;
        const why = await withRunLock(runLockFile(root, workflow, id), async () => {
          const woken = await wake(run, { ...context, nudgeLive: false });
          if (woken.why === "launch-failed") throw new Error(woken.error ?? "launch failed");
          if ((woken.did !== "started" && woken.did !== "continued") || !woken.cause)
            return undefined;
          return { did: woken.did, why: woken.cause };
        });
        if (why) woke.push({ ref, ...why });
      } catch (error) {
        failed = true;
        out.stderr(`awf: ${ref}: ${messageOf(error)}`);
      }
    }
  }
  if (json) out.stdout(JSON.stringify({ v: 1, woke } satisfies TickResultJson));
  else for (const each of woke) out.stdout(`${each.did} ${each.ref}: ${each.why}`);
  return failed ? 1 : 0;
}

/** The files the event runs under `root` last ran, by which a project with no engine finds one. */
async function runFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const run of await listRuns(root)) {
    if (!run.record.events) continue;
    const file = (await readAttempts(run).catch(() => [])).at(-1)?.file ?? run.record.file;
    if (file !== undefined) files.push(file);
  }
  return files;
}

/**
 * `awf tick` of one project's runs on its own engine, as the hand-over runs it: in the project,
 * with `AWF_ENGINE` naming it, so it never hands over by its directory.
 */
async function tickElsewhere(
  project: string,
  root: string,
  engine: InstalledEngine,
  environment: Readonly<Record<string, string | undefined>>,
  out: Out,
): Promise<{ ok: boolean; woke: TickResultJson["woke"] }> {
  const child = Bun.spawn({
    cmd: [process.execPath, "--no-env-file", engine.bin, "tick", "--run-root", root, "--json"],
    cwd: project,
    env: { ...environment, [ENGINE_VARIABLE]: engine.dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  for (const line of stderr.trimEnd().split("\n")) if (line) out.stderr(line);
  try {
    const result = JSON.parse(stdout) as Partial<TickResultJson>;
    if (!Array.isArray(result.woke)) throw new Error("no woke");
    return { ok: code === 0, woke: result.woke };
  } catch {
    out.stderr(
      `awf: ${project}'s agentswf ${engine.version} did not say what it woke (exit ${code})`,
    );
    return { ok: false, woke: [] };
  }
}

/** Whether `engine`'s agentswf runs on this very engine package. */
function isOwnEngine(engine: InstalledEngine): boolean {
  try {
    const theirs = Bun.resolveSync("@agentswf/engine/package.json", engine.dir);
    return realpathSync(theirs) === realpathSync(join(import.meta.dir, "..", "package.json"));
  } catch {
    return false;
  }
}

/** Whether a project's runs would run on this engine, or none is installed there to run them. */
function onThisEngine(project: string): boolean {
  try {
    const engine = engineOf(project);
    return engine.kind !== "installed" || engine.version === ENGINE_VERSION;
  } catch {
    return false;
  }
}
