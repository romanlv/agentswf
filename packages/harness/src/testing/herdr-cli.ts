import { HERDR_VERSION } from "../adapters/herdr";
import type { ProcessInput, ProcessResult, RunProcess } from "../command";

/**
 * A Herdr CLI model for adapter tests.
 *
 * The hand-written stubs answer whatever the adapter asks, so they can only confirm its
 * expectations; four live defects passed straight through them. What is modelled here is what
 * those defects came from, and nothing else: a tab launches its own process and so sees only its
 * own `--env`; a startup block is rendered wrapped to the pane's width, styled by the agent's own
 * TUI, and left on the screen after it is answered; startup raises a queue of blocks whose keys
 * are not interchangeable; `agent wait` answers for a blocked agent as readily as a ready one; and
 * an agent reports ready before its UI accepts input, discarding a prompt submitted into that
 * window. A command outside that answers an empty success, exactly as the stubs did.
 */
export type StartupBlock = "trust" | "update";

export type FakeHerdrOptions = {
  /** Columns a pane renders at; each agent's tab gives its one pane the whole width. */
  rootColumns?: number;
  /** How long after its last block is answered an agent still discards submitted prompts. */
  inputReadyAfterMs?: number;
  /** The blocks an agent raises, in the order it raises them. */
  startupBlocks?: readonly StartupBlock[];
  /** Break at the column rather than at a space, as a terminal does to text it did not wrap. */
  hardWrap?: boolean;
  /**
   * How many `agent rename` calls a harness typed into a pane answers `agent_not_found` before
   * Herdr has detected it (H6: about a second of polling).
   */
  detectionPolls?: number;
  /** The login shell swallows the prelude, as an rc file's question does, and prompts again. */
  swallowsPrelude?: boolean;
  /** What `herdr --version` answers. */
  version?: string;
};

export type FakeAgent = {
  name: string;
  kind: string;
  paneId: string;
  /** Blocks not yet answered. The agent refuses prompts while any remain. */
  blocks: StartupBlock[];
  /** Whether the update block was answered by selecting the option that runs `curl | sh`. */
  ranInstaller: boolean;
  /** Prompts Herdr both delivered and submitted. A discarded prompt never appears here. */
  delivered: string[];
  /** Prompts typed into the pane and lost because the UI was not accepting input yet. */
  discarded: string[];
  /** Screens of blocks already answered. A pane does not repaint them away on its own. */
  answeredScreens: string[];
  /** Names this agent's own pane was given an empty value for. */
  emptied: string[];
};

/** A pane as the typed start sees it: what it shows, and what was typed into it. */
export type FakePane = {
  env: Record<string, string>;
  columns: number;
  tab: string;
  screen: string[];
  typed: string[];
  /** A harness typed in and not yet detected: its kind, and the renames it has answered. */
  typedHarness?: { kind: string; polls: number };
  terminalId: string;
  /** Where it is in its tab; a closed neighbour's space is not given back. */
  rect: Rect;
  label?: string;
};

type Rect = { x: number; y: number; width: number; height: number };

/** Rows a tab has, beside `rootColumns`. */
const ROOT_ROWS = 50;

export type FakeHerdr = {
  run: RunProcess;
  panes: Map<string, FakePane>;
  calls: ProcessInput[];
  agents: Map<string, FakeAgent>;
  openPanes(): string[];
  openWorkspaces(): string[];
  workspaceLabels(): string[];
};

/** `\u001b[1m…\u001b[0m` is the bold both TUIs put on the option the cursor is sitting on. */
const BOLD = (text: string) => `\u001b[1m${text}\u001b[0m`;

const SCREENS: Record<string, Partial<Record<StartupBlock, string>>> = {
  claude: {
    trust:
      "Accessing workspace: Quick safety check: Is this a project you created or one you trust?" +
      " (Like your own code, a well-known open source project, or work from your team)." +
      " Claude Code'll be able to read, edit, and execute files here. ❯ No, exit" +
      ` ${BOLD("Yes, I trust this folder")} Enter to confirm · Esc to cancel`,
  },
  codex: {
    trust:
      "You are in the directory. Do you trust the contents of this directory? Working with" +
      ` untrusted contents comes with higher risk of prompt injection. › ${BOLD("1. Yes, continue")}` +
      " 2. No, quit Press enter to continue",
    update:
      "✨ Update available! 0.155.0 -> 0.155.1 Release notes:" +
      ` https://github.com/openai/codex/releases/latest › ${BOLD("1. Update now")} (runs \`sh -c 'curl -fsSL` +
      " https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`) 2. Skip" +
      " 3. Skip until next version Press enter to continue",
  },
};

/**
 * Both Codex blocks say "Press enter to continue", and on the update block that selects the option
 * that runs the installer: the two are told apart by their text, never by their shape. `answered`
 * leaves the block in place, which is what a host that sends the wrong keys actually sees.
 */
function answerBlock(
  block: StartupBlock,
  kind: string,
  keys: string,
): { answered: boolean; ranInstaller: boolean } {
  if (block === "trust") {
    const expected = kind === "claude" ? "down enter" : "enter";
    return { answered: keys === expected, ranInstaller: false };
  }
  if (keys === "enter") return { answered: true, ranInstaller: true };
  return { answered: keys === "2" || keys === "3" || keys === "down enter", ranInstaller: false };
}

export function createFakeHerdr(options: FakeHerdrOptions = {}): FakeHerdr {
  const rootColumns = options.rootColumns ?? 180;
  const inputReadyAfterMs = options.inputReadyAfterMs ?? 0;
  const startupBlocks = options.startupBlocks ?? ["trust"];
  const hardWrap = options.hardWrap ?? false;

  const calls: ProcessInput[] = [];
  const agents = new Map<string, FakeAgent>();
  const detectionPolls = options.detectionPolls ?? 2;
  const panes = new Map<string, FakePane>();
  let terminalCount = 0;
  const newPane = (
    env: Record<string, string>,
    tab: string,
    rect: Rect = { x: 0, y: 0, width: rootColumns, height: ROOT_ROWS },
  ): FakePane => ({
    env,
    columns: rect.width,
    tab,
    // A login shell's prompt, which may look like the confined shell's.
    screen: ["user@host ~ % "],
    typed: [],
    terminalId: `term_${++terminalCount}`,
    rect,
  });
  const paneInfo = (paneId: string) => {
    const pane = panes.get(paneId)!;
    return { pane_id: paneId, tab_id: pane.tab, terminal_id: pane.terminalId };
  };
  /** Open workspaces, by id, to their labels. */
  const workspaces = new Map<string, string>();
  const answeredAt = new Map<string, number>();
  let workspaceCount = 0;
  let paneCount = 0;
  let tabCount = 0;

  const run: RunProcess = async (input) => {
    calls.push(input);
    const argv = [...input.argv];
    if (argv[1] === "--version") {
      return {
        stdout: `${options.version === undefined ? HERDR_VERSION : `herdr ${options.version}`}\n`,
        stderr: "",
        exitCode: 0,
        timedOut: false,
      };
    }
    const command = argv.slice(3, 5).join(" ");
    const target = argv[5] ?? "";

    switch (command) {
      case "workspace create": {
        workspaceCount += 1;
        const workspaceId = `w${workspaceCount}`;
        workspaces.set(workspaceId, readOption(argv, "--label") ?? String(workspaceCount));
        paneCount += 1;
        tabCount += 1;
        const paneId = `${workspaceId}:p${paneCount}`;
        const tabId = `${workspaceId}:t${tabCount}`;
        panes.set(paneId, newPane(readEnv(argv), tabId));
        return ok({
          workspace: { workspace_id: workspaceId },
          tab: { tab_id: tabId },
          root_pane: paneInfo(paneId),
        });
      }
      case "tab create": {
        const workspaceId = readOption(argv, "--workspace") ?? "";
        if (!workspaces.has(workspaceId)) {
          return fail("workspace_not_found", `workspace ${workspaceId} not found`);
        }
        paneCount += 1;
        tabCount += 1;
        const paneId = `${workspaceId}:p${paneCount}`;
        const tabId = `${workspaceId}:t${tabCount}`;
        // Only this command's own `--env`: the tab is a separately launched process.
        panes.set(paneId, newPane(readEnv(argv), tabId));
        return ok({ tab: { tab_id: tabId }, root_pane: paneInfo(paneId) });
      }
      case "workspace list": {
        return ok({
          workspaces: [...workspaces].map(([id, label]) => ({ workspace_id: id, label })),
        });
      }
      case "tab rename": {
        return [...panes.values()].some((pane) => pane.tab === target)
          ? ok({})
          : fail("tab_not_found", `tab ${target} not found`);
      }
      case "tab close": {
        for (const [paneId, pane] of panes) if (pane.tab === target) panes.delete(paneId);
        return ok({});
      }
      case "pane split": {
        const pane = panes.get(target);
        if (!pane) return fail("pane_not_found", `pane ${target} not found`);
        // The ratio is the part the split pane keeps.
        const ratio = Number(readOption(argv, "--ratio") ?? "0.5");
        const right = readOption(argv, "--direction") === "right";
        const { x, y, width, height } = pane.rect;
        const kept = Math.round((right ? width : height) * ratio);
        pane.rect = right ? { x, y, width: kept, height } : { x, y, width, height: kept };
        pane.columns = pane.rect.width;
        const rect = right
          ? { x: x + kept, y, width: width - kept, height }
          : { x, y: y + kept, width, height: height - kept };
        paneCount += 1;
        const paneId = `${target.split(":")[0]}:p${paneCount}`;
        panes.set(paneId, newPane(readEnv(argv), pane.tab, rect));
        return ok({ pane: paneInfo(paneId) });
      }
      case "pane close": {
        if (!panes.delete(target)) return fail("pane_not_found", `pane ${target} not found`);
        return ok({});
      }
      case "pane rename": {
        const pane = panes.get(target);
        if (!pane) return fail("pane_not_found", `pane ${target} not found`);
        pane.label = argv[6] ?? "";
        return ok({ pane: paneInfo(target) });
      }
      case "pane layout": {
        const pane = panes.get(readOption(argv, "--pane") ?? "");
        if (!pane) return fail("pane_not_found", "pane not found");
        return ok({
          layout: {
            area: { x: 0, y: 0, width: rootColumns, height: ROOT_ROWS },
            tab_id: pane.tab,
            panes: [...panes]
              .filter(([, other]) => other.tab === pane.tab)
              .map(([paneId, other]) => ({ pane_id: paneId, rect: other.rect })),
          },
        });
      }
      case "pane get": {
        return panes.has(target)
          ? ok({ pane: { pane_id: target } })
          : fail("pane_not_found", `pane ${target} not found`);
      }
      case "workspace close": {
        workspaces.delete(target);
        for (const paneId of [...panes.keys()]) {
          if (paneId.startsWith(`${target}:`)) panes.delete(paneId);
        }
        return ok({});
      }
      case "pane read": {
        const pane = panes.get(target);
        if (!pane) return fail("pane_not_found", `pane ${target} not found`);
        return { stdout: pane.screen.join("\n"), stderr: "", exitCode: 0, timedOut: false };
      }
      case "pane run": {
        const pane = panes.get(target);
        if (!pane) return fail("pane_not_found", `pane ${target} not found`);
        const text = argv[6] ?? "";
        pane.typed.push(text);
        pane.screen.push(text);
        if (text.startsWith("exec ")) {
          // zsh draws `%#` and `%%` as `%`; a shell that never took the prelude draws its own.
          const prompt = /PROMPT='([^']*)'/.exec(text)?.[1];
          pane.screen.push(
            prompt && !options.swallowsPrelude
              ? prompt.replaceAll("%#", "%").replaceAll("%%", "%")
              : "user@host ~ % ",
          );
        } else {
          const kind = (text.split(" ")[0] ?? "").replaceAll("'", "");
          if (kind === "claude" || kind === "codex" || kind === "pi") {
            pane.typedHarness = { kind, polls: 0 };
          }
        }
        return ok({});
      }
      case "agent rename": {
        const pane = panes.get(target);
        const name = argv[6] ?? "";
        if (!pane) return fail("pane_not_found", `pane ${target} not found`);
        if (agents.has(name)) return fail("agent_name_taken", `agent name ${name} is already used`);
        const typed = pane.typedHarness;
        if (!typed || ++typed.polls <= detectionPolls) {
          return fail("agent_not_found", `no agent detected in pane ${target}`);
        }
        agents.set(name, {
          name,
          kind: typed.kind,
          paneId: target,
          blocks: [...startupBlocks],
          ranInstaller: false,
          delivered: [],
          discarded: [],
          answeredScreens: [],
          emptied: [],
        });
        if (startupBlocks.length === 0) answeredAt.set(name, Date.now());
        return ok(agentInfo(name, startupBlocks.length === 0 ? "idle" : "blocked"));
      }
      case "agent start": {
        if (agents.has(target)) {
          return fail("agent_name_taken", `agent name ${target} is already used`);
        }
        const paneId = readOption(argv, "--pane") ?? "";
        const pane = panes.get(paneId);
        if (!pane) return fail("pane_not_found", `pane ${paneId} not found`);
        const agent: FakeAgent = {
          name: target,
          kind: readOption(argv, "--kind") ?? "claude",
          paneId,
          blocks: [...startupBlocks],
          ranInstaller: false,
          delivered: [],
          discarded: [],
          answeredScreens: [],
          emptied: Object.entries(pane.env)
            .filter(([, value]) => value === "")
            .map(([name]) => name),
        };
        agents.set(target, agent);
        if (agent.blocks.length === 0) {
          answeredAt.set(target, Date.now());
          return ok(agentInfo(target, "idle"));
        }
        return fail("agent_not_ready", `agent ${target} is blocked during startup`);
      }
      case "agent read": {
        const agent = agents.get(target);
        if (!agent) return fail("agent_not_found", `agent ${target} not found`);
        const block = agent.blocks[0];
        const current =
          block === undefined ? "ready" : (SCREENS[agent.kind]?.[block] ?? "unknown block");
        // A pane does not repaint an answered block away on its own, so the live one is below it.
        const screen = [...agent.answeredScreens, current].join(" ");
        return {
          stdout: wrap(screen, panes.get(agent.paneId)?.columns ?? rootColumns, hardWrap),
          stderr: "",
          exitCode: 0,
          timedOut: false,
        };
      }
      case "agent send-keys": {
        const agent = agents.get(target);
        if (!agent) return fail("agent_not_found", `agent ${target} not found`);
        const block = agent.blocks[0];
        if (block === undefined) return ok({});
        const outcome = answerBlock(block, agent.kind, argv.slice(6).join(" "));
        if (outcome.ranInstaller) agent.ranInstaller = true;
        if (outcome.answered) {
          agent.answeredScreens.push(SCREENS[agent.kind]?.[block] ?? "unknown block");
          agent.blocks.shift();
          if (agent.blocks.length === 0) answeredAt.set(target, Date.now());
        }
        return ok({});
      }
      case "agent wait": {
        const agent = agents.get(target);
        if (!agent) return fail("agent_not_found", `agent ${target} not found`);
        // Herdr reports ready here even while the agent's UI is still repainting.
        return ok(agentInfo(target, agent.blocks.length > 0 ? "blocked" : "idle"));
      }
      case "agent prompt": {
        const agent = agents.get(target);
        if (!agent) return fail("agent_not_found", `agent ${target} not found`);
        if (agent.blocks.length > 0) return fail("agent_blocked", `agent ${target} is blocked`);
        if (Date.now() - (answeredAt.get(target) ?? 0) < inputReadyAfterMs) {
          agent.discarded.push(argv[6] ?? "");
          return fail(
            "agent_prompt_stalled",
            "agent prompt produced no observed state change within 5000 ms;" +
              " status is idle and state_change_seq remained 2113",
          );
        }
        agent.delivered.push(argv[6] ?? "");
        return ok(agentInfo(target, "done"));
      }
      default:
        return ok({});
    }
  };

  return {
    run,
    panes,
    calls,
    agents,
    openPanes: () => [...panes.keys()],
    openWorkspaces: () => [...workspaces.keys()],
    workspaceLabels: () => [...workspaces.values()],
  };
}

function agentInfo(name: string, status: string): Record<string, unknown> {
  return {
    agent: {
      name,
      agent_status: status,
      interactive_ready: true,
      agent_session: { kind: "id", value: `session-${name}` },
    },
  };
}

function wrap(text: string, columns: number, hard: boolean): string {
  // Hard wrapping breaks mid-word, so the two halves have no space between them: a matcher that
  // turns every run of whitespace into one space reassembles `directory?` as `direc tory?`.
  if (hard) return (text.match(new RegExp(`.{1,${Math.max(1, columns)}}`, "gs")) ?? []).join("\n");
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line === "") line = word;
    else if (`${line} ${word}`.length <= columns) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

function readOption(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readEnv(argv: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--env") continue;
    const pair = argv[index + 1] ?? "";
    const split = pair.indexOf("=");
    if (split > 0) env[pair.slice(0, split)] = pair.slice(split + 1);
  }
  return env;
}

function ok(result: Record<string, unknown>): ProcessResult {
  return { stdout: JSON.stringify({ result }), stderr: "", exitCode: 0, timedOut: false };
}

function fail(code: string, message: string): ProcessResult {
  return {
    stdout: "",
    stderr: JSON.stringify({ error: { code, message } }),
    exitCode: 1,
    timedOut: false,
  };
}
