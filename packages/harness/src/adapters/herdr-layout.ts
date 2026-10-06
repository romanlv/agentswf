import type { PaneLayout, PaneWorkspace } from "@agentswf/contract/workflow";
import type { PanePlacement } from "../adapter";
import { record } from "../json";
import type { HerdrCommands } from "./herdr";
import { hasHerdrErrorCode, readId, readPaneId } from "./herdr-protocol";

/** Herdr cuts nothing itself; a label longer than this crowds a tab bar or a pane's border. */
const LABEL_LIMIT = 32;
/** Herdr never refuses a split, and shrinks a pane to no columns, where no startup screen reads. */
const SMALLEST_PART = 1 / 8;
const DEFAULT_SHARE = 0.5;

/** A pane awf made for an agent, by Herdr's ids, in the session `screen` drives. */
export type PlacedPane = {
  key: string;
  paneId: string;
  /** Herdr's pane ids repeat after a restart; its terminal ids don't. */
  terminalId?: string;
  tabId?: string;
  workspaceId: string;
  report: PanePlacement;
  screen: PaneScreen;
};

/** A pane awf made in a session, whoever it was for, as a mark names it. */
export type MadePane = { paneId: string; terminalId?: string; workspaceId: string; kept?: true };

export type PaneRequest = {
  key: string;
  layout?: PaneLayout;
  /** Why the engine already knows `layout` can't be used. */
  fallback?: string;
  cwd: string;
  /** Set for the agent's process: a host codex's own home, say. */
  env?: Readonly<Record<string, string>>;
  deadlineUnixMs: number;
  signal?: AbortSignal;
};

/** A workspace the run's panes open in, made at its first tab. */
type Workspace = { id: string; rootPaneId: string; rootTabId?: string; rootTerminalId?: string };

type Made = Omit<PlacedPane, "key" | "report" | "screen">;

/**
 * What one run does in one Herdr session: the run's own workspace there, made at its first tab, and
 * every pane it makes, in that workspace or in a shared one. Every change goes through one queue,
 * so a split never lands on a pane being replaced or closed.
 */
export function createPaneScreen(options: {
  commands: HerdrCommands;
  /** The session's name, for the record. */
  session: string;
  /** The run's workspace label. */
  label: string;
  cwd: string;
  /** `--env` arguments every pane gets: the withheld variables, emptied. */
  environment: readonly string[];
  commandTimeoutMs: number;
  remaining: () => number;
  /** Told the run's workspace id once it exists, before any pane opens in it. */
  onRunWorkspace?: (workspaceId: string) => Promise<void>;
  /** Told every pane made, kept or closed, so a mark can name what a dead run left. */
  onPanes?: (panes: readonly MadePane[]) => void;
  /** Held while a named workspace is looked for and made, so two runs make one. */
  lockWorkspace?: (name: string) => Promise<() => Promise<void>>;
  /** In a sandbox's box, which ends with its box: a failed close there leaves nothing. */
  boxed?: boolean;
}) {
  const { herdr } = options.commands;
  let tail = Promise.resolve();
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  let open = true;
  let opening: Promise<Workspace> | undefined;
  /** Every pane this run made here and has not closed, by id; kept ones marked. */
  const made = new Map<string, MadePane>();
  const told = () => options.onPanes?.([...made.values()]);
  const remember = (pane: MadePane) => {
    made.set(pane.paneId, pane);
    told();
  };
  const forget = (paneId: string) => {
    if (made.delete(paneId)) told();
  };

  const runWorkspace = (): Promise<Workspace> => {
    if (!opening) {
      const making = makeRunWorkspace();
      opening = making;
      making.catch(() => {
        if (opening === making) opening = undefined;
      });
    }
    return opening;
  };

  const makeRunWorkspace = async (): Promise<Workspace> => {
    if (options.remaining() <= 0)
      throw new Error("run deadline exceeded before Herdr host creation");
    const created = await herdr(
      [
        "workspace",
        "create",
        "--label",
        options.label,
        ...options.environment,
        "--cwd",
        options.cwd,
        "--no-focus",
      ],
      Math.max(1, Math.min(options.commandTimeoutMs, options.remaining())),
    );
    if (!created.ok) throw new Error(`run workspace create failed: ${created.error}`);
    const id = readId(created.result.workspace, "workspace_id");
    const rootPaneId = readPaneId(created.result);
    const rootTabId = readId(created.result.tab, "tab_id");
    const rootTerminalId = readId(created.result.root_pane, "terminal_id");
    if (!id || !rootPaneId) {
      const incomplete = "run workspace create returned incomplete topology";
      if (!id) throw new Error(incomplete);
      const rollback = await herdr(["workspace", "close", id]);
      if (!rollback.ok) {
        throw new AggregateError(
          [
            new Error(incomplete),
            new Error(`incomplete run workspace cleanup failed: ${rollback.error}`),
          ],
          "Herdr run host acquisition and cleanup failed",
        );
      }
      throw new Error(incomplete);
    }
    if (!options.boxed) await options.onRunWorkspace?.(id);
    remember({
      paneId: rootPaneId,
      workspaceId: id,
      ...(rootTerminalId ? { terminalId: rootTerminalId } : {}),
    });
    return {
      id,
      rootPaneId,
      ...(rootTabId ? { rootTabId } : {}),
      ...(rootTerminalId ? { rootTerminalId } : {}),
    };
  };

  const timeout = (deadlineUnixMs: number) =>
    Math.max(1, Math.min(options.commandTimeoutMs, deadlineUnixMs - Date.now()));

  const paneEnv = (env: Readonly<Record<string, string>> | undefined) => [
    ...options.environment,
    ...Object.entries(env ?? {}).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
  ];

  /** A new tab in `workspaceId`, labelled `label`; its pane. Throws where Herdr refuses it. */
  const newTab = async (
    workspaceId: string,
    label: string,
    request: PaneRequest,
  ): Promise<Made> => {
    if (request.deadlineUnixMs - Date.now() <= 0) {
      throw new Error("operation deadline exceeded before tab allocation");
    }
    const created = await herdr(
      [
        "tab",
        "create",
        "--workspace",
        workspaceId,
        "--label",
        labelled(label),
        "--cwd",
        request.cwd,
        ...paneEnv(request.env),
        "--no-focus",
      ],
      timeout(request.deadlineUnixMs),
      request.signal,
    );
    if (!created.ok) throw new Error(`agent tab create failed: ${created.error}`);
    const tabId = readId(created.result.tab, "tab_id");
    const paneId = readPaneId(created.result);
    if (!tabId || !paneId) throw new Error("agent tab create returned no tab or pane identity");
    const terminalId = readId(created.result.root_pane, "terminal_id");
    const pane = { paneId, tabId, workspaceId, ...(terminalId ? { terminalId } : {}) };
    remember({ paneId, workspaceId, ...(terminalId ? { terminalId } : {}) });
    return pane;
  };

  /**
   * The workspace labelled `name`, the first in Herdr's order; or one made for this request, whose
   * first pane is then the request's own, labelled `label`.
   */
  const namedWorkspace = async (
    name: string,
    label: string,
    request: PaneRequest,
  ): Promise<{ workspaceId: string } | { pane: Made }> => {
    const release = (await options.lockWorkspace?.(name)) ?? (async () => undefined);
    try {
      const listed = await herdr(["workspace", "list"], timeout(request.deadlineUnixMs));
      if (!listed.ok) throw new Error(`workspace list failed: ${listed.error}`);
      const workspaces = Array.isArray(listed.result.workspaces) ? listed.result.workspaces : [];
      const found = workspaces
        .map((workspace) => record(workspace))
        .find((workspace) => workspace?.label === name);
      const foundId = readId(found, "workspace_id");
      if (foundId) return { workspaceId: foundId };
      const created = await herdr(
        [
          "workspace",
          "create",
          "--label",
          name,
          ...paneEnv(request.env),
          "--cwd",
          request.cwd,
          "--no-focus",
        ],
        timeout(request.deadlineUnixMs),
        request.signal,
      );
      if (!created.ok) throw new Error(`workspace create failed: ${created.error}`);
      const workspaceId = readId(created.result.workspace, "workspace_id");
      const paneId = readPaneId(created.result);
      const tabId = readId(created.result.tab, "tab_id");
      if (!workspaceId || !paneId)
        throw new Error("workspace create returned no workspace or pane");
      const terminalId = readId(created.result.root_pane, "terminal_id");
      remember({ paneId, workspaceId, ...(terminalId ? { terminalId } : {}) });
      if (tabId) await herdr(["tab", "rename", tabId, labelled(label)]);
      return {
        pane: {
          paneId,
          workspaceId,
          ...(tabId ? { tabId } : {}),
          ...(terminalId ? { terminalId } : {}),
        },
      };
    } finally {
      await release();
    }
  };

  /**
   * Splits `target`, the new pane taking `share` of it on `side`; why not, where the split would
   * leave either pane too small to read, as the tab is laid out now.
   */
  const split = async (
    target: PlacedPane,
    side: "right" | "below",
    share: number,
    request: PaneRequest,
  ): Promise<Made | string> => {
    const layout = await herdr(
      ["pane", "layout", "--pane", target.paneId],
      timeout(request.deadlineUnixMs),
      request.signal,
    );
    if (layout.ok) {
      const tight = tooSmall(record(layout.result.layout), target.paneId, side, share);
      if (tight) return tight;
    }
    const madeSplit = await herdr(
      [
        "pane",
        "split",
        target.paneId,
        "--direction",
        side === "right" ? "right" : "down",
        // Herdr's ratio is the part the split pane keeps.
        "--ratio",
        String(1 - share),
        "--cwd",
        request.cwd,
        ...paneEnv(request.env),
        "--no-focus",
      ],
      timeout(request.deadlineUnixMs),
      request.signal,
    );
    if (!madeSplit.ok) return `Herdr would not split ${target.key}'s pane: ${madeSplit.error}`;
    const paneId = readPaneId(madeSplit.result);
    if (!paneId) return `Herdr's split of ${target.key}'s pane returned no pane`;
    const pane = record(madeSplit.result.pane);
    const terminalId = readId(pane, "terminal_id");
    const tabId = readId(pane, "tab_id") ?? target.tabId;
    remember({ paneId, workspaceId: target.workspaceId, ...(terminalId ? { terminalId } : {}) });
    return {
      paneId,
      workspaceId: target.workspaceId,
      ...(tabId ? { tabId } : {}),
      ...(terminalId ? { terminalId } : {}),
    };
  };

  /** Labels a pane with its agent's key, so a tab of several says who is who. Best effort. */
  const name = (paneId: string, key: string, deadlineUnixMs: number) =>
    herdr(["pane", "rename", paneId, labelled(key)], timeout(deadlineUnixMs)).then(
      () => undefined,
      () => undefined,
    );

  /** Closes a pane this run made; one already gone is closed. Throws where Herdr refuses. */
  const closePane = async (paneId: string): Promise<void> => {
    const result = await herdr(["pane", "close", paneId]);
    if (!result.ok && !options.boxed && !hasHerdrErrorCode(result.error, "pane_not_found")) {
      throw new Error(`agent pane close failed: ${result.error}`);
    }
    forget(paneId);
  };

  /**
   * A pane in `pane`'s place, for a harness started again: the old one split, then closed, which
   * leaves the new one its exact size and position. An old one that would not close is left, and
   * said so, for its agent's close to try again.
   */
  const replace = async (
    pane: PlacedPane,
    request: PaneRequest,
  ): Promise<{ made?: Made; error?: string; oldClosed: boolean }> => {
    const madeSplit = await herdr(
      [
        "pane",
        "split",
        pane.paneId,
        "--direction",
        "right",
        "--cwd",
        request.cwd,
        ...paneEnv(request.env),
        "--no-focus",
      ],
      timeout(request.deadlineUnixMs),
      request.signal,
    );
    const paneId = madeSplit.ok ? readPaneId(madeSplit.result) : null;
    const terminalId = madeSplit.ok
      ? readId(record(madeSplit.result.pane), "terminal_id")
      : undefined;
    if (paneId) {
      remember({ paneId, workspaceId: pane.workspaceId, ...(terminalId ? { terminalId } : {}) });
    }
    const closing = await herdr(["pane", "close", pane.paneId]);
    const oldClosed = closing.ok || hasHerdrErrorCode(closing.error, "pane_not_found");
    if (oldClosed) forget(pane.paneId);
    if (!paneId) {
      return {
        oldClosed,
        error: `its pane could not be replaced: ${madeSplit.ok ? "no pane" : madeSplit.error}`,
      };
    }
    if (!oldClosed) {
      await closePane(paneId).catch(() => undefined);
      return { oldClosed, error: `its old pane would not close: ${closing.error}` };
    }
    return {
      oldClosed,
      made: {
        paneId,
        workspaceId: pane.workspaceId,
        ...(pane.tabId ? { tabId: pane.tabId } : {}),
        ...(terminalId ? { terminalId } : {}),
      },
    };
  };

  /** Leaves the pane open when its agent is done; the run's end closes the rest around it. */
  const keep = (paneId: string) => {
    const pane = made.get(paneId);
    if (!pane) return;
    made.set(paneId, { ...pane, kept: true });
    told();
  };

  let rootTaken = false;
  /**
   * The run workspace's first pane, once, labelled `label`, for what would otherwise leave it an
   * idle shell. Its label is best effort; the pane is the point.
   */
  const takeRoot = async (label: string): Promise<string | undefined> => {
    if (rootTaken || !open) return undefined;
    const workspace = await runWorkspace();
    if (rootTaken || !open) return undefined;
    rootTaken = true;
    if (workspace.rootTabId) {
      await herdr(["tab", "rename", workspace.rootTabId, labelled(label)]);
    }
    return workspace.rootPaneId;
  };

  /** A tab of its own in the run's workspace, for a sandbox's watch. */
  const watchTab = (label: string, cwd: string, deadlineUnixMs: number, signal: AbortSignal) =>
    mutate(async () => {
      if (!open) throw new Error("Herdr run topology is closing");
      const workspace = await runWorkspace();
      return (await newTab(workspace.id, label, { key: label, cwd, deadlineUnixMs, signal }))
        .paneId;
    });

  let shut = false;
  /**
   * Stops new panes and closes what the run made here and did not keep: its own workspace whole,
   * unless it holds a kept pane, and each other pane. Never a workspace it shares with others. The
   * error when it could not.
   */
  const closeAll = (): Promise<string | undefined> =>
    mutate(async () => {
      if (shut) return undefined;
      open = false;
      const failed: string[] = [];
      const own = await opening?.catch(() => undefined);
      const panesIn = (workspaceId: string) =>
        [...made.values()].filter((pane) => pane.workspaceId === workspaceId);
      if (own && !panesIn(own.id).some((pane) => pane.kept)) {
        const closing = await herdr(["workspace", "close", own.id]);
        if (closing.ok) for (const pane of panesIn(own.id)) forget(pane.paneId);
        else failed.push(`run workspace close failed: ${closing.error}`);
      }
      for (const pane of [...made.values()].filter((pane) => !pane.kept)) {
        await closePane(pane.paneId).catch((error: Error) => failed.push(error.message));
      }
      if (failed.length > 0) return failed.join("; ");
      shut = true;
      return undefined;
    });

  return {
    session: options.session,
    commands: options.commands,
    mutate,
    isOpen: () => open,
    runWorkspace,
    namedWorkspace,
    newTab,
    split,
    name,
    closePane,
    replace,
    keep,
    takeRoot,
    watchTab,
    closeAll,
    /** The panes this run made here and has not closed. */
    made: () => [...made.values()],
  };
}

export type PaneScreen = ReturnType<typeof createPaneScreen>;

/** Where a new tab goes: a screen's own workspace, or another by its id or its name there. */
type Destination = {
  screen: PaneScreen;
  workspace: PaneWorkspace;
  /** Absent for the screen's own run workspace. */
  workspaceId?: string;
  name?: string;
};

/**
 * Every agent's pane in a run, across the Herdr sessions it uses: placed as each agent's layout
 * says or, where that can't be used, in a tab of its own, with why. A new tab in a workspace the
 * run shares with others is labelled `{run} {tab}`, so the operator can tell runs apart.
 */
export function createPaneLayout(options: {
  /** The run session's screen, where every fallback ends. */
  run: PaneScreen;
  /** The run's label, which a tab in a shared workspace starts with. */
  runLabel: string;
  /** The screen for the session a layout names; why not, where it can't be used. */
  session?: (name: string) => Promise<PaneScreen | string>;
  /** `"origin"`'s screen and workspace; why not, where it can't be used. */
  origin?: () => Promise<{ screen: PaneScreen; workspaceId: string } | string>;
}) {
  const { run } = options;
  /** Each agent's pane, by key, while it is open. */
  const panes = new Map<string, PlacedPane>();
  /** Panes of agents closed, by key: a later `beside` falls back into their workspace. */
  const closed = new Map<string, PlacedPane>();

  const destination = async (
    layout: PaneLayout | undefined,
  ): Promise<{ to: Destination; fallback?: string }> => {
    const runs = { screen: run, workspace: "run" as const };
    if (!layout || "beside" in layout) return { to: runs };
    let screen = run;
    let fallback: string | undefined;
    if (layout.session !== undefined) {
      const named = options.session
        ? await options.session(layout.session)
        : `session ${layout.session} is not one this run can use`;
      if (typeof named === "string") fallback = named;
      else screen = named;
    }
    const workspace = layout.workspace ?? "run";
    if (workspace === "origin") {
      const origin = options.origin
        ? await options.origin()
        : "this run has no origin: it was not started in a Herdr pane";
      if (typeof origin === "string") return { to: runs, fallback: origin };
      return { to: { screen: origin.screen, workspace, workspaceId: origin.workspaceId } };
    }
    if (workspace === "run")
      return { to: { screen, workspace }, ...(fallback ? { fallback } : {}) };
    return {
      to: { screen, workspace, name: workspace.name },
      ...(fallback ? { fallback } : {}),
    };
  };

  /** A new tab at `to`, labelled for it; its pane. */
  const tabAt = (to: Destination, base: string, request: PaneRequest): Promise<Made> =>
    to.screen.mutate(async () => {
      if (!to.screen.isOpen()) throw new Error("Herdr run topology is closing");
      const label = to.workspace === "run" ? base : `${options.runLabel} ${base}`;
      if (to.name !== undefined) {
        const named = await to.screen.namedWorkspace(to.name, label, request);
        if ("pane" in named) return named.pane;
        return to.screen.newTab(named.workspaceId, label, request);
      }
      const workspaceId = to.workspaceId ?? (await to.screen.runWorkspace()).id;
      return to.screen.newTab(workspaceId, label, request);
    });

  const place = async (request: PaneRequest): Promise<PlacedPane> => {
    if (!run.isOpen()) throw new Error("Herdr run topology is closing");
    if (request.deadlineUnixMs <= Date.now()) {
      throw new Error("deadline exceeded before the pane was placed");
    }
    const { key, layout } = request;
    const besideKey = layout && "beside" in layout ? layout.beside : undefined;
    let fallback = request.fallback;
    let placed: { made: Made; screen: PaneScreen; report: PanePlacement } | undefined;
    /** Where a pane that falls back goes: its target's workspace, if it has one. */
    let besideFallback: Destination | undefined;
    if (besideKey !== undefined && fallback === undefined) {
      const target = panes.get(besideKey) ?? closed.get(besideKey);
      if (!target) fallback = `${besideKey} has no pane`;
      else {
        const { screen } = target;
        besideFallback = {
          screen,
          workspace: target.report.workspace,
          workspaceId: target.workspaceId,
        };
        const side = (layout as { side: "right" | "below" }).side;
        const share = (layout as { share?: number }).share ?? DEFAULT_SHARE;
        // Read in the queue: a relaunch before it may have replaced the target's pane.
        const made = await screen.mutate(async () => {
          const now = panes.get(besideKey);
          if (!now) return `${besideKey}'s pane is closed`;
          return screen.split(now, side, share, request);
        });
        if (typeof made === "string") fallback = made;
        else {
          const {
            tab: _tab,
            fallback: _fallback,
            kept: _kept,
            notKept: _notKept,
            ...where
          } = target.report;
          placed = { made, screen, report: { ...where, beside: besideKey } };
        }
      }
    }
    if (!placed) {
      const tab = besideKey === undefined && layout && "tab" in layout ? layout.tab : undefined;
      const base = tab ?? key;
      const resolved =
        besideFallback !== undefined || request.fallback !== undefined
          ? { to: besideFallback ?? { screen: run, workspace: "run" as const } }
          : await destination(layout);
      fallback ??= resolved.fallback;
      let to = resolved.to;
      let made: Made;
      try {
        made = await tabAt(to, base, request);
      } catch (error) {
        const runs = to.screen === run && to.workspace === "run" && to.workspaceId === undefined;
        if (runs) throw error;
        fallback ??= `its tab could not open there: ${(error as Error).message}`;
        to = { screen: run, workspace: "run" };
        made = await tabAt(to, base, request);
      }
      const label = to.workspace === "run" ? base : `${options.runLabel} ${base}`;
      placed = {
        made,
        screen: to.screen,
        report: { session: to.screen.session, workspace: to.workspace, tab: labelled(label) },
      };
    }
    const pane: PlacedPane = {
      key,
      ...placed.made,
      screen: placed.screen,
      report: { ...placed.report, ...(fallback === undefined ? {} : { fallback }) },
    };
    panes.set(key, pane);
    closed.delete(key);
    await placed.screen.name(pane.paneId, key, request.deadlineUnixMs);
    return pane;
  };

  /**
   * Closes `pane`. Never its tab: Herdr closes a tab with its last pane, and one of several agents
   * stays while the others do.
   */
  const close = (pane: PlacedPane): Promise<void> =>
    pane.screen.mutate(async () => {
      if (panes.get(pane.key) !== pane) return;
      await pane.screen.closePane(pane.paneId);
      panes.delete(pane.key);
      closed.set(pane.key, pane);
    });

  /**
   * A pane in `pane`'s place, for a harness started again. Rejects where it couldn't be made; the
   * old pane is then closed, or, where it would not close, still the agent's.
   */
  const replace = (pane: PlacedPane, request: PaneRequest): Promise<PlacedPane> =>
    pane.screen.mutate(async () => {
      if (!pane.screen.isOpen()) throw new Error("Herdr run topology is closing");
      const { made, error, oldClosed } = await pane.screen.replace(pane, request);
      if (oldClosed) {
        panes.delete(pane.key);
        closed.set(pane.key, pane);
      }
      if (!made) throw new Error(error);
      const next: PlacedPane = { ...pane, ...made };
      if (!made.terminalId) delete next.terminalId;
      panes.set(pane.key, next);
      closed.delete(pane.key);
      await pane.screen.name(next.paneId, pane.key, request.deadlineUnixMs);
      return next;
    });

  /** Leaves `pane` open when its agent is done; false where it is no longer the agent's. */
  const keep = (pane: PlacedPane): Promise<boolean> =>
    pane.screen.mutate(async () => {
      if (panes.get(pane.key) !== pane) return false;
      pane.screen.keep(pane.paneId);
      return true;
    });

  return {
    place,
    close,
    replace,
    keep,
    /** The agent's pane now, if it has one open. */
    paneOf: (key: string) => panes.get(key),
  };
}

export type PaneLayoutHost = ReturnType<typeof createPaneLayout>;

function labelled(label: string): string {
  return [...label].slice(0, LABEL_LIMIT).join("");
}

/**
 * Why splitting `paneId` would leave either pane under 1/8 of its tab on that axis, read from
 * `pane layout`; undefined when it wouldn't, or the layout can't be read.
 */
function tooSmall(
  layout: Record<string, unknown> | undefined,
  paneId: string,
  side: "right" | "below",
  share: number,
): string | undefined {
  const axis = side === "right" ? "width" : "height";
  const tab = record(layout?.area)?.[axis];
  const panes = Array.isArray(layout?.panes) ? layout.panes : [];
  const target = panes.map((pane) => record(pane)).find((pane) => pane?.pane_id === paneId);
  const span = record(target?.rect)?.[axis];
  if (typeof tab !== "number" || typeof span !== "number" || tab <= 0) return undefined;
  const smaller = Math.min(span * share, span * (1 - share));
  if (smaller >= tab * SMALLEST_PART) return undefined;
  return `the split would leave a pane ${Math.floor(smaller)} of the tab's ${tab} ${
    axis === "width" ? "columns" : "rows"
  }, under 1/8`;
}
