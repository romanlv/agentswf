import type { PaneLayout } from "@agentswf/contract/workflow";
import type { PanePlacement } from "../adapter";
import { record } from "../json";
import type { HerdrCommands } from "./herdr";
import { hasHerdrErrorCode, readId, readPaneId } from "./herdr-protocol";

/** Herdr cuts nothing itself; a label longer than this crowds a tab bar or a pane's border. */
const LABEL_LIMIT = 32;
/** Herdr never refuses a split, and shrinks a pane to no columns, where no startup screen reads. */
const SMALLEST_PART = 1 / 8;
const DEFAULT_SHARE = 0.5;

/** A pane awf made for an agent, by Herdr's ids. */
export type PlacedPane = {
  key: string;
  paneId: string;
  /** Herdr's pane ids repeat after a restart; its terminal ids don't. */
  terminalId?: string;
  tabId?: string;
  workspaceId: string;
  report: PanePlacement;
};

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
type Workspace = {
  id: string;
  rootPaneId: string;
  rootTabId?: string;
};

/**
 * The panes of one run in one Herdr: the run's workspace in it, made at its first tab, and each
 * agent's pane, placed as its layout says or, where that can't be used, in a tab of its own. Every
 * change goes through one queue, so a split never lands on a pane being replaced or closed.
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
  let workspace: Workspace | undefined;
  /** Each agent's pane, by key, while it is open. */
  const panes = new Map<string, PlacedPane>();

  const runWorkspace = (): Promise<Workspace> => {
    if (!opening) {
      const made = makeRunWorkspace();
      opening = made;
      made.catch(() => {
        if (opening === made) opening = undefined;
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
    workspace = { id, rootPaneId, ...(rootTabId ? { rootTabId } : {}) };
    return workspace;
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
  ): Promise<Omit<PlacedPane, "key" | "report">> => {
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
    return { paneId, tabId, workspaceId, ...(terminalId ? { terminalId } : {}) };
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
  ): Promise<Omit<PlacedPane, "key" | "report"> | string> => {
    const layout = await herdr(
      ["pane", "layout", "--pane", target.paneId],
      timeout(request.deadlineUnixMs),
      request.signal,
    );
    if (layout.ok) {
      const tight = tooSmall(record(layout.result.layout), target.paneId, side, share);
      if (tight) return tight;
    }
    const made = await herdr(
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
    if (!made.ok) return `Herdr would not split ${target.key}'s pane: ${made.error}`;
    const paneId = readPaneId(made.result);
    if (!paneId) return `Herdr's split of ${target.key}'s pane returned no pane`;
    const pane = record(made.result.pane);
    const terminalId = readId(pane, "terminal_id");
    const tabId = readId(pane, "tab_id") ?? target.tabId;
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

  const place = (request: PaneRequest): Promise<PlacedPane> =>
    mutate(async () => {
      if (!open) throw new Error("Herdr run topology is closing");
      if (request.deadlineUnixMs <= Date.now()) {
        throw new Error("deadline exceeded before the pane was placed");
      }
      const { key, layout } = request;
      const besideKey = layout && "beside" in layout ? layout.beside : undefined;
      let fallback = request.fallback;
      let placed: Omit<PlacedPane, "key" | "report"> | undefined;
      let report: PanePlacement | undefined;
      /** Where a pane that falls back goes: its target's workspace, if it has one. */
      let fallbackWorkspace: string | undefined;
      if (besideKey !== undefined && fallback === undefined) {
        const target = panes.get(besideKey) ?? closed.get(besideKey);
        if (!target) fallback = `${besideKey} has no pane`;
        else if (!panes.has(besideKey)) {
          fallback = `${besideKey}'s pane is closed`;
          fallbackWorkspace = target.workspaceId;
        } else {
          const side = (layout as { side: "right" | "below" }).side;
          const share = (layout as { share?: number }).share ?? DEFAULT_SHARE;
          const made = await split(target, side, share, request);
          fallbackWorkspace = target.workspaceId;
          if (typeof made === "string") fallback = made;
          else {
            placed = made;
            report = { ...target.report, beside: besideKey };
            delete report.tab;
            delete report.fallback;
          }
        }
      }
      if (!placed) {
        const tab = besideKey === undefined && layout && "tab" in layout ? layout.tab : undefined;
        const label = tab ?? key;
        const run = await runWorkspace();
        const into = fallbackWorkspace ?? run.id;
        try {
          placed = await newTab(into, label, request);
        } catch (error) {
          if (into === run.id) throw error;
          fallback ??= `its tab could not open beside ${besideKey}: ${(error as Error).message}`;
          placed = await newTab(run.id, label, request);
        }
        report = {
          session: options.session,
          workspace: "run",
          tab: labelled(label),
          ...(fallback === undefined ? {} : { fallback }),
        };
      } else if (fallback !== undefined) {
        report = { ...report!, fallback };
      }
      const pane: PlacedPane = { key, ...placed, report: report! };
      panes.set(key, pane);
      closed.delete(key);
      await name(pane.paneId, key, request.deadlineUnixMs);
      return pane;
    });

  /** Panes of agents closed, by key: a later `beside` falls back into their workspace. */
  const closed = new Map<string, PlacedPane>();

  /**
   * Closes `pane`; a pane already gone is closed. Never its tab: Herdr closes a tab with its last
   * pane, and one of several agents stays while the others do.
   */
  const close = (pane: PlacedPane): Promise<void> =>
    mutate(async () => {
      if (panes.get(pane.key) !== pane) return;
      const result = await herdr(["pane", "close", pane.paneId]);
      if (!result.ok && !options.boxed && !hasHerdrErrorCode(result.error, "pane_not_found")) {
        throw new Error(`agent pane close failed: ${result.error}`);
      }
      panes.delete(pane.key);
      closed.set(pane.key, pane);
    });

  /**
   * A pane in `pane`'s place, for a harness started again: the old one split, then closed, which
   * leaves the new one its exact size and position. The old one is closed whatever happens.
   */
  const replace = (pane: PlacedPane, request: PaneRequest): Promise<PlacedPane> =>
    mutate(async () => {
      if (!open) throw new Error("Herdr run topology is closing");
      const made = await herdr(
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
      const paneId = made.ok ? readPaneId(made.result) : null;
      const closing = await herdr(["pane", "close", pane.paneId]);
      const gone = closing.ok || hasHerdrErrorCode(closing.error, "pane_not_found");
      // An old pane that would not close stays this agent's, for its close to try again.
      if (gone) {
        panes.delete(pane.key);
        closed.set(pane.key, pane);
      }
      if (!paneId) {
        throw new Error(`its pane could not be replaced: ${made.ok ? "no pane" : made.error}`);
      }
      if (!gone) {
        await herdr(["pane", "close", paneId]);
        throw new Error(`its old pane would not close: ${closing.error}`);
      }
      const terminalId = made.ok ? readId(record(made.result.pane), "terminal_id") : undefined;
      const next: PlacedPane = {
        key: pane.key,
        paneId,
        workspaceId: pane.workspaceId,
        report: pane.report,
        ...(pane.tabId ? { tabId: pane.tabId } : {}),
        ...(terminalId ? { terminalId } : {}),
      };
      panes.set(pane.key, next);
      await name(paneId, pane.key, request.deadlineUnixMs);
      return next;
    });

  let rootTaken = false;
  /**
   * The run workspace's first pane, once, labelled `label`, for what would otherwise leave it an
   * idle shell. Its label is best effort; the pane is the point.
   */
  const takeRoot = async (label: string): Promise<string | undefined> => {
    if (rootTaken || !open) return undefined;
    const made = await runWorkspace();
    if (rootTaken || !open) return undefined;
    rootTaken = true;
    watching.push(made.rootPaneId);
    if (made.rootTabId) await herdr(["tab", "rename", made.rootTabId, labelled(label)]);
    return made.rootPaneId;
  };

  /** Sandboxes' watch panes, closed with the run whatever it keeps. */
  const watching: string[] = [];
  /** Agents' panes left open when they were done, by key. */
  const kept = new Map<string, PlacedPane>();

  /** Leaves `pane` open when its agent is done; the run's end closes the rest around it. */
  const keep = (pane: PlacedPane): Promise<void> =>
    mutate(async () => {
      if (panes.get(pane.key) === pane) kept.set(pane.key, pane);
    });

  /** A tab of its own in the run's workspace, for a sandbox's watch. */
  const watchTab = (label: string, cwd: string, deadlineUnixMs: number, signal: AbortSignal) =>
    mutate(async () => {
      if (!open) throw new Error("Herdr run topology is closing");
      const run = await runWorkspace();
      const { paneId } = await newTab(run.id, label, { key: label, cwd, deadlineUnixMs, signal });
      watching.push(paneId);
      return paneId;
    });

  let shut = false;
  /**
   * Stops new panes and closes what the run made and did not keep: the run's workspace whole, or,
   * where it holds a kept pane, every other pane awf made in it. The error when it could not.
   */
  const closeAll = (): Promise<string | undefined> =>
    mutate(async () => {
      if (shut) return undefined;
      open = false;
      const made = await opening?.catch(() => undefined);
      if (!made) {
        shut = true;
        return undefined;
      }
      if (![...kept.values()].some((pane) => pane.workspaceId === made.id)) {
        const closing = await herdr(["workspace", "close", made.id]);
        if (!closing.ok) return `run workspace close failed: ${closing.error}`;
        panes.clear();
        shut = true;
        return undefined;
      }
      const leftover = [
        ...[...panes.values()].filter((pane) => !kept.has(pane.key)).map((pane) => pane.paneId),
        ...watching,
        ...(rootTaken ? [] : [made.rootPaneId]),
      ];
      const failed: string[] = [];
      for (const paneId of leftover) {
        const closing = await herdr(["pane", "close", paneId]);
        if (!closing.ok && !hasHerdrErrorCode(closing.error, "pane_not_found")) {
          failed.push(`${paneId}: ${closing.error}`);
        }
      }
      if (failed.length > 0) return `run panes close failed: ${failed.join("; ")}`;
      shut = true;
      return undefined;
    });

  return {
    commands: options.commands,
    place,
    replace,
    close,
    takeRoot,
    watchTab,
    closeAll,
    keep,
    /** The agent's pane now, if it has one open. */
    paneOf: (key: string) => panes.get(key),
    /** The panes left open for the operator, once their agents were done. */
    kept: () => [...kept.values()],
    /** The run's workspace, once made. */
    workspace: () => workspace,
  };
}

export type PaneScreen = ReturnType<typeof createPaneScreen>;

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
