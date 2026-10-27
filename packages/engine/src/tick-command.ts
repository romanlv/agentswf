import type { TickResultJson } from "@agentswf/contract/records";
import { messageOf } from "./errors";
import { exists } from "./files";
import { listProjects, projectRunRoot } from "./projects";
import type { Out } from "./run-commands";
import { runLockFile, withRunLock } from "./run-lock";
import { listRuns } from "./run-state";
import { type Launch, wake } from "./wake";

export const tickUsage = [
  "usage: awf tick [--json]",
  "",
  "Wakes every run of a workflow with events in each project awf has started one in, as an event",
  "would: continues a parked run whose wait's until has passed, and a crashed or failed one until",
  "it has failed three times in a row. Runs of other workflows are left as they are. Run it on any",
  "schedule; a run is continued once however many wakers come at once.",
  "",
  "Prints a line for each run it woke, and nothing when it woke none. --json prints one document.",
  "Exits 0, or 1 when a project is gone or a run could not be woken; the others are still woken.",
].join("\n");

export async function tickCommand(
  argv: readonly string[],
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
  const unknown = argv.find((word) => word !== "--json");
  if (unknown !== undefined) {
    out.stderr(`awf: tick takes no ${unknown}\n\n${tickUsage}`);
    return 2;
  }
  const json = argv.includes("--json");
  const woke: TickResultJson["woke"] = [];
  let failed = false;
  for (const project of await listProjects(context.home)) {
    const root = projectRunRoot(project);
    if (!(await exists(project))) {
      failed = true;
      out.stderr(`awf: ${project}, in ~/.awf/projects, is gone; its runs are not woken`);
      continue;
    }
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
        if (why) woke.push({ run: ref, ...why });
      } catch (error) {
        failed = true;
        out.stderr(`awf: ${ref}: ${messageOf(error)}`);
      }
    }
  }
  if (json) out.stdout(JSON.stringify({ v: 1, woke } satisfies TickResultJson));
  else for (const each of woke) out.stdout(`${each.did} ${each.run}: ${each.why}`);
  return failed ? 1 : 0;
}
