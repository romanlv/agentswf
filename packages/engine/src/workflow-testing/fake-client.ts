// A program's tests' `Client`: keeps the calls it is given and answers as the real one's rules do,
// or as the test scripts. It makes no run and starts no process.
import { dirname } from "node:path";
import {
  type Client,
  ClientError,
  type Run,
  type RunStatus,
  type StartResult,
} from "@agentswf/contract/client";
import { type EmitResultJson, emitOk, type InboxItemJson } from "@agentswf/contract/records";
import {
  awfEventOf,
  isEventWorkflow,
  type JsonValue,
  nameProblem,
} from "@agentswf/contract/workflow";
import { canonical } from "../canonical-json";
import {
  assertEventWorkflow,
  checkArgs,
  checkCursor,
  checkEmit,
  checkRunId,
  derivedId,
  fileOf,
  nameOf,
} from "../client/checks";
import { isFinal } from "../client/runs";
import { checkEvent, EmitError } from "../emit";
import { messageOf } from "../errors";
import { prepareArgs } from "../run-prepare";
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
  ) => { did: StartResult<JsonValue>["did"]; error?: string } | undefined;
  /**
   * By ref: the rests the run comes to, in order. A wait takes the next one, as the run's next rest
   * after the call; a run that isn't running, by the last one taken, is answered at once, as the
   * real client does. Its status is the last one taken; an emit or start that launches it makes it
   * `running` again, and a launch that fails leaves it at its last rest, or `interrupted` (`stuck`
   * after three) if it has none. Its `final` is the real client's, from its state and whether the
   * workflow takes events, whatever the rest scripted says. A start with no id names its run
   * `fake-1`, `fake-2`, and so on, which this can name. Attempts that fail or crash count toward `stuck` only as the rests
   * scripted say. A run named here is there for `get`; the first `start` or event to
   * reach it, before a wait takes one of its rests, is the one that made it.
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

  /** `final`, as the real client says it: from the state, and whether the run takes events. */
  const handle = (ref: string, events: boolean): Run<never> => {
    const run = known.get(ref)!;
    const now = (): RunStatus<JsonValue> => ({
      ...run.status,
      final: isFinal(run.status.state, events),
    });
    const made: Run<JsonValue> = {
      id: ref.slice(ref.indexOf("/") + 1),
      ref,
      status: async () => now(),
      wait: async (options = {}) => {
        options.signal?.throwIfAborted();
        if (options.final ? now().final : run.status.state !== "running") return now();
        for (let next = run.rests.shift(); next; next = run.rests.shift()) {
          run.status = next;
          run.rest = next;
          if (!options.final || now().final) return now();
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

  /** A run only `rests` names, no wait having taken a rest: the first start of it makes it. */
  const unclaimedByStart = (run: Known): boolean =>
    run.scripted === true && !("args" in run) && run.rest === undefined;

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
    fileOf(workflow);
    return nameOf(workflow);
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
      assertEventWorkflow(target);
      located(target);
      checkEmit(ref, run, name, data, given);
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
      checkRunId(run, ref);
      const result = (
        fields: Omit<EmitResultJson, "v" | "ok" | "ref" | "eventId">,
      ): EmitResultJson => ({
        v: 1,
        ok: emitOk(fields.outcome, fields.why),
        ref,
        eventId: given.eventId ?? `awf.fake${calls.length}`,
        ...fields,
      });
      let state = known.get(ref);
      // A run only `rests` names, no wait having taken a rest: its first event is the one that
      // makes it, as a first start is, and its rests are kept.
      const unclaimed = state?.scripted && state.rest === undefined ? state : undefined;
      if (unclaimed) state = undefined;
      if (!state && reply)
        throw new ClientError("no-run", `no run ${ref}: a reply never starts one`, ref);
      if (reply) sourceProblem();
      const duplicate =
        state !== undefined && given.eventId !== undefined && state.eventIds.has(given.eventId);
      let made = false;
      let answer: Omit<EmitResultJson, "v" | "ok" | "ref" | "eventId">;
      if (!duplicate && state?.status.state === "completed")
        answer = { outcome: "refused", did: "none", why: "returned" };
      else if (!state && !(target.starts?.includes(name) ?? true))
        answer = { outcome: "refused", did: "none", why: "not-a-start" };
      else {
        if (!state) {
          // As the real client checks before it makes the run: what `prepare` makes of no argv.
          try {
            prepareArgs(target, [], dirname(target.file!));
          } catch (error) {
            throw new ClientError(
              "prepare",
              `${target.meta.name}: a run an event starts has no arguments, which its prepare refuses: ${messageOf(error)}`,
              ref,
            );
          }
          state = { ...fresh(), attempted: false, rests: unclaimed?.rests ?? [] };
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
      if (made && unclaimed) {
        // Made in place: a handle `get` gave before sees it.
        Object.assign(unclaimed, state);
        state = unclaimed;
      } else if (made) known.set(ref, state);
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
      checkArgs(name, args);
      let id = given.id ?? derivedId(target, args);
      // As the real client generates one: an id no run here holds.
      // A run `rests` names and nothing made yet is the one this start makes.
      for (let n = 1; id === undefined; n++) {
        const there = known.get(`${name}/fake-${n}`);
        if (!there || unclaimedByStart(there)) id = `fake-${n}`;
      }
      const ref = `${name}/${id}`;
      call.ref = ref;
      checkRunId(id, ref);
      let there = known.get(ref);
      if (there && unclaimedByStart(there)) {
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
        if (there.attempted)
          return { ok: true, run: handle(ref, isEventWorkflow(target)), did: "exists" };
        if (there.failed >= 3)
          return { ok: false, run: handle(ref, isEventWorkflow(target)), did: "stuck" };
      } else if (!known.has(ref)) known.set(ref, fresh(call.args));
      const run = known.get(ref)!;
      const did = script.start?.({ ...call, ref }) ?? { did: there ? "exists" : "started" };
      const answer = {
        ok: did.did === "started" || did.did === "exists",
        run: handle(ref, isEventWorkflow(target)),
        ...did,
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
      checkRunId(run, ref);
      if (!known.has(ref)) throw new ClientError("no-run", `no run ${ref}`, ref);
      return handle(ref, isEventWorkflow(workflow as unknown as AnyWorkflow));
    },
    inbox: async (workflow, given = {}) => {
      const call = {
        kind: "inbox" as const,
        workflow: (workflow as unknown as AnyWorkflow)?.meta?.name,
        ...(given.after === undefined ? {} : { after: given.after }),
      };
      calls.push(call);
      located(workflow as unknown as AnyWorkflow);
      checkCursor(given.after);
      return script.inbox?.(call) ?? [];
    },
  };
  return Object.assign(client, { calls });
}
