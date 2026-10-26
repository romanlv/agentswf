// The review loop's tick, from its style-c sketch: it tells each MR's run what changed on GitLab.
// Sent without ids: events only notify, and the tick sends only what its own state says changed.
import { defineExecutableWorkflow } from "@agentswf/contract/workflow";
import mrRun from "./mr-review";

type Mr = { iid: number; head: string; labels: string[]; merged: boolean };
type Threads = { id: string; resolved: boolean }[];
declare const gitlab: {
  reviewing(): Promise<Mr[]>;
  digest(iid: number): Promise<Threads>;
  settled(iids: number[]): Promise<Mr[]>;
};
declare function openSeen(file: string): {
  changed(iid: number, state: object): boolean;
  record(iid: number, state: object): void;
};
declare const ledgers: { tracked(): number[] };
declare const TICK_STATE: string;
declare function singleton<W>(workflow: W): W;

export default singleton(
  defineExecutableWorkflow({
    definition: {
      meta: { name: "mr-tick", description: "Tell each MR's review run what changed on GitLab." },
      async run(workflow) {
        const mrs = await gitlab.reviewing();
        const seen = openSeen(TICK_STATE);
        for (const mr of mrs) {
          const threads = await gitlab.digest(mr.iid);
          const authorized = mr.labels.includes("ai-review");
          const state = { head: mr.head, authorized, threads };
          if (seen.changed(mr.iid, state)) {
            await workflow.emit(mrRun, "mr.changes", { iid: mr.iid, ...state });
            seen.record(mr.iid, state);
          }
        }
        const gone = ledgers.tracked().filter((iid) => !mrs.some((mr) => mr.iid === iid));
        for (const mr of await gitlab.settled(gone)) {
          if (seen.changed(mr.iid, { closed: true })) {
            await workflow.emit(mrRun, "mr.closed", { iid: mr.iid, merged: mr.merged });
            seen.record(mr.iid, { closed: true });
          }
        }
        return { mrs: mrs.length };
      },
    },
    prepare: () => null,
  }),
);
