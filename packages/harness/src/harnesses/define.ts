import type { Billing } from "@agentswf/contract/records";
import type { Effort } from "@agentswf/contract/workflow";
import type { Holding, RunProcess } from "../command";
import type { AllowanceRead } from "../usage/allowance";
import type { SessionRead } from "../usage/records";

export type TurnPlan = {
  argv: string[];
  /** The prompt goes on stdin everywhere: it is the one channel no CLI reinterprets. */
  stdin?: string;
  /** The session this turn runs under, when the plan chose it rather than the harness. */
  sessionId?: string;
};

/** A headless run of the harness's own compaction; see `HarnessSpec.compactHeadless`. */
export type CompactionPlan = TurnPlan &
  Holding & {
    /** What its output says: the summary, `""` where the harness keeps it opaque, or why not. */
    read(stdout: string): { summary: string } | { error: string };
  };

/** The harness's own fork of a session; see `HarnessSpec.forkSession`. */
export type ForkPlan = TurnPlan &
  Holding & {
    /** The new session, and the running total printed with it where there is one; or why not. */
    read(stdout: string): { sessionId: string; costTotal?: number } | { error: string };
    /** What the fork still needs once its process has exited, before anything resumes it. */
    finish?(sessionId: string): Promise<void>;
  };

export type BillingContext = {
  model?: string;
  /** The provider the harness logged, where it logs one. */
  provider?: string;
  /** How the host launches agents, so a status command sees the credentials they get. */
  run: RunProcess;
  /** The operator's own session, whose model awf never learns (ADR 0010). */
  caller: boolean;
};

/** What reading a plan's allowance is given. */
export type AllowanceContext = { run: RunProcess; now: number };

/** One step of driving a fresh pane: text typed, a key pressed, or text awaited on its screen. */
export type PaneStep = { type: string } | { key: string } | { await: string };

/** The model and effort a launch passes; each absent, the harness's own. */
export type LaunchSettings = {
  model?: string;
  /** Absent, the plan passes none and the harness uses its default. */
  effort?: Effort;
};

/**
 * A session id we choose ahead of the first turn, for a harness that will accept one, and the
 * arguments the launch adds, a sandbox's and the agent's skills', which each plan puts where they
 * cannot swallow what follows.
 */
export type TurnContext = LaunchSettings & {
  sessionHint: string;
  launchArgs?: readonly string[];
  /** The agent's harness home, a sandbox's or its own; absent, the operator's. */
  home?: string;
};

export type HarnessSpec = {
  /** The variable the harness sets in its agent's shell to name the native session. */
  sessionEnv?: string;
  /**
   * What a session of this harness sets for the commands it runs, `awf` among them, which an agent
   * must not inherit: it would be told it runs inside that session.
   */
  callingSessionEnv: readonly string[];
  /**
   * The operator's variables that would override the model or effort awf launches it at, which an
   * agent must not inherit: its record would name settings it never ran at.
   */
  settingsEnv: readonly string[];
  /** Credentials that bill per token, which refuse a run: awf runs on subscription logins. */
  meteredCredentials: readonly string[];
  /**
   * Whether the session Herdr reports for its pane is that pane's own. Herdr's codex integration
   * reports from codex's shared daemon, so its session is another pane's (E8).
   */
  herdrSessionIsOwn: boolean;
  /**
   * A retained interactive launch, independent of the terminal provider that hosts it, with the
   * arguments its launch adds last, where nothing follows to be swallowed.
   */
  interactive(settings?: LaunchSettings, launchArgs?: readonly string[]): TurnPlan;
  /**
   * The same launch on a session that exists, such as a fork's, or a pane's relaunched at other
   * settings; absent where a pane cannot.
   */
  interactiveResume?(
    sessionId: string,
    settings?: LaunchSettings,
    launchArgs?: readonly string[],
  ): TurnPlan;
  /** A one-shot, non-interactive run of `prompt`. */
  headlessTurn(prompt: string, context: TurnContext): TurnPlan;
  /**
   * A follow-up turn against the session the previous run left behind. Absent where the
   * harness has no resume we have confirmed — a headless nudge is impossible there, which is
   * itself an E2 result rather than something to paper over.
   */
  resumeTurn?(prompt: string, sessionId: string, context: TurnContext): TurnPlan;
  /** Pulls a resumable session id out of the harness's own output. */
  readSessionId?(stdout: string): string | undefined;
  /** What the agent actually printed, unwrapped from any envelope the harness adds. */
  readTranscript?(stdout: string): string;
  /**
   * The dollars the harness printed for the turn just run, where it prints any; `readCostTotal`
   * instead where it prints the session's. Tokens are read from its session files, by
   * `readSessionUsage`.
   */
  readCharge?(stdout: string): number | undefined;
  /**
   * The dollars the harness printed for its whole session so far, where it prints a running total
   * rather than the turn's (F9). A turn charges what the total grew by.
   */
  readCostTotal?(stdout: string): number | undefined;
  /**
   * Every request logged in these sessions, read from the harness's own files, and whether a turn
   * is still being written. `undefined` when none of them could be found, which is unknown rather
   * than zero.
   */
  readSessionUsage?(
    sessions: readonly string[],
    cwd: string,
    /** The agent's own harness home when it ran in a sandbox; the operator's otherwise. */
    home?: string,
  ): Promise<SessionRead | undefined>;
  /**
   * Keeps what a headless turn printed of its usage where `readSessionUsage` finds it, for a harness
   * that prints it and logs it nowhere; `home` is the agent's own, absent the operator's.
   */
  keepTurnUsage?(stdout: string, session: string, context: TurnContext): Promise<void>;
  /**
   * The files a session is made of, relative to `home`, to carry it into another: a fork's whose
   * home is not its parent's. Undefined where the session cannot be found there.
   */
  sessionFiles?(home: string, session: string, cwd: string): Promise<string[] | undefined>;
  /**
   * The session that logged `marker` since `since`, for a pane whose harness names its session to
   * nobody: the operation's id, which every turn's prompt carries, finds it in the harness's files.
   */
  findSession?(
    marker: string,
    since: number,
    cwd: string,
    home?: string,
  ): Promise<string | undefined>;
  /**
   * Every session in a harness home the agent had alone, as `readSessionUsage` takes them: a
   * sandboxed agent's own home holds nothing else, and a pane's harness names its session to
   * nobody when it never calls `wf` (story 004, "Panes").
   */
  homeSessions?(home: string): Promise<string[]>;
  /**
   * What is left of the plan its login draws on, by a command of its own that asks no model; `none`
   * with why where there is no plan to read.
   */
  readAllowance?(context: AllowanceContext): Promise<AllowanceRead>;
  /**
   * Its plan's usage screen, where only its TUI shows one: what to do in a fresh pane of it, in
   * order, and how to read the screen once the last step is done.
   */
  allowancePane?: {
    steps: readonly PaneStep[];
    read(screen: string, now: number): AllowanceRead;
  };
  /** Whether this agent's tokens are charged, which is not always what its login says. */
  billing?(context: BillingContext): Promise<Billing>;
  /**
   * Its own compaction of a headless session, with `focus` as what to keep and drop (ADR 0007).
   * Absent where it has none: a compaction then fails before anything runs.
   */
  compactHeadless?(focus: string, sessionId: string, context: TurnContext): CompactionPlan;
  /**
   * Its own fork of `sessionId` into a new session, `newSessionId` where it takes one, with no
   * model call (F7), so the copy is fixed when it is made. Absent where it has none.
   */
  forkSession?(
    sessionId: string,
    newSessionId: string,
    context: TurnContext,
  ): ForkPlan | Promise<ForkPlan>;
  /**
   * What its pane shows once it takes input, where Herdr can report it idle before then: a prompt
   * typed sooner is lost (story 019).
   */
  paneReady?: string;
  /** Its own compaction in a pane: what is typed, in order, and the screen that shows it ran. */
  compactPane?: {
    prompts(focus: string): string[];
    /**
     * Whether `screen` shows a compaction after what this one's prompts put there. `before` is
     * the screen as it was before them, read only for a harness with `ended`; `""` otherwise.
     */
    compacted(screen: string, focus: string, before: string): boolean;
    /**
     * Whether `screen` shows this compaction over, compacted or not. A harness that reports itself
     * idle while it compacts, as pi does, is read until it does. Absent, the settled screen is
     * final.
     */
    ended?(screen: string, before: string): boolean;
  };
  /**
   * How to let its sandbox reach local sockets, which `awf run --here` and every `wf` call need,
   * where its default sandbox does not (E8).
   */
  localSockets?: string;
  /**
   * What its screen shows once the operator stops a turn, where that can be told apart (story 014,
   * E8's follow-up). Absent, an interrupted turn looks like one that ended without answering.
   */
  interrupted?: string;
  /**
   * The summary of a session's last compaction, from the harness's own record, where it keeps one.
   * `session` is the session as the pane's harness names it: an id, or for pi its file's path.
   */
  readCompactSummary?(session: string, cwd: string): Promise<string | undefined>;
  /**
   * Its headless turns are billed per token even on a subscription login, so a headless agent is
   * `metered` whatever `billing` says, and runs only when its execution says `metered`.
   */
  meteredHeadless: boolean;
  /**
   * The effort levels it takes, in its own words, lowest first. An agent given one it does not
   * list is refused before anything runs.
   */
  effort?: readonly [Effort, ...Effort[]];
  /**
   * Its headless resume runs at the model and effort it is given, so a headless `set` is the next
   * resume's flags; the session keeps its context (M1).
   */
  setHeadless?: true;
  /**
   * Its pane, relaunched on its session by `interactiveResume` at other settings, keeps the
   * session's context, so a pane's `set` is that relaunch. Typing a switch instead saves it as the
   * operator's default in claude, and is a picker in codex (M2).
   */
  setPane?: true;
  /** Why each capability this harness lacks is absent; see `defineHarness`. */
  absent: Absences;
};

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

/** What a harness may lack: every optional field of `HarnessSpec`. */
export type Capability = OptionalKeys<HarnessSpec>;

export type Absences = { readonly [K in Capability]?: string };

/** A harness's spec before its absences: what it gives. */
export type HarnessDefinition = Omit<HarnessSpec, "absent">;

/**
 * The capabilities `Spec` gives: present, required in its type, and never `undefined`. A spec typed
 * `HarnessDefinition`, where every capability is optional, gives none.
 */
type Given<Spec> = {
  [K in keyof Spec & Capability]-?: object extends Pick<Spec, K>
    ? never
    : undefined extends Spec[K]
      ? never
      : K;
}[keyof Spec & Capability];

declare const defined: unique symbol;

/** A spec `defineHarness` made: the only kind `HARNESSES` holds. */
export type DefinedHarness = HarnessSpec & { readonly [defined]: true };

/**
 * A harness's spec, with why each capability it does not give is absent, and never both: a
 * capability added to `HarnessSpec` fails to compile until every harness takes a position. `spec`
 * is declared apart, `satisfies HarnessDefinition`: inline, its callbacks would stop tsc inferring
 * which capabilities it gives.
 */
export function defineHarness<Spec extends HarnessDefinition>(
  spec: Spec,
  absent: { readonly [K in Exclude<Capability, Given<Spec>>]: string } & {
    readonly [K in Given<Spec>]?: never;
  },
): DefinedHarness {
  return { ...spec, absent } as HarnessSpec as DefinedHarness;
}
