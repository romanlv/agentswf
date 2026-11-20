import { type EnvValue, TRIAL_ENV, type TrialSettings } from "../format/trial-env";
import type { DatasetError, Phase } from "../format/trial-file";
import { type Case, makeCase } from "./case";
import { fileOf, Mocks } from "./mock";
import { copiedModule, missingStageNames } from "./sources";
import { shared, trialParams, trialSettings, writeLine } from "./state";

export {
  type Capture,
  type CapturedCase,
  type CapturedRun,
  defineCapture,
} from "./capture";
export type { Case, Faked, Spies, Spy } from "./case";
export {
  better,
  type CaseComparison,
  type ComparedTrial,
  type ComparisonCall,
  defineComparison,
  type MetricOptions,
  type Verdict,
} from "./compare";
export { type GradeCase, gradeCase } from "./grade-case";
export {
  type CodeGrader,
  defineGrader,
  type FactsInput,
  type Grade,
  type GradeInput,
  type GradeNumber,
} from "./grader";
export type { RouteHandler } from "./routes";
export type { HttpRequest } from "./state";

/** One fact `observe` returns for the key's `expect`: a flat value. */
export type Fact = string | number | boolean | null;
/** `undefined` is allowed here and refused at run time (`facts-missing`), so branches may differ. */
export type Facts = Record<string, Fact | undefined>;

/** A stage's value given by the case: called when the stage is entered, in place of its work. */
export type GivenStages = Record<string, () => unknown>;

/**
 * What `setup` returns. One shape, not a union on `until`: TypeScript can't pick a union's member
 * for an async `setup` that leaves `until` out, and `observe`'s `result` would be `any`. So under
 * `until`, where `result` is `null`, `observe` says so itself: `observe(result: Result | null, …)`.
 */
export type Setup<R> = {
  /**
   * Called once the body returned or reached `until`: the facts the key's `expect` checks, read
   * from the result, the stages' values and what the mocks recorded. It never asserts.
   */
  observe(result: R, context: { stages: Partial<Record<string, unknown>> }): Facts | Promise<Facts>;
  /** The workflow's arguments, as `awf run … -- {argv}` would give them. */
  argv?: readonly string[];
  /** Stages given their value: their own work is not run. */
  stages?: GivenStages;
  /** Stop once this stage has returned; `result` is `null` then. */
  until?: string;
};

// Structural, never the lab's own `agentswf` types: a project's copy brands them apart.
// biome-ignore lint/suspicious/noExplicitAny: any workflow's `run`, whatever its context and args.
type WorkflowModule = { default: { run(...args: any[]): Promise<unknown> } };
// biome-ignore lint/suspicious/noExplicitAny: any workflow's `run`, whatever its context and args.
type ResultOf<M> = M extends { default: { run(...args: any[]): Promise<infer R> } } ? R : unknown;

export type EnvSpec<M extends WorkflowModule> = {
  /** The workflow as it ships, imported lazily so the mocks exist before it loads. */
  workflow: (c: Case) => Promise<M>;
  /** Builds the case's world, and returns what the run needs. */
  setup: (c: Case) => Setup<ResultOf<M>> | Promise<Setup<ResultOf<M>>>;
};

/** The workflow `defineEnv` makes, which `awf run` loads; opaque to `env.ts`. */
export type CaseEnv = { readonly kind: string; readonly meta: { readonly name: string } };

const NOT_IN_A_TRIAL = `this is a case environment, run by awf-lab: \`awf-lab run\` in the project runs its cases, and sets ${TRIAL_ENV.case} and the rest for each trial`;

/** A case's world for one workflow, as `env.ts`'s default export. */
export function defineEnv<M extends WorkflowModule>(spec: EnvSpec<M>): CaseEnv {
  const dataset = trialSettings()?.dataset;
  return defineWorkflow({
    meta: {
      name: dataset ? `case-env-${dataset}` : "case-env",
      description: "Runs a workflow on one case of an awf-lab dataset.",
    },
    prepare: () => {
      if (!process.env[TRIAL_ENV.case] || !trialSettings()) throw new Error(NOT_IN_A_TRIAL);
      return null;
    },
    // biome-ignore lint/suspicious/noExplicitAny: the engine's context, typed structurally here.
    run: async (wf: any) => (await runInTrial(spec, wf)) as never,
  }) as CaseEnv;
}

/**
 * The running engine's `defineWorkflow`, which its loader serves to every importer. Required, not
 * imported: an import would lead a project's type check into the lab's own `agentswf`, the same
 * name and version as the project's, and TypeScript then mixes the two copies' types.
 */
function defineWorkflow(definition: unknown): unknown {
  const surface: {
    defineWorkflow: (definition: unknown) => unknown;
  } = require("agentswf/workflow");
  return surface.defineWorkflow(definition);
}

// The engine's context, as far as `defineEnv` uses it.
type EngineContext = {
  readonly cwd: string;
  readonly deadline?: Date;
  stage(name: string, ...rest: unknown[]): Promise<unknown>;
};

type InnerWorkflow = {
  meta?: { name?: string; version?: string };
  events?: unknown;
  prepare?: (invocation: { argv: readonly string[]; cwd: string }) => unknown;
  run(context: unknown, args: unknown): Promise<unknown>;
};

class TimedOut extends Error {
  constructor(readonly phase: Phase) {
    super(`timed out in ${phase}`);
  }
}

/** Thrown by the lab's `stage` once `until` returned; any ending of the body after it is a reach. */
class UntilReached extends Error {
  constructor(stage: string) {
    super(`the case stops once ${stage} returned`);
    this.name = "UntilReached";
  }
}

/** A failure that is the dataset's, by its code. */
class DatasetFailure extends Error {
  constructor(
    readonly code: DatasetError | undefined,
    reason: string,
  ) {
    super(reason);
  }
}

// What a phase stops short of the run's deadline by, so teardown runs before the engine's backstop.
const DEADLINE_RESERVE_MS = 10_000;
// An exit this close to the run's deadline, or past it, is the engine's backstop.
const EXIT_SLACK_MS = 1_000;

const isStop = (error: unknown) => error instanceof Error && error.name === "WorkflowStopped";
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

class Trial {
  readonly #cleanups: (() => unknown)[];
  #ended = false;
  #cancelled = false;
  #tornDown: Promise<void> | undefined;

  constructor(
    readonly settings: TrialSettings,
    readonly deadline: Date | undefined,
    cleanups: (() => unknown)[],
  ) {
    this.#cleanups = cleanups;
    // The engine's `--timeout` abandons the body and exits after its grace, sending no signal:
    // only a synchronous `exit` handler runs then. Any other exit before the trial ended, a
    // `process.exit` or a crash, is no timeout.
    process.on("exit", () => {
      if (this.#ended) return;
      if (!this.#cancelled) {
        const late =
          this.deadline !== undefined && Date.now() >= this.deadline.getTime() - EXIT_SLACK_MS;
        writeLine(late ? { timedOut: shared().phase } : { exited: shared().phase });
      }
      if (this.#tornDown) return;
      for (const cleanup of this.#cleanups.toReversed()) {
        try {
          cleanup();
        } catch {
          // The process is ending: what teardown managed is all it gets.
        }
      }
    });
    // A cancel: the engine exits after its grace, so teardown starts at once.
    const cancel = () => {
      if (this.#ended || this.#cancelled) return;
      this.#cancelled = true;
      writeLine({ cancelled: shared().phase });
      void this.teardown(this.settings.setupTimeoutMs).then(() => {
        shared().closed = true;
        this.end();
      });
    };
    process.once("SIGTERM", cancel);
    process.once("SIGINT", cancel);
  }

  enter(phase: Phase): void {
    shared().phase = phase;
    writeLine({ phase });
  }

  /** A timer for a phase, at its limit or short of the run's deadline, whichever comes first. */
  timer(phase: Phase, ms: number, reserve = DEADLINE_RESERVE_MS) {
    const left = this.deadline ? this.deadline.getTime() - Date.now() - reserve : ms;
    let handle: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      handle = setTimeout(() => reject(new TimedOut(phase)), Math.max(0, Math.min(ms, left)));
    });
    expired.catch(() => {});
    const started = Date.now();
    return {
      race: <T>(work: Promise<T>): Promise<T> => Promise.race([work, expired]),
      left: () => ms - (Date.now() - started),
      clear: () => clearTimeout(handle),
    };
  }

  /** Writes how the trial failed, runs teardown, and throws: the run fails. */
  async fail(error: unknown, by: "dataset" | "workflow", code?: DatasetError): Promise<never> {
    if (error instanceof TimedOut) {
      writeLine({ timedOut: error.phase });
      await this.teardown(this.settings.setupTimeoutMs);
      shared().closed = true;
      this.end();
      throw error;
    }
    const failure = error instanceof DatasetFailure ? error : undefined;
    const reason = messageOf(error);
    writeLine({
      error: {
        by: failure ? "dataset" : by,
        phase: shared().phase,
        ...((failure?.code ?? code) ? { code: failure?.code ?? code } : {}),
        reason,
      },
    });
    await this.teardown(this.settings.setupTimeoutMs);
    this.end();
    throw error;
  }

  teardown(ms: number): Promise<void> {
    this.#tornDown ??= (async () => {
      this.enter("teardown");
      const timer = this.timer("teardown", ms, 1_000);
      try {
        await timer.race(runCleanups(this.#cleanups));
      } catch (error) {
        if (error instanceof TimedOut) writeLine({ timedOut: "teardown" });
        else {
          writeLine({
            error: { by: "dataset", phase: "teardown", code: "threw", reason: messageOf(error) },
          });
        }
      } finally {
        timer.clear();
      }
    })();
    return this.#tornDown;
  }

  end(): void {
    this.#ended = true;
  }
}

async function runCleanups(cleanups: readonly (() => unknown)[]): Promise<void> {
  let first: unknown;
  for (const cleanup of cleanups.toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      first ??= error;
    }
  }
  if (first !== undefined) throw first;
}

async function runInTrial<M extends WorkflowModule>(
  spec: EnvSpec<M>,
  wf: EngineContext,
): Promise<EnvValue> {
  const settings = trialSettings();
  const caseDir = process.env[TRIAL_ENV.case];
  if (!settings || !caseDir) throw new Error(NOT_IN_A_TRIAL);
  const state = shared();
  const mocks = new Mocks();
  const cleanups: (() => unknown)[] = [];
  const trial = new Trial(settings, wf.deadline, cleanups);
  const folders = {
    dir: caseDir,
    scratch: process.env[TRIAL_ENV.scratch] ?? wf.cwd,
    root: process.env[TRIAL_ENV.root] ?? process.cwd(),
    params: trialParams(),
  };

  trial.enter("setup");
  const loadedBefore = new Set(Object.keys(require.cache));
  let setup: Setup<unknown>;
  const c = makeCase(folders, mocks, cleanups);
  const setupTimer = trial.timer("setup", settings.setupTimeoutMs);
  try {
    setup = await setupTimer.race(Promise.resolve().then(() => spec.setup(c)));
  } catch (error) {
    return trial.fail(error, "dataset", "threw");
  } finally {
    setupTimer.clear();
  }
  if (typeof setup !== "object" || setup === null || typeof setup.observe !== "function") {
    return trial.fail(
      new DatasetFailure("no-observe", "setup returned no observe: return { observe }"),
      "dataset",
    );
  }
  const given = setup.stages ?? {};
  const until = setup.until;

  trial.enter("body");
  const body = trial.timer("body", settings.timeoutMs);
  let module: unknown;
  try {
    module = await body.race(Promise.resolve().then(() => spec.workflow(c)));
  } catch (error) {
    body.clear();
    const missing =
      (error as { code?: unknown })?.code === "ERR_MODULE_NOT_FOUND" &&
      loadedBefore.has(String((error as { referrer?: unknown }).referrer));
    return missing
      ? trial.fail(new DatasetFailure("workflow-missing", messageOf(error)), "dataset")
      : trial.fail(error, "workflow");
  }
  const inner = (module as { default?: unknown } | undefined)?.default as InnerWorkflow | undefined;
  const refuse = (code: DatasetError | undefined, reason: string) => {
    body.clear();
    return trial.fail(new DatasetFailure(code, reason), "dataset");
  };
  if (typeof inner !== "object" || inner === null || typeof inner.run !== "function") {
    return refuse("workflow-missing", "the module workflow(c) imported exports no workflow");
  }
  writeLine({
    workflow: {
      name: inner.meta?.name ?? "",
      ...(inner.meta?.version ? { version: inner.meta.version } : {}),
    },
  });
  const file = module && typeof module === "object" ? fileOf(module) : undefined;
  if (file && loadedBefore.has(file)) {
    return refuse(
      "workflow-loaded-early",
      `${file} was loaded before setup, so mocks missed what it took as it loaded: env.ts reaches the workflow only through its lazy workflow import, and imports its types with import type`,
    );
  }
  if (inner.events !== undefined) {
    return refuse("events", "a workflow with events can't be run on a case");
  }
  const copied = copiedModule(mocks.files, folders.root, folders.scratch);
  if (copied) {
    return refuse(undefined, `mocked ${copied} in your checkout; the workflow loads the copy`);
  }
  const named = [...Object.keys(given), ...(until !== undefined ? [until] : [])];
  if (file) {
    const missing = missingStageNames(named, file, loadedBefore, settings.datasetDir);
    if (missing.length > 0) {
      return refuse(
        "stage-missing",
        `no stage ${missing.join(", ")} in the workflow's source: check the name in stages or until`,
      );
    }
  }
  let args: unknown = null;
  try {
    args = inner.prepare ? inner.prepare({ argv: setup.argv ?? [], cwd: wf.cwd }) : null;
  } catch (error) {
    return refuse("prepare", `the workflow's prepare refused the case's argv: ${messageOf(error)}`);
  }

  const reached = {
    until: false,
    entered: new Set<string>(),
    values: {} as Record<string, unknown>,
  };
  let givenProblem: DatasetFailure | undefined;
  const stage = async (name: string, ...rest: unknown[]) => {
    if (reached.until && until !== undefined) throw new UntilReached(until);
    reached.entered.add(name);
    const give = Object.hasOwn(given, name) ? given[name] : undefined;
    const work = give
      ? async () => {
          try {
            return await give();
          } catch (error) {
            givenProblem ??= new DatasetFailure(
              "threw",
              `the value given for ${name} threw: ${messageOf(error)}`,
            );
            throw error;
          }
        }
      : rest.at(-1);
    let value: unknown;
    try {
      value = await wf.stage(name, ...rest.slice(0, -1), work);
    } catch (error) {
      if (give && !isStop(error)) {
        givenProblem ??= new DatasetFailure(
          "given-refused",
          `${name} refused the value the case gave it: ${messageOf(error)}`,
        );
      }
      throw error;
    }
    // A stage with no result is `undefined`, which a run's value can't hold.
    if (value !== undefined) reached.values[name] = value;
    if (name === until) {
      reached.until = true;
      throw new UntilReached(name);
    }
    return value;
  };
  const labWf = Object.create(wf, { stage: { value: stage } });

  let ending: { returned: unknown } | { threw: unknown };
  try {
    ending = { returned: await body.race(Promise.resolve().then(() => inner.run(labWf, args))) };
  } catch (error) {
    if (error instanceof TimedOut) return trial.fail(error, "workflow");
    ending = { threw: error };
  } finally {
    body.clear();
  }
  if (givenProblem) return trial.fail(givenProblem, "dataset");

  const unused = () => [
    ...mocks.unused(),
    ...state.routes.filter((route) => route.calls === 0).map((route) => route.key),
  ];
  let refusedWritten = false;
  const writeRefused = () => {
    const first = state.refused[0];
    if (refusedWritten || !first) return;
    refusedWritten = true;
    writeLine({
      error: { by: "dataset", phase: first.phase, code: "refused", reason: first.message },
    });
  };
  writeRefused();
  const stop = "threw" in ending && isStop(ending.threw) ? (ending.threw as Error) : undefined;
  if (!reached.until && "threw" in ending) {
    if (stop) writeLine({ stopped: { reason: stop.message } });
    else if (!refusedWritten) {
      writeLine({ error: { by: "workflow", phase: "body", reason: messageOf(ending.threw) } });
    }
    writeLine({ unused: unused() });
    await trial.teardown(settings.setupTimeoutMs);
    trial.end();
    throw ending.threw;
  }

  const result = reached.until ? null : (ending as { returned: unknown }).returned;
  trial.enter("observe");
  const observeTimer = trial.timer("observe", settings.setupTimeoutMs);
  let observed: Facts;
  try {
    observed = await observeTimer.race(
      Promise.resolve().then(() => setup.observe(result, { stages: { ...reached.values } })),
    );
  } catch (error) {
    observeTimer.clear();
    return trial.fail(error, "dataset", "threw");
  }
  observeTimer.clear();
  const problem = factsProblem(observed);
  if (problem) return trial.fail(problem, "dataset");
  const facts = observed as Record<string, Fact>;
  writeRefused();

  const neverReached = named.filter((name) => !reached.entered.has(name));
  const unusedNow = unused();
  writeLine({ unused: unusedNow });
  writeLine({
    end: {
      facts,
      stages: reached.values,
      given: Object.keys(given),
      ...(reached.until && until !== undefined ? { until } : {}),
      ...(neverReached.length > 0 ? { neverReached } : {}),
    },
  });
  if (stop) writeLine({ stopped: { reason: stop.message } });
  await trial.teardown(Math.max(observeTimer.left(), 1_000));
  trial.end();
  if (stop) throw stop;
  return {
    workflow: {
      name: inner.meta?.name ?? "",
      ...(inner.meta?.version ? { version: inner.meta.version } : {}),
    },
    result: result ?? null,
    facts,
    stages: reached.values,
    given: Object.keys(given),
    unused: unusedNow,
    refused: state.refused,
  };
}

function factsProblem(facts: unknown): DatasetFailure | undefined {
  if (typeof facts !== "object" || facts === null || Array.isArray(facts)) {
    return new DatasetFailure("fact-type", "observe returned no object of facts");
  }
  const entries = Object.entries(facts);
  const missing = entries.filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length > 0) {
    return new DatasetFailure(
      "facts-missing",
      `fact ${missing.join(", ")} is undefined: return null where the workflow gave nothing`,
    );
  }
  for (const [name, value] of entries) {
    const flat =
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value));
    if (!flat) {
      const kind = Array.isArray(value)
        ? "an array"
        : value instanceof Date
          ? "a Date"
          : typeof value;
      return new DatasetFailure(
        "fact-type",
        `fact ${name} is ${kind}: a fact is a string, a number, a boolean or null`,
      );
    }
  }
  return undefined;
}
