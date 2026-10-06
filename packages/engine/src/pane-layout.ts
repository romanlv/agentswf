import type { KeepPane, PaneLayout, TurnOutcome } from "@agentswf/contract/workflow";

/** A terminal session's name: Herdr makes `sessions/{name}` from it, and a leading `-` reads as an option. */
export const SESSION_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

const SHARE = { min: 0.2, max: 0.8 };
const NEW_TAB_FIELDS = new Set(["session", "workspace", "tab"]);
const BESIDE_FIELDS = new Set(["beside", "side", "share"]);
const KEEP: readonly KeepPane[] = ["never", "on-failure", "always"];

/**
 * Refuses, before anything is placed, what the agent's own spec fixes about its pane: what a
 * workflow, untyped at run time, could get wrong in `layout` or `keepPane`, and either on an agent
 * with no pane of awf's to place (docs/design/pane-layout.md, "Refused at open").
 */
export function checkPaneOptions(
  key: string,
  spec: { layout?: unknown; keepPane?: unknown },
  agent: { headless: boolean; sandboxed: boolean },
): void {
  const refuse = (why: string): never => {
    throw new Error(`agent ${key}: ${why}`);
  };
  if (spec.layout === undefined && spec.keepPane === undefined) return;
  if (agent.headless) refuse("layout and keepPane place a pane, and a headless agent has none");
  if (agent.sandboxed) {
    refuse(
      "layout and keepPane are not yet for an agent in a sandbox, whose pane is in its own Herdr",
    );
  }
  if (spec.keepPane !== undefined && !KEEP.includes(spec.keepPane as KeepPane)) {
    refuse(`keepPane is never, on-failure or always, not ${JSON.stringify(spec.keepPane)}`);
  }
  if (spec.layout === undefined) return;
  const layout = spec.layout;
  if (typeof layout !== "object" || layout === null || Array.isArray(layout)) {
    refuse(`a layout is an object, not ${JSON.stringify(layout)}`);
  }
  const fields = Object.keys(layout as object).filter(
    (field) => (layout as Record<string, unknown>)[field] !== undefined,
  );
  const given = layout as Record<string, unknown>;
  if (given.beside !== undefined) {
    const others = fields.filter((field) => !BESIDE_FIELDS.has(field));
    if (others.length > 0) {
      refuse(`a layout beside another pane takes side and share, not ${others.join(", ")}`);
    }
    if (typeof given.beside !== "string" || given.beside === "") {
      refuse(`beside names an agent's key, not ${JSON.stringify(given.beside)}`);
    }
    if (given.beside === key) refuse("a pane cannot be placed beside itself");
    if (given.side !== "right" && given.side !== "below") {
      refuse(`side is right or below, not ${JSON.stringify(given.side)}`);
    }
    const share = given.share;
    if (
      share !== undefined &&
      (typeof share !== "number" || !(share >= SHARE.min && share <= SHARE.max))
    ) {
      refuse(`share is from ${SHARE.min} to ${SHARE.max}, not ${JSON.stringify(share)}`);
    }
    return;
  }
  const others = fields.filter((field) => !NEW_TAB_FIELDS.has(field));
  if (others.length > 0) {
    refuse(
      `a layout takes session, workspace and tab, or beside and side; not ${others.join(", ")}`,
    );
  }
  const { session, workspace, tab } = given;
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
 * A checked layout as it is kept and compared: fields given as `undefined` dropped, so a reopen
 * that leaves one out matches.
 */
export function storedLayout(layout: PaneLayout): PaneLayout {
  return Object.fromEntries(
    Object.entries(structuredClone(layout)).filter(([, value]) => value !== undefined),
  ) as PaneLayout;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** The key a layout splits the pane of; absent for a new tab. */
export function besideOf(layout: PaneLayout | undefined): string | undefined {
  return layout && "beside" in layout ? layout.beside : undefined;
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
