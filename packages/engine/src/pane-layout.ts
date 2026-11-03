import type { RunPanes } from "@agentswf/contract/records";
import type {
  KeepPane,
  PaneLayout,
  PaneSpec,
  PaneWorkspace,
  TurnOutcome,
} from "@agentswf/contract/workflow";

/** A terminal session's name: Herdr makes `sessions/{name}` from it, and a leading `-` reads as an option. */
export const SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

const SHARE = { min: 0.2, max: 0.8 };
const NEW_TAB_FIELDS = new Set(["session", "workspace", "tab"]);
const BESIDE_FIELDS = new Set(["beside", "side", "share"]);
export const KEEP_PANES: readonly KeepPane[] = ["never", "on-failure", "always"];

type WrittenPane = { pane?: unknown; layout?: unknown; keepPane?: unknown };

/**
 * Refuses, before anything is placed, what the agent's own spec fixes about its pane: what a
 * workflow, untyped at run time, could get wrong in `pane`, `layout` or `keepPane`, and any of them
 * on an agent with no pane of awf's to place (docs/design/pane-layout.md, "Refused at open").
 */
export function checkPaneOptions(
  key: string,
  spec: WrittenPane,
  agent: { headless: boolean; sandboxed: boolean },
): void {
  const refuse = (why: string): never => {
    throw new Error(`agent ${key}: ${why}`);
  };
  if (spec.pane === undefined && spec.layout === undefined && spec.keepPane === undefined) return;
  const old = spec.pane === undefined;
  if (agent.headless) {
    refuse(
      `${old ? "layout and keepPane place" : "pane places"} a pane, and a headless agent has none`,
    );
  }
  if (agent.sandboxed) {
    refuse(
      `${old ? "layout and keepPane are" : "pane is"} not yet for an agent in a sandbox, whose pane is in its own Herdr`,
    );
  }
  if (spec.pane !== undefined && spec.layout !== undefined) {
    refuse("give pane, not layout beside it: layout is deprecated");
  }
  if (spec.keepPane !== undefined && !KEEP_PANES.includes(spec.keepPane as KeepPane)) {
    refuse(`keepPane is never, on-failure or always, not ${JSON.stringify(spec.keepPane)}`);
  }
  if (spec.pane !== undefined) checkShape(key, "pane", spec.pane, refuse);
  if (spec.layout !== undefined) checkShape(key, "layout", spec.layout, refuse);
}

function checkShape(
  key: string,
  named: "pane" | "layout",
  given: unknown,
  refuse: (why: string) => never,
): void {
  const a = named === "pane" ? "a pane" : "a layout";
  if (typeof given !== "object" || given === null || Array.isArray(given)) {
    refuse(`${a} is an object, not ${JSON.stringify(given)}`);
  }
  const layout = given as Record<string, unknown>;
  const fields = Object.keys(layout).filter(
    (field) => layout[field] !== undefined && !(named === "pane" && field === "front"),
  );
  if (named === "pane" && layout.front !== undefined && typeof layout.front !== "boolean") {
    refuse(`front is true or false, not ${JSON.stringify(layout.front)}`);
  }
  if (layout.beside !== undefined) {
    const others = fields.filter((field) => !BESIDE_FIELDS.has(field));
    if (others.length > 0) {
      refuse(`${a} beside another pane takes side and share, not ${others.join(", ")}`);
    }
    if (typeof layout.beside !== "string" || layout.beside === "") {
      refuse(`beside names an agent's key, not ${JSON.stringify(layout.beside)}`);
    }
    if (layout.beside === key) refuse("a pane cannot be placed beside itself");
    if (layout.side !== "right" && layout.side !== "below") {
      refuse(`side is right or below, not ${JSON.stringify(layout.side)}`);
    }
    const share = layout.share;
    if (
      share !== undefined &&
      (typeof share !== "number" || !(share >= SHARE.min && share <= SHARE.max))
    ) {
      refuse(`share is from ${SHARE.min} to ${SHARE.max}, not ${JSON.stringify(share)}`);
    }
    return;
  }
  const allowed = named === "pane" ? new Set(["tab"]) : NEW_TAB_FIELDS;
  const others = fields.filter((field) => !allowed.has(field));
  if (others.length > 0) {
    refuse(
      named === "pane"
        ? `a pane takes tab, or beside and side, and front; not ${others.join(", ")}${others.some((field) => field === "workspace" || field === "session") ? ": the workspace is the operator's, awf run --workspace" : ""}`
        : `a layout takes session, workspace and tab, or beside and side; not ${others.join(", ")}`,
    );
  }
  const { session, workspace, tab } = layout;
  if (session !== undefined && (typeof session !== "string" || !SESSION_NAME.test(session))) {
    refuse(
      `session ${JSON.stringify(session)} is not a session name: lowercase letters, digits and -, up to 32, not starting with -`,
    );
  }
  if (session !== undefined && workspace === "origin") {
    refuse('"origin" is a workspace in its own session, so it takes no session');
  }
  if (
    workspace !== undefined &&
    workspace !== "run" &&
    workspace !== "origin" &&
    !(
      typeof workspace === "object" &&
      workspace !== null &&
      !Array.isArray(workspace) &&
      Object.keys(workspace).join() === "name" &&
      nonEmpty((workspace as { name?: unknown }).name)
    )
  ) {
    refuse(`workspace is "run", "origin" or { name }, not ${JSON.stringify(workspace)}`);
  }
  if (tab !== undefined && !nonEmpty(tab)) refuse(`tab is a label, not ${JSON.stringify(tab)}`);
}

/**
 * A checked `pane` or `layout` as it is kept and compared: fields given as `undefined` dropped, and
 * `front: false`, which is its absence, so a reopen that leaves one out matches.
 */
export function storedLayout<T extends PaneLayout | PaneSpec>(layout: T): T {
  // Not an object, it is left for `checkPaneOptions` to refuse by name.
  if (typeof layout !== "object" || layout === null || Array.isArray(layout)) return layout;
  return Object.fromEntries(
    Object.entries(structuredClone(layout)).filter(
      ([field, value]) => value !== undefined && !(field === "front" && value === false),
    ),
  ) as T;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The key a layout splits the pane of; absent for a new tab. */
export function besideOf(layout: PaneLayout | undefined): string | undefined {
  return layout && "beside" in layout ? layout.beside : undefined;
}

/** What the host is asked for one agent's pane. */
export type PaneAsked = {
  layout?: PaneLayout;
  front?: true;
  keepPane?: KeepPane;
  /** For a pane beside another: where its own tab opens if its target has no pane. */
  fallbackWorkspace?: PaneWorkspace;
};

/**
 * What the host is asked for an agent's pane: the workflow's tab or neighbour and `front`, in the
 * operator's workspace and kept as the operator says. The operator's flags win over a deprecated
 * `layout`'s session and workspace and a deprecated `keepPane`; absent, those apply as before. An
 * agent with no pane of awf's, headless or in a sandbox, is asked nothing.
 */
export function paneAsked(
  written: { pane?: PaneSpec; layout?: PaneLayout; keepPane?: KeepPane },
  run: RunPanes | undefined,
  hasPane: boolean,
): PaneAsked {
  if (!hasPane) return {};
  const keepPane = run?.keep ?? written.keepPane;
  const workspace = run?.workspace;
  const layout = placedLayout(written, workspace);
  return {
    ...(layout === undefined ? {} : { layout }),
    ...(written.pane?.front ? { front: true as const } : {}),
    ...(keepPane === undefined ? {} : { keepPane }),
    ...(besideOf(layout) !== undefined && workspace !== undefined
      ? { fallbackWorkspace: workspace }
      : {}),
  };
}

function placedLayout(
  { pane, layout }: { pane?: PaneSpec; layout?: PaneLayout },
  workspace: PaneWorkspace | undefined,
): PaneLayout | undefined {
  const written = pane ?? layout;
  if (written?.beside !== undefined) {
    const { beside, side, share } = written;
    return { beside, side, ...(share === undefined ? {} : { share }) };
  }
  const tab = written?.tab;
  if (workspace !== undefined) {
    return { workspace, ...(tab === undefined ? {} : { tab }) };
  }
  if (layout !== undefined) return layout;
  return tab === undefined ? undefined : { tab };
}

/**
 * Whether a done agent's pane stays, by `keepPane` and how its last operation ended: `on-failure`
 * keeps it unless that was answered, or there was none.
 */
export function keepsPane(
  keepPane: KeepPane | undefined,
  last: TurnOutcome<never>["kind"] | undefined,
): boolean {
  if (keepPane === "always") return true;
  return keepPane === "on-failure" && last !== undefined && last !== "answered";
}

/** `--workspace`'s value: the two keywords, else a workspace's label. */
export function parseWorkspace(value: string): PaneWorkspace {
  if (value === "run" || value === "origin") return value;
  return { name: value };
}
