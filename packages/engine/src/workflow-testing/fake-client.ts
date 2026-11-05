// A program's tests' `Client`: keeps the calls it is given and answers as the real one's rules do,
// or as the test scripts. No run, file or process is touched.
import { isAbsolute } from "node:path";
import {
  type Client,
  ClientError,
  type Run,
  type RunStatus,
  type StartResult,
} from "@agentswf/contract/client";
import type { EmitResultJson, InboxItemJson } from "@agentswf/contract/records";
import {
  awfEventOf,
  isEventWorkflow,
  isJsonValue,
  type JsonValue,
  nameProblem,
} from "@agentswf/contract/workflow";
import { canonical } from "../canonical-json";
import { checkEvent, EmitError } from "../emit";
import { idProblem } from "../runs";
import type { AnyWorkflow, EventWorkflow } from "../workflow-loader";

/** A call a fake client was given, in order, whether or not it was refused. */
export type FakeClientCall =
  | {
      kind: "emit";
      workflow: string;
      /** `{workflow}/{id}`. */
      ref: string;
      name: string;
      data: JsonValue;
      eventId?: string;
      source?: string;
    }
  /** `ref` names the run `id`, `id(args)` or the fake named; absent when none could be named. */
  | { kind: "start"; workflow: string; ref?: string; args: JsonValue }
  | { kind: "get"; workflow: string; ref: string }
  | { kind: "inbox"; workflow: string; after?: string };

/** What a test scripts; anything it leaves out is answered as the real client's rules would. */
export type FakeClientScript = {
  /**
   * What became of an emit, for the call given, in place of what the rules would say; undefined
   * answers by the rules. `why` alone means nothing was done (`did: "none"`). What it says is what
   * the fake then knows: a refused or duplicate event leaves no new run, a `launch-failed` a run
   * not launched, a `stuck` one stuck.
   */
  emit?: (
    call: Extract<FakeClientCall, { kind: "emit" }>,
  ) => Partial<Pick<EmitResultJson, "outcome" | "did" | "why" | "error">> | undefined;
  /** A start's `did` and `error`, for the call given; undefined answers by the rules. */
  start?: (
    call: Extract<FakeClientCall, { kind: "start" }> & { ref: string },
  ) => Pick<StartResult<JsonValue>, "did" | "error"> | undefined;
  /**
   * By ref: the rests the run comes to, in order. A wait takes the next one, as the run's next rest
   * after the call; a run that isn't running, by the last one taken, is answered at once, as the
   * real client does. Its status is the last one taken; an emit or start that launches it makes it
   * `running` again, and a launch that fails leaves it at its last rest, or `interrupted` (`stuck`
   * after three) if it has none. Attempts that fail or crash count toward `stuck` only as the rests
   * scripted say. A run named here is there: `get` and `emit` find it, and the first `start` of it is the one that made it,
   * unless an emit reached it first.
   */
  rests?: Record<string, RunStatus<JsonValue>[]>;
  /** What `inbox` returns, for the call given. */
  inbox?: (call: Extract<FakeClientCall, { kind: "inbox" }>) => InboxItemJson[];
};

export type FakeClient = Client & {
  /** Every call, in the order given. */
  readonly calls: FakeClientCall[];
};

/** A run the fake knows: begun by an event or a start, launched or not, and what it took. */
type Known = {
  /** The args it was started with; absent for one an event began. */
  args?: JsonValue;
  /** Whether an attempt was ever launched: until then, a wake `started` it, after, `continued`. */
  attempted: boolean;
  /** Launches that failed in a row: three make it stuck, as the real rule does. */
  failed: number;
  /** The last rest a wait took. */
  rest?: RunStatus<JsonValue>;
  /** Named only by `rests`: the first start of it is the one that made it. */
  scripted?: true;
  eventIds: Set<string>;
  status: RunStatus<JsonValue>;
  rests: RunStatus<JsonValue>[];
};

const RUNNING: RunStatus<JsonValue> = { state: "running", final: false };

/**
 * A `Client` for a program's tests, as `testWorkflow` is for a workflow's: it runs the real
 * client's checks on what it is given, so a test sees the `ClientError` the real one throws, and
 * keeps its calls. Unscripted, it answers as the real rules do: an event to a new id is `started`
 * if it may start a run and refused `not-a-start` if not; to a run there, `refused` `returned` for
 * one that completed (`none`, `returned`, if resent), and otherwise woken as the real `wake` does, a `duplicate` for an event id it
 * has: `started` for a run whose launch failed (`stuck` after three), `nudged` while running,
 * `continued` once parked, failed or crashed, nothing for one stopped, cancelled or stuck; a reply
 * to no run throws `no-run`; a start is `started` for a new id, `exists` for one there with the same args, and
 * `other-args` for other args, or a run an event began.
 */
export function fakeClient(script: FakeClientScript = {}): FakeClient {
  const calls: FakeClientCall[] = [];
  const known = new Map<string, Known>();
  const fresh = (args?: JsonValue): Known => ({
    ...(args === undefined ? {} : { args }),
    attempted: true,
    failed: 0,
    eventIds: new Set(),
    status: RUNNING,
    rests: [],
  });
  for (const [ref, rests] of Object.entries(script.rests ?? {}))
    known.set(ref, { ...fresh(), rests: [...rests], scripted: true });

  const handle = (ref: string): Run<never> => {
    const run = known.get(ref)!;
    const made: Run<JsonValue> = {
      id: ref.slice(ref.indexOf("/") + 1),
      ref,
      status: async () => run.status,
      wait: async (options = {}) => {
        options.signal?.throwIfAborted();
        if (options.final ? run.status.final : run.status.state !== "running") return run.status;
        for (let next = run.rests.shift(); next; next = run.rests.shift()) {
          run.status = next;
          run.rest = next;
          if (!options.final || next.final) return next;
        }
        const { signal } = options;
        if (!signal)
          throw new Error(
            `fakeClient: ${ref} has no rest scripted for this wait, and no signal ends it`,
          );
        return new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      },
    };
    return made as Run<never>;
  };

  /** What the real `wake` does to a run in this state: start, nudge, continue, or nothing. */
  const wake = (
    run: Known,
    duplicate: boolean,
  ): Pick<EmitResultJson, "did"> & Partial<Pick<EmitResultJson, "why">> => {
    if (run.failed >= 3) return { did: "none", why: "stuck" };
    if (!run.attempted) return { did: "started" };
    switch (run.status.state) {
      case "running":
        return duplicate ? { did: "none" } : { did: "nudged" };
      case "completed":
        return { did: "none", why: "returned" };
      case "stopped":
      case "cancelled":
      case "stuck":
        return { did: "none", why: run.status.state };
      default:
        // Parked, failed, timed-out or interrupted: continued. A parked run whose wait doesn't take
        // the event is `nothing-due` to the real client; script that.
        return { did: "continued" };
    }
  };

  /** What the real client then reads of a run whose launch just failed. */
  const launchFailed = (run: Known, events: boolean, stuck: boolean): void => {
    run.failed = stuck ? Math.max(run.failed, 3) : run.failed + 1;
    if (run.failed >= 3) run.status = { state: "stuck", final: true };
    else if (!run.attempted) run.status = { state: "interrupted", final: !events };
    else if (run.rest) run.status = run.rest;
  };
  const launchedNow = (run: Known): void => {
    run.attempted = true;
    run.failed = 0;
    run.status = RUNNING;
  };

  /** The real client's checks of a workflow it is given that need no file: its `file` and name. */
  const located = (workflow: AnyWorkflow): string => {
    const name = workflow?.meta?.name;
    if (typeof workflow?.file !== "string" || !isAbsolute(workflow.file))
      throw new ClientError("file", `${name} gives no file: file: import.meta.path`);
    const problem = idProblem(name);
    if (problem) throw new ClientError("event", `meta.name: ${problem}`);
    return name;
  };

  const client: Client = {
    emit: async (workflow, run, name, data, given = {}) => {
      const target = workflow as unknown as EventWorkflow;
      const ref = `${target?.meta?.name}/${run}`;
      const call = {
        kind: "emit" as const,
        workflow: target?.meta?.name,
        ref,
        name,
        data: data as JsonValue,
        ...(given.eventId === undefined ? {} : { eventId: given.eventId }),
        ...(given.source === undefined ? {} : { source: given.source }),
      };
      calls.push(call);
      if (!isEventWorkflow(target))
        throw new ClientError(
          "event",
          `${(target as AnyWorkflow)?.meta?.name} declares no events; start runs it`,
        );
      located(target);
      if (typeof name !== "string")
        throw new ClientError("event", "an event's name is a string", ref);
      if (typeof run !== "string") throw new ClientError("id", "a run's id is a string");
      for (const [field, value] of [
        ["eventId", given.eventId],
        ["source", given.source],
      ] as const)
        if (value !== undefined && typeof value !== "string")
          throw new ClientError(field === "eventId" ? "id" : "event", `${field} is a string`, ref);
      const reply = awfEventOf(name)?.kind === "reply";
      try {
        checkEvent(
          target,
          { name, data: call.data, ...(given.eventId === undefined ? {} : { id: given.eventId }) },
          reply,
        );
      } catch (error) {
        if (error instanceof EmitError) throw new ClientError(error.code, error.message, ref);
        throw error;
      }
      const sourceProblem = () => {
        if (given.source === undefined) return;
        const bad = nameProblem(given.source);
        if (bad)
          throw new ClientError("event", `the source ${JSON.stringify(given.source)}: ${bad}`, ref);
      };
      if (!reply) sourceProblem();
      const problem = idProblem(run);
      if (problem) throw new ClientError("id", `the run's id: ${problem}`, ref);
      const result = (fields: Omit<EmitResultJson, "v" | "ref" | "eventId">): EmitResultJson => ({
        v: 1,
        ref,
        eventId: given.eventId ?? `awf.fake${calls.length}`,
        ...fields,
      });
      let state = known.get(ref);
      if (!state && reply)
        throw new ClientError("no-run", `no run ${ref}: a reply never starts one`, ref);
      if (reply) sourceProblem();
      const duplicate =
        state !== undefined && given.eventId !== undefined && state.eventIds.has(given.eventId);
      let made = false;
      let answer: Omit<EmitResultJson, "v" | "ref" | "eventId">;
      if (!duplicate && state?.status.state === "completed")
        answer = { outcome: "refused", did: "none", why: "returned" };
      else if (!state && !(target.starts?.includes(name) ?? true))
        answer = { outcome: "refused", did: "none", why: "not-a-start" };
      else {
        if (!state) {
          // As the real client checks before it makes the run: what `prepare` makes of no argv.
          try {
            target.prepare({ argv: [], cwd: "/" });
          } catch (error) {
            throw new ClientError(
              "prepare",
              `${target.meta.name}: a run an event starts has no arguments, which its prepare refuses: ${String(error)}`,
              ref,
            );
          }
          state = { ...fresh(), attempted: false };
          made = true;
        }
        // A duplicate isn't appended, but wakes the run, as a retry after a failed launch does;
        // a live run has it already, and isn't nudged.
        answer = { outcome: duplicate ? "duplicate" : "accepted", ...wake(state, duplicate) };
      }
      const scripted = script.emit?.(call);
      if (scripted) {
        answer = { ...answer, ...scripted };
        if (scripted.why !== undefined && scripted.did === undefined) answer.did = "none";
        if (scripted.why === undefined && scripted.did !== undefined && scripted.did !== "none")
          delete answer.why;
      }
      if (!state || answer.outcome === "refused" || (made && answer.outcome === "duplicate"))
        return result(answer);
      if (made) known.set(ref, state);
      delete state.scripted;
      if (given.eventId !== undefined) state.eventIds.add(given.eventId);
      if (answer.did === "started" || answer.did === "continued") launchedNow(state);
      else if (answer.why === "launch-failed" || answer.why === "stuck")
        launchFailed(state, true, answer.why === "stuck");
      return result(answer);
    },
    start: async (workflow, args, given = {}) => {
      const target = workflow as unknown as AnyWorkflow;
      const call: Extract<FakeClientCall, { kind: "start" }> = {
        kind: "start",
        workflow: target?.meta?.name,
        args: args as JsonValue,
      };
      calls.push(call);
      const name = located(target);
      if (!isJsonValue(args))
        throw new ClientError("prepare", `${name} arguments must contain only JSON values`);
      let id = given.id;
      if (id === undefined && target.id) {
        let derived: unknown;
        try {
          derived = target.id(args as never);
        } catch (error) {
          throw new ClientError("prepare", `${name}'s id(args) failed: ${String(error)}`);
        }
        if (typeof derived !== "string")
          throw new ClientError("id", `${name}'s id(args) returned a ${typeof derived}`);
        id = derived;
      }
      if (id === undefined && isEventWorkflow(target) && target.starts !== undefined)
        throw new ClientError(
          "no-id",
          `a run of ${name}, which starts on events, is named by its senders`,
        );
      // As the real client generates one: an id no run here holds.
      for (let n = 1; id === undefined; n++) if (!known.has(`${name}/fake-${n}`)) id = `fake-${n}`;
      const ref = `${name}/${id}`;
      call.ref = ref;
      const problem = idProblem(id);
      if (problem) throw new ClientError("id", `the run's id: ${problem}`, ref);
      let there = known.get(ref);
      if (there?.scripted && !("args" in there)) {
        there.args = call.args;
        delete there.scripted;
        there = undefined;
      }
      if (there) {
        if (
          !("args" in there) ||
          JSON.stringify(canonical(there.args as JsonValue)) !==
            JSON.stringify(canonical(call.args))
        )
          throw new ClientError(
            "other-args",
            `${ref} is there already, with other args or none recorded`,
            ref,
          );
        if (there.attempted) return { run: handle(ref), did: "exists" };
        if (there.failed >= 3) return { run: handle(ref), did: "stuck" };
      } else if (!known.has(ref)) known.set(ref, fresh(call.args));
      const run = known.get(ref)!;
      const answer = {
        run: handle(ref),
        did: there ? "exists" : "started",
        ...script.start?.({ ...call, ref }),
      } as StartResult<never>;
      if (answer.did === "launch-failed" || answer.did === "stuck") {
        if (!there) run.attempted = false;
        launchFailed(run, isEventWorkflow(target), answer.did === "stuck");
      } else launchedNow(run);
      return answer;
    },
    get: async (workflow, run) => {
      const ref = `${(workflow as unknown as AnyWorkflow)?.meta?.name}/${run}`;
      calls.push({ kind: "get", workflow: (workflow as unknown as AnyWorkflow)?.meta?.name, ref });
      located(workflow as unknown as AnyWorkflow);
      const problem = idProblem(run);
      if (problem) throw new ClientError("id", `the run's id: ${problem}`, ref);
      if (!known.has(ref)) throw new ClientError("no-run", `no run ${ref}`, ref);
      return handle(ref);
    },
    inbox: async (workflow, given = {}) => {
      const call = {
        kind: "inbox" as const,
        workflow: (workflow as unknown as AnyWorkflow)?.meta?.name,
        ...(given.after === undefined ? {} : { after: given.after }),
      };
      calls.push(call);
      located(workflow as unknown as AnyWorkflow);
      const { after } = given;
      if (
        after !== undefined &&
        (typeof after !== "string" || after === "" || after.startsWith("-"))
      )
        throw new ClientError("cursor", `${JSON.stringify(after)} is no cursor an item carried`);
      return script.inbox?.(call) ?? [];
    },
  };
  return Object.assign(client, { calls });
}
