/**
 * Peers reach an agent only through awf's routes, so claude's own messaging from the user's other
 * sessions is refused: a restrictive value, which no other settings source can loosen. Its offer
 * to set up auto mode, a dialog 2.1.317 opens in a pane after a turn, is turned off: it blocks the
 * pane until answered.
 */
export const CLAUDE_SESSION_SETTINGS = {
  crossSessionInbound: "refuse",
  skillOverrides: { "auto-mode-setup": "off" },
} as const;
