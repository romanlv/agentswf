import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESSES } from "../spec";
import { loginFailure, thisTurn } from "./login";

const fixture = (name: string) =>
  readFileSync(join(import.meta.dir, "fixtures/login", name), "utf8");

const check = (harness: keyof typeof HARNESSES) => {
  const login = HARNESSES[harness].login;
  if (!login) throw new Error(`${harness} gives no login check`);
  return login;
};

// Captured 2026-10-05 in throwaway homes: "missing" has no credential, "refused" a made-up one.
const CASES = [
  ["claude", "missing", undefined, "Not logged in · Please run /login"],
  ["claude", "refused", undefined, "401"],
  ["codex", "missing", undefined, "401 Unauthorized"],
  ["codex", "refused", undefined, "Please try signing in again"],
  ["cursor", "missing", undefined, "Authentication required"],
  ["cursor", "refused", undefined, "The provided API key is invalid"],
  ["pi", "missing", "openai-codex", "No API key found for openai-codex"],
  ["pi", "refused", "openai-codex", "OAuth refresh failed for openai-codex"],
  ["pi", "refused-anthropic", "anthropic", "OAuth refresh failed for anthropic"],
] as const;

describe("a harness that cannot sign in", () => {
  for (const [harness, kind, provider, says] of CASES) {
    test(`${harness} ${kind}, headless`, () => {
      const need = check(harness).headless(
        fixture(`${harness}-${kind}.stdout`),
        fixture(`${harness}-${kind}.stderr`),
      );
      expect(need?.provider).toBe(provider);
      expect(need?.said).toContain(says);
    });
  }

  for (const [harness, kind, provider, says] of [
    ["claude", "missing", undefined, "Not logged in · Please run /login"],
    ["claude", "refused", undefined, "Please run /login · API Error: 401"],
    ["codex", "missing", undefined, "Finish signing in via your browser"],
    ["codex", "refused", undefined, "Finish signing in via your browser"],
    ["cursor", "missing", undefined, "Signing in with the browser"],
    ["cursor", "refused", undefined, "The provided API key is invalid"],
    ["pi", "missing", "openai-codex", "No API key found for openai-codex"],
    ["pi", "refused", "openai-codex", "OAuth refresh failed for openai-codex"],
  ] as const) {
    test(`${harness} ${kind}, on its screen`, () => {
      const need = check(harness).screen(fixture(`${harness}-${kind}.screen`));
      expect(need?.provider).toBe(provider);
      expect(need?.said).toContain(says);
    });
  }

  test("every harness gives a check", () => {
    for (const spec of Object.values(HARNESSES)) expect(spec.login).toBeDefined();
  });

  test("the reason names the harness, the provider and what to run", () => {
    const need = check("pi").headless(fixture("pi-refused.stdout"), "");
    const { detail, login } = loginFailure("pi", check("pi"), need!);
    expect(detail).toStartWith(
      "pi needs a login for openai-codex: run `pi`, then /login (pi said: OAuth refresh failed",
    );
    expect(login).toEqual({
      harness: "pi",
      provider: "openai-codex",
      run: "run `pi`, then /login",
    });
  });
});

describe("an agent quoting a login error is not one", () => {
  const quoted =
    "The CLI prints `Not logged in · Please run /login`, or OAuth refresh failed for x:";

  test("headless", () => {
    expect(
      check("claude").headless(
        JSON.stringify({ type: "result", is_error: false, result: quoted }),
        "",
      ),
    ).toBeUndefined();
    expect(
      check("pi").headless(
        JSON.stringify({
          type: "turn_end",
          message: { stopReason: "stop", content: [{ type: "text", text: quoted }] },
        }),
        "",
      ),
    ).toBeUndefined();
    expect(
      check("codex").headless(
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: quoted } }),
        "",
      ),
    ).toBeUndefined();
    expect(check("cursor").headless(JSON.stringify({ result: quoted }), "")).toBeUndefined();
  });

  test("on a screen, where it does not start its line", () => {
    const screen = `❯ say hi\n⏺ ${quoted}\n  pi says Error: No API key found for x.\n`;
    for (const harness of ["claude", "codex", "cursor", "pi"] as const) {
      expect(check(harness).screen(screen)).toBeUndefined();
    }
  });
});

describe("only what the harness printed of this turn counts", () => {
  test("a codex refresh that failed on the way to a completed turn is no login", () => {
    const completed = JSON.stringify({ type: "turn.completed", usage: {} });
    expect(check("codex").headless(completed, fixture("codex-refused.stderr"))).toBeUndefined();
    const network =
      "ERROR codex_login::auth::manager: Failed to refresh token: error sending request";
    expect(check("codex").headless("", network)).toBeUndefined();
  });

  test("codex's invalidated refresh token, as a real one printed it (2026-09-25)", () => {
    const stderr =
      '2026-09-25T22:58:47.504570Z ERROR codex_login::auth::manager: Failed to refresh token status=401 Unauthorized detail=TokenErrorDetail { error_code: Some("refresh_token_invalidated"), error_message: Some("Your refresh token has been invalidated. Please try signing in again."), .. }';
    expect(check("codex").headless("", stderr)?.said).toBe(
      "Your refresh token has been invalidated. Please try signing in again.",
    );
  });

  test("pi's provider is named whole, a dot in it included", () => {
    expect(check("pi").headless("", "No API key found for my.gateway.\n")?.provider).toBe(
      "my.gateway",
    );
  });

  test("codex whose token looked valid exits at the turn's first request", () => {
    const screen = thisTurn(fixture("codex-refused-running.screen"), "op-mid-1");
    expect(check("codex").screen(screen)?.said).toContain("unauthorized (401)");
  });

  test("claude's reason may come before its /login", () => {
    expect(check("claude").screen("❯ go\n⏺ Invalid API key · Please run /login\n")?.said).toBe(
      "Invalid API key · Please run /login",
    );
  });

  test("a pane's earlier turn is not this one", () => {
    const screen = `${fixture("claude-missing.screen")}\n❯ run op-2 and answer\n⏺ Done.\n`;
    expect(check("claude").screen(thisTurn(screen, "op-2"))).toBeUndefined();
    // A prompt folded away leaves no telling which lines are this turn's.
    expect(check("claude").screen(thisTurn(screen, "op-folded"))).toBeUndefined();
    // A launch sends no prompt: all it shows is its own.
    expect(check("claude").screen(thisTurn(screen, undefined))).toBeDefined();
  });
});
