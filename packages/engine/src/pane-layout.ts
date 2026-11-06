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
const BESIDE_FIELDS = new Set(["beside", "side", "share"]);
export const KEEP_PANES: readonly KeepPane[] = ["never", "on-failure", "always"];

/**
 * Refuses, before anything is placed, what a workflow, untyped at run time, could get wrong in an
 * agent's `pane`, and a `pane` on an agent with no pane of awf's to place
 * (docs/design/pane-layout.md, "Refused at open").
 */
export function checkPaneOptions(
  key: string,
  spec: { pane?: unknown },
  agent: { headless: boolean; sandboxed: boolean },
): void {
  const refuse = (why: string): never => {
    throw new Error(`agent ${key}: ${why}`);
  };
  // Removed in 0.1.0-beta.6; refused, as they would place or keep a pane otherwise than written.
  const given = spec as { layout?: unknown; keepPane?: unknown };
  if (given.layout !== undefined)
    refuse(
      "layout was removed: give pane: { tab } or pane: { beside, side }; the workspace is awf run --workspace",
    );
  if (given.keepPane !== undefined)
    refuse("keepPane was removed: keeping panes is the operator's, awf run --keep-panes");
  const { pane } = spec;
  if (pane === undefined) return;
  if (agent.headless) refuse("pane places a pane, and a headless agent has none");
  if (agent.sandboxed) {
    refuse("pane is not yet for an agent in a sandbox, whose pane is in its own Herdr");
  }
  if (typeof pane !== "object" || pane === null || Array.isArray(pane)) {
    refuse(`a pane is an object, not ${JSON.stringify(pane)}`);
  }
  const shape = pane as Record<string, unknown>;
  const fields = Object.keys(shape).filter(
    (field) => shape[field] !== undefined && field !== "front",
  );
  if (shape.front !== undefined && typeof shape.front !== "boolean") {
    refuse(`front is true or false, not ${JSON.stringify(shape.front)}`);
  }
  if (shape.beside !== undefined) {
    const others = fields.filter((field) => !BESIDE_FIELDS.has(field));
    if (others.length > 0) {
      refuse(`a pane beside another pane takes side and share, not ${others.join(", ")}`);
    }
    if (typeof shape.beside !== "string" || shape.beside === "") {
      refuse(`beside names an agent's key, not ${JSON.stringify(shape.beside)}`);
    }
    if (shape.beside === key) refuse("a pane cannot be placed beside itself");
    if (shape.side !== "right" && shape.side !== "below") {
      refuse(`side is right or below, not ${JSON.stringify(shape.side)}`);
    }
    const share = shape.share;
    if (
      share !== undefined &&
      (typeof share !== "number" || !(share >= SHARE.min && share <= SHARE.max))
    ) {
      refuse(`share is from ${SHARE.min} to ${SHARE.max}, not ${JSON.stringify(share)}`);
    }
    return;
  }
  const others = fields.filter((field) => field !== "tab");
  if (others.length > 0) {
    refuse(
      `a pane takes tab, or beside and side, and front; not ${others.join(", ")}${others.some((field) => field === "workspace" || field === "session") ? ": the workspace is the operator's, awf run --workspace" : ""}`,
    );
  }
  if (shape.tab !== undefined && !nonEmpty(shape.tab)) {
    refuse(`tab is a label, not ${JSON.stringify(shape.tab)}`);
  }
}

/**
 * A checked `pane` as it is kept and compared: fields given as `undefined` dropped, and
 * `front: false`, which is its absence, so a reopen that leaves one out matches.
 */
export function storedPane(pane: PaneSpec): PaneSpec {
  // Not an object, it is left for `checkPaneOptions` to refuse by name.
  if (typeof pane !== "object" || pane === null || Array.isArray(pane)) return pane;
  return Object.fromEntries(
    Object.entries(structuredClone(pane)).filter(
      ([field, value]) => value !== undefined && !(field === "front" && value === false),
    ),
  ) as PaneSpec;
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
 * operator's workspace and kept as the operator says. An agent with no pane of awf's, headless or
 * in a sandbox, is asked nothing.
 */
export function paneAsked(
  pane: PaneSpec | undefined,
  run: RunPanes | undefined,
  hasPane: boolean,
): PaneAsked {
  if (!hasPane) return {};
  const keepPane = run?.keep;
  const workspace = run?.workspace;
  const layout = placedLayout(pane, workspace);
  return {
    ...(layout === undefined ? {} : { layout }),
    ...(pane?.front ? { front: true as const } : {}),
    ...(keepPane === undefined ? {} : { keepPane }),
    ...(besideOf(layout) !== undefined && workspace !== undefined
      ? { fallbackWorkspace: workspace }
      : {}),
  };
}

function placedLayout(
  pane: PaneSpec | undefined,
  workspace: PaneWorkspace | undefined,
): PaneLayout | undefined {
  if (pane?.beside !== undefined) {
    const { beside, side, share } = pane;
    return { beside, side, ...(share === undefined ? {} : { share }) };
  }
  const tab = pane?.tab;
  if (workspace !== undefined) return { workspace, ...(tab === undefined ? {} : { tab }) };
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
