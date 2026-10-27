import type { TickResultJson } from "@agentswf/contract/records";
import { messageOf } from "./errors";
import { exists } from "./files";
import { listProjects, projectRunRoot } from "./projects";
import type { Out } from "./run-commands";
import { parsePlace } from "./run-commands";
import { runLockFile, withRunLock } from "./run-lock";
import { listRuns } from "./run-state";
import { type Launch, wake } from "./wake";

export const tickUsage = [
  "usage: awf tick [--cwd <directory>] [--run-root <directory>] [--json]",
  "       awf tick --all [--json]",
  "",
  "Wakes every run of a workflow with events under --cwd's .awf/runs, or --run-root, the runs awf",
  "runs lists there, as an event would: continues a parked run whose wait's until has passed, and a",
  "crashed or failed one until it has failed three times in a row. Runs of other workflows are left",
  "as they are. --all wakes them in every project awf has started one in, as ~/.awf/projects lists",
  "them. Run it on any schedule; a run is continued once however many wakers come at once.",
  "",
  "Prints a line for each run it woke, and nothing when it woke none. --json prints one document.",
  "Exits 0, or 1 when a project is gone or a run could not be woken; the others are still woken.",
].join("\n");

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
  if (!parsed.rest.includes("--all")) roots.push(place.runRoot);
  else
    for (const project of await listProjects(context.home)) {
      if (await exists(project)) roots.push(projectRunRoot(project));
      else {
        failed = true;
        out.stderr(`awf: ${project}, in ~/.awf/projects, is gone; its runs are not woken`);
      }
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
