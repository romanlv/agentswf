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
      /** `{workflow}/{id}`. */
      ref: string;
      name: string;
      data: JsonValue;
      eventId?: string;
      source?: string;
    }
  /** `ref` names the run `id`, `id(args)` or the fake named; absent when none could be named. */
  | { kind: "start"; workflow: string; ref?: string; args: JsonValue }
  | { kind: "get"; ref: string }
  | { kind: "inbox"; workflow: string; after?: string };

/** What a test scripts; anything it leaves out is answered as the real client's rules would. */
export type FakeClientScript = {
  /** An emit's result, for the call given; undefined answers by the rules. */
  emit?: (call: Extract<FakeClientCall, { kind: "emit" }>) => Partial<EmitResultJson> | undefined;
  /** A start's `did` and `error`, for the call given; undefined answers by the rules. */
  start?: (
    call: Extract<FakeClientCall, { kind: "start" }> & { ref: string },
  ) => Pick<StartResult<JsonValue>, "did" | "error"> | undefined;
  /**
   * By ref: the rests the run comes to, in order. A wait takes the next one, as the run's next rest
   * after the call; a run that isn't running, by the last one taken, is answered at once, as the
   * real client does. Its status is the last one taken. A run named here is there.
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
  /** False after a launch that failed, until one doesn't. */
  launched: boolean;
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
 * if it may start a run and refused `not-a-start` if not; to a run there, a `duplicate` for an
 * event id it has, `refused` `returned` for a run that completed, `started` for one whose launch
 * failed, `continued` for one at rest and `nudged` for a live one; a reply to no run throws
 * `no-run`; a start is `started` for a new id, `exists` for one there with the same args, and
 * `other-args` for other args, or a run an event began.
 */
export function fakeClient(script: FakeClientScript = {}): FakeClient {
  const calls: FakeClientCall[] = [];
  const known = new Map<string, Known>();
  const fresh = (args?: JsonValue): Known => ({
    ...(args === undefined ? {} : { args }),
    launched: true,
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
      const badSource = given.source === undefined ? undefined : nameProblem(given.source);
      if (badSource)
        throw new ClientError(
          "event",
          `the source ${JSON.stringify(given.source)}: ${badSource}`,
          ref,
        );
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
      if (state && given.eventId !== undefined && state.eventIds.has(given.eventId))
        return result({ outcome: "duplicate", did: "none" });
      if (state?.status.state === "completed")
        return result({ outcome: "refused", did: "none", why: "returned" });
      if (!state) {
        if (!(target.starts?.includes(name) ?? true))
          return result({ outcome: "refused", did: "none", why: "not-a-start" });
        state = { ...fresh(), launched: false };
        known.set(ref, state);
      }
      if (given.eventId !== undefined) state.eventIds.add(given.eventId);
      const did = !state.launched
        ? "started"
        : state.status.state === "running"
          ? "nudged"
          : "continued";
      const answer = result({ outcome: "accepted", did, ...script.emit?.(call) });
      state.launched = answer.why !== "launch-failed";
      if (did === "continued" && state.launched) state.status = RUNNING;
      return answer;
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
        if (there.launched) return { run: handle(ref), did: "exists" };
      } else if (!known.has(ref)) known.set(ref, fresh(call.args));
      const run = known.get(ref)!;
      const answer = {
        run: handle(ref),
        did: there ? "exists" : "started",
        ...script.start?.({ ...call, ref }),
      } as StartResult<never>;
      run.launched = answer.did !== "launch-failed";
      return answer;
    },
    get: async (workflow, run) => {
      const ref = `${(workflow as unknown as AnyWorkflow)?.meta?.name}/${run}`;
      calls.push({ kind: "get", ref });
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
      if (after !== undefined && (after === "" || after.startsWith("-")))
        throw new ClientError("cursor", `${JSON.stringify(after)} is no cursor an item carried`);
      return script.inbox?.(call) ?? [];
    },
  };
  return Object.assign(client, { calls });
}
