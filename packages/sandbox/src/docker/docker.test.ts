import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerEnvironment } from "@agentswf/contract/workflow";
import { RECORD_LEADER } from "../groups";
import type { AgentContext, ResolvedSandbox, SandboxContext } from "../seam";
import { createDockerProvider, type DockerClient, type DockerResult } from ".";
import { mountArgs } from "./args";

const root = realpathSync(mkdtempSync(join(tmpdir(), "wf-docker-unit-")));
afterAll(() => rm(root, { recursive: true, force: true }));

/** A client that answers every command as a healthy daemon would, and plays the relay. */
function fakeClient(fail: (args: readonly string[]) => boolean = () => false) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const quarantinedLast: string[][] = [];
  const relays: {
    args: string[];
    written: string[];
    send(line: string): void;
    killed: boolean;
  }[] = [];
  const client: DockerClient = {
    command: "/usr/local/bin/docker",
    environment: { PATH: "/usr/bin", HOME: "/Users/op", DOCKER_CONTEXT: "orbstack" },
    async run(args, options = {}): Promise<DockerResult> {
      calls.push({
        args: [...args],
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      });
      if (fail(args)) return { stdout: "", stderr: "no such thing", exitCode: 1 };
      // A box sees the host's paths where it mounts them: its quarantine runs as the box would,
      // but for its last `kill -STOP -1`, which here would stop every process of the operator's.
      const script = args[0] === "exec" && args[2] === "sh" ? args[4] : undefined;
      if (script?.includes("q=$1")) {
        const last = "kill -STOP -1 2>/dev/null; ";
        if (script.startsWith(last)) quarantinedLast.push(args.slice(7));
        const ran = Bun.spawnSync(["sh", "-c", script.replace(last, ""), ...args.slice(5)]);
        return {
          stdout: ran.stdout.toString(),
          stderr: ran.stderr.toString(),
          exitCode: ran.exitCode,
        };
      }
      if (args[0] === "version") return { stdout: "29.4.0\n", stderr: "", exitCode: 0 };
      if (args[0] === "inspect") return { stdout: "sha256:digest\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    spawn(args) {
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      const relay = {
        args: [...args],
        written: [] as string[],
        killed: false,
        send(line: string) {
          queue.push(line);
          wake?.();
        },
      };
      relays.push(relay);
      async function* lines() {
        while (!relay.killed) {
          if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
          const line = queue.shift();
          if (line !== undefined) yield line;
        }
      }
      async function* stderr() {
        yield "ready";
      }
      return {
        stdin: { write: (line) => relay.written.push(line), end: () => undefined },
        lines: lines(),
        stderr: stderr(),
        kill: () => {
          relay.killed = true;
          wake?.();
        },
      };
    },
  };
  const verbs = (from = 0) => calls.slice(from).map(({ args }) => args.slice(0, 2).join(" "));
  return { client, calls, relays, verbs, quarantinedLast };
}

const runRoot = join(root, "runs");
const directory = join(runRoot, "r", "sandboxes", "s1");
const context: SandboxContext = {
  runRoot,
  directory,
  deadline: { unixMilliseconds: Date.now() + 60_000 },
};
const repo = join(root, "repo");
const spec: ResolvedSandbox<DockerEnvironment> = {
  key: "box",
  cwd: repo,
  read: [join(repo, "vendor"), join(root, "notes")],
  write: [repo],
  network: ["registry.npmjs.org"],
  gitdirs: [{ path: join(repo, ".git"), writable: true }],
  environment: {},
};
const bind = (path: string, readOnly = false) =>
  `type=bind,source=${path},target=${path}${readOnly ? ",readonly" : ""}`;

describe("docker arguments", () => {
  test("mounts at the same paths, the most specific last, protected gitdir parts read-only", () => {
    const guarded = [join(repo, ".git", "hooks"), join(repo, ".git", "config")];
    const mounts = mountArgs(spec, directory, guarded).filter((arg) => arg !== "--mount");
    expect(mounts).toEqual([
      bind(repo),
      bind(join(root, "notes"), true),
      bind(join(repo, ".git")),
      bind(join(repo, "vendor"), true),
      bind(join(repo, ".git", "hooks"), true),
      bind(join(repo, ".git", "config"), true),
      bind(join(directory, "homes")),
      bind(join(directory, "quarantine")),
    ]);
    // A working directory inside `write` is writable; one outside it read-only.
    const inside = { ...spec, cwd: join(repo, "src"), read: [], gitdirs: [] };
    expect(mountArgs(inside, directory, [])).toContain(bind(join(repo, "src")));
    const outside = { ...spec, write: [], read: [], gitdirs: [] };
    expect(mountArgs(outside, directory, [])).toContain(bind(repo, true));
    expect(() => mountArgs({ ...spec, read: ["/a,b"] }, directory, [])).toThrow("comma");
  });

  test("an empty tmpfs hides a run root a mount holds, and only then", () => {
    const projectRuns = join(repo, ".awf", "runs");
    const mounts = mountArgs(spec, directory, [], projectRuns).filter((arg) => arg !== "--mount");
    expect(mounts.indexOf(`type=tmpfs,target=${projectRuns}`)).toBeGreaterThan(
      mounts.indexOf(bind(repo)),
    );
    expect(mountArgs(spec, directory, [], runRoot).join(" ")).not.toContain("tmpfs");
  });
});

describe("the docker provider", () => {
  const provider = (client: DockerClient) =>
    createDockerProvider({ client, defaultImage: "awf-agent:test", user: "501:20" });

  test("takes an image and nothing else", () => {
    const docker = provider(fakeClient().client);
    expect(docker.environment({})).toEqual({});
    expect(docker.environment({ image: "node:22" })).toEqual({ image: "node:22" });
    expect(() => docker.environment({ image: "" })).toThrow("names an image");
    expect(() => docker.environment({ mounts: [] })).toThrow(
      "docker takes only an image, not mounts",
    );
  });

  test("sweeps a box, proxy and network past their expiry, and nothing else", async () => {
    const { client: fake } = fakeClient();
    const removed: string[][] = [];
    const past = Math.floor(Date.now() / 1000) - 1;
    const later = past + 3600;
    const client: DockerClient = {
      ...fake,
      async run(args, options) {
        const format = args[args.indexOf("--format") + 1] ?? "";
        const labelled = args.includes("label=awf.sandbox") && args.includes("label=awf.expires");
        if (args[0] === "ps" && labelled) {
          // As docker does: a container has `.Names`, and `.Name` fails the template.
          if (!format.startsWith("{{.Names}}")) return { stdout: "", stderr: "", exitCode: 0 };
          return {
            stdout: `awf-a ${past}\nawf-a-proxy ${past}\nawf-b ${later}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "network" && args[1] === "ls" && labelled) {
          if (!format.startsWith("{{.Name}}")) return { stdout: "", stderr: "", exitCode: 0 };
          return { stdout: `awf-a-net ${past}\nawf-b-net ${later}\n`, stderr: "", exitCode: 0 };
        }
        if (args[0] === "rm" || (args[0] === "network" && args[1] === "rm"))
          removed.push([...args]);
        return fake.run(args, options);
      },
    };
    const opened = await provider(client).open(spec, context);
    expect(removed.slice(0, 2)).toEqual([
      ["rm", "-f", "awf-a", "awf-a-proxy"],
      ["network", "rm", "awf-a-net"],
    ]);
    await opened.close();
  });

  test("opens a box on an internal network whose one way out is its proxy", async () => {
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await writeFile(join(repo, ".git", "config"), "");
    const { client, calls, verbs } = fakeClient();
    const opened = await provider(client).open(spec, context);
    expect(verbs()).toEqual([
      "version --format",
      "image inspect",
      "ps -a",
      "network ls",
      "network create",
      "run -d",
      "network connect",
      "run -d",
      "exec -u",
      "inspect --format",
    ]);
    const find = (verb: string, nth = 0) =>
      calls.filter(({ args }) => args.slice(0, 2).join(" ") === verb)[nth]!.args;
    const net = find("network create").at(-1)!;
    expect(find("network create")).toEqual(
      expect.arrayContaining(["--internal", "--label", expect.stringMatching(/^awf.expires=\d+$/)]),
    );
    const proxy = find("run -d", 0);
    expect(proxy).toEqual(
      expect.arrayContaining([
        "--network",
        net,
        "--cap-drop",
        "ALL",
        `type=bind,source=${join(directory, "proxy")},target=/proxy,readonly`,
        "awf-agent:test",
      ]),
    );
    expect(proxy.slice(0, 3)).toEqual(["run", "-d", "--rm"]);
    // It ends on its own, as the box's `sleep` does.
    expect(proxy.slice(proxy.indexOf("awf-agent:test") + 1, proxy.indexOf("node"))).toEqual([
      "timeout",
      expect.stringMatching(/^\d+$/),
    ]);
    const proxyName = proxy[proxy.indexOf("--name") + 1]!;
    expect(find("network connect")).toEqual(["network", "connect", "bridge", proxyName]);
    const box = find("run -d", 1);
    expect(box).toEqual(
      expect.arrayContaining(["--init", "--user", "501:20", "--network", net, "no-new-privileges"]),
    );
    expect(box).toContain(`HTTPS_PROXY=http://${proxyName}:3128`);
    expect(box).toContain(bind(join(repo, ".git", "hooks"), true));
    expect(box.slice(-3, -1)).toEqual(["awf-agent:test", "sleep"]);
    // Ends on its own a while past the run's deadline.
    expect(Number(box.at(-1))).toBeGreaterThan(60);
    expect(find("exec -u").join(" ")).toContain("getent passwd 501");
    expect(await readFile(join(directory, "proxy", "allow"), "utf8")).toBe("registry.npmjs.org\n");
    expect(opened.record?.image).toBe("sha256:digest");
    expect(opened.panes).toBe(true);
    const before = calls.length;
    await opened.close();
    // One at a time, last made first: a network goes only once nothing is on it.
    expect(verbs(before)).toEqual([`logs ${proxyName}`, "rm -f", "rm -f", "network rm"]);
    expect(calls[before + 1]!.args[2]).toBe(box[box.indexOf("--name") + 1]);
  });

  test("an unbuilt default image is refused naming how to build it, before anything is made", async () => {
    const { client, verbs } = fakeClient((args) => args[0] === "image");
    await expect(provider(client).open(spec, context)).rejects.toThrow(
      "the sandbox image awf-agent:test is not built",
    );
    expect(verbs()).toEqual(["version --format", "image inspect"]);
  });

  test("a spec's own image must be here already", async () => {
    const { client } = fakeClient((args) => args[0] === "image" && args.includes("node:22"));
    await expect(
      provider(client).open({ ...spec, environment: { image: "node:22" } }, context),
    ).rejects.toThrow("pull it first: docker pull node:22");
  });

  test("a daemon that does not answer is named, and asked again at the next open", async () => {
    let answers = false;
    const { client } = fakeClient((args) => args[0] === "version" && !answers);
    const docker = provider(client);
    await expect(docker.open(spec, context)).rejects.toThrow("docker did not answer");
    answers = true;
    await (await docker.open(spec, context)).close();
  });

  test("a box that fails to start leaves nothing it may have made", async () => {
    const { client, verbs } = fakeClient((args) => args[0] === "run" && args.includes("--init"));
    await expect(provider(client).open(spec, context)).rejects.toThrow("docker run failed");
    expect(verbs().slice(-3)).toEqual(["rm -f", "rm -f", "network rm"]);
  });

  test("admits an agent: its door made by root, its relay, its domains, and its launches", async () => {
    const { client, calls, relays } = fakeClient();
    const opened = await provider(client).open(spec, context);
    await mkdir(join(root, "door"), { recursive: true });
    await writeFile(join(root, "door", "wf.js"), "bundle source");
    const agent: AgentContext = {
      cwd: repo,
      home: join(directory, "homes", "h1"),
      harness: {
        env: { CLAUDE_CONFIG_DIR: join(directory, "homes", "h1") },
        seed: [],
        defaults: () => [],
        secrets: { CLAUDE_CODE_OAUTH_TOKEN: "sk-secret-value" },
        domains: ["api.anthropic.com"],
        command: "claude",
        executable: "/host/claude",
        reads: [],
      },
      door: {
        endpoint: join(root, "door", "s.sock"),
        launcher: join(root, "door", "wf"),
        boxScript: "#!/bin/sh\nexec bun ...\n",
        bundle: join(root, "door", "wf.js"),
        reads: [],
      },
    };
    const before = calls.length;
    const occupant = await opened.admit(agent);
    const admitted = calls.slice(before);
    expect(admitted.slice(0, 3).map(({ args }) => args.slice(-2))).toEqual([
      ['command -v "$0"', "claude"],
      ['command -v "$0"', "bun"],
      ['command -v "$0"', "node"],
    ]);
    const asRoot = admitted.filter(
      ({ args }) => args.includes("-u") && args[args.indexOf("-u") + 1] === "0",
    );
    expect(asRoot.map(({ args }) => args.at(-1))).toEqual([
      join(root, "door"),
      join(root, "door", "wf.js"),
      join(root, "door", "wf"),
    ]);
    expect(asRoot[1]!.stdin).toBe("bundle source");
    expect(asRoot[2]!.stdin).toBe(agent.door.boxScript);
    expect(relays[0]!.args).toEqual(expect.arrayContaining(["-u", "0", agent.door.endpoint]));
    expect(await readFile(join(directory, "proxy", "allow"), "utf8")).toBe(
      "registry.npmjs.org\napi.anthropic.com\n",
    );

    const command = occupant.launch({
      argv: ["claude", "-p"],
      cwd: repo,
      env: { OVERLAY: "1" },
      stdin: "prompt",
      timeoutMs: 1_000,
    });
    expect(command.argv.slice(0, 7)).toEqual([
      "/usr/local/bin/docker",
      "exec",
      "-i",
      "-w",
      repo,
      "-e",
      `HOME=${agent.home}`,
    ]);
    // No `setsid`: runc makes the exec'd shell a group leader, and `setsid` would fork, losing
    // the exit code.
    expect(command.argv).not.toContain("setsid");
    expect(command.argv).toContain(`CLAUDE_CONFIG_DIR=${agent.home}`);
    expect(command.argv).toContain("OVERLAY=1");
    // The token by name only; its value rides in the client's environment.
    expect(command.argv).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(command.argv.join(" ")).not.toContain("sk-secret-value");
    expect(command.env).toEqual({
      ...client.environment,
      CLAUDE_CODE_OAUTH_TOKEN: "sk-secret-value",
    });
    expect(command.argv.slice(-2)).toEqual(["claude", "-p"]);
    expect(command).toMatchObject({ group: true, stdin: "prompt", timeoutMs: 1_000 });

    // A turn's reap kills its group in the box, and a `commondir` an agent made is moved out.
    await writeFile(join(repo, ".git", "commondir"), "../elsewhere\n");
    await command.reap!();
    const box = command.argv[command.argv.indexOf("sh") - 1]!;
    const reap = calls.findLast(
      ({ args }) => args[0] === "exec" && args[4]?.includes("kill -9"),
    )!.args;
    expect(reap.slice(0, 2)).toEqual(["exec", box]);
    expect(reap[4]).toContain("kill -9");
    expect(reap.at(-1)).toBe(command.argv[command.argv.indexOf(RECORD_LEADER) + 1]);
    expect(await stat(join(repo, ".git", "commondir")).catch(() => undefined)).toBeUndefined();
    const quarantined = await readdir(join(directory, "quarantine"));
    expect(quarantined).toEqual([expect.stringMatching(/-commondir$/)]);

    // A pane: the box's Herdr started once, the secret through stdin, and nothing of it on argv.
    const beforePanes = calls.length;
    const pane = await occupant.pane!();
    const second = await occupant.pane!();
    const paned = calls.slice(beforePanes);
    expect(paned.filter(({ args }) => args.includes("server"))).toHaveLength(1);
    const written = paned.filter(({ stdin }) => stdin?.includes("sk-secret-value"));
    expect(written.map(({ stdin }) => stdin)).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN='sk-secret-value'\n",
      "CLAUDE_CODE_OAUTH_TOKEN='sk-secret-value'\n",
    ]);
    expect(paned.some(({ args }) => args.join(" ").includes("sk-secret-value"))).toBe(false);
    expect(pane.prelude).not.toContain("sk-secret-value");
    expect(pane.prelude).not.toContain(pane.ready.trimEnd());
    expect(pane.prelude).toContain("HTTPS_PROXY=");
    expect(pane.prelude).toContain(`HOME='${agent.home}'`);
    expect(pane.harness).toBe("claude");
    expect(second.ready).not.toBe(pane.ready);
    if (pane.herdr === "run") throw new Error("a box's panes are in its own Herdr");
    expect(second.herdr).toBe(pane.herdr);
    const listed = pane.herdr.run(["pane", "list"], 1_000);
    expect(listed.argv.slice(0, 5)).toEqual([
      "/usr/local/bin/docker",
      "exec",
      "-i",
      "-e",
      "HOME=/tmp/awf-herdr",
    ]);
    expect(listed.argv.slice(-3)).toEqual(["herdr", "pane", "list"]);
    // The box's own Herdr, where its panes are, reached as the operator.
    expect(pane.herdr.watch).toEqual([
      "docker",
      "exec",
      "-it",
      "-e",
      "HOME=/tmp/awf-herdr",
      expect.stringMatching(/^awf-/),
      "herdr",
    ]);
    expect(listed).toMatchObject({ group: true, timeoutMs: 1_000 });

    await occupant.release();
    // A secret no pane read goes at release.
    const removed = calls.findLast(({ args }) => args.includes("rm"))!.args;
    expect(removed.filter((arg) => arg.startsWith("/tmp/awf-secrets/"))).toHaveLength(2);
    expect(relays[0]!.killed).toBe(true);
    expect(() => occupant.launch({ argv: ["claude"], timeoutMs: 1 })).toThrow("released");
    await opened.close();
  });

  test("the relay carries each request to the engine's socket and its reply back", async () => {
    const endpoint = join(root, "relay.sock");
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      let said = "";
      socket.on("data", (chunk) => {
        said += chunk;
      });
      socket.on("end", () => socket.end(`reply to ${said}`));
    });
    await new Promise<void>((resolve) => server.listen(endpoint, resolve));
    try {
      const { client, relays } = fakeClient();
      const opened = await provider(client).open(spec, context);
      await writeFile(join(root, "relay.js"), "");
      const occupant = await opened.admit({
        cwd: repo,
        home: join(directory, "homes", "h2"),
        harness: {
          env: {},
          seed: [],
          secrets: {},
          defaults: () => [],
          domains: [],
          command: "codex",
          executable: "/host/codex",
          reads: [],
        },
        door: {
          endpoint,
          launcher: join(root, "wf"),
          boxScript: "",
          bundle: join(root, "relay.js"),
          reads: [],
        },
      });
      relays[0]!.send(JSON.stringify({ id: 7, b64: Buffer.from("request").toString("base64") }));
      for (let tries = 0; tries < 100 && relays[0]!.written.length === 0; tries++) {
        await Bun.sleep(10);
      }
      const reply = JSON.parse(relays[0]!.written[0]!);
      expect(reply.id).toBe(7);
      expect(Buffer.from(reply.b64, "base64").toString()).toBe("reply to request");
      await occupant.release();
      await opened.close();
    } finally {
      server.close();
    }
  });

  test("a link among protected paths is never mounted or followed: changed, it is moved", async () => {
    const outside = join(root, "dotfiles");
    await mkdir(join(outside, "claude"), { recursive: true });
    await writeFile(join(outside, "claude", "settings.json"), "operator's");
    await writeFile(join(outside, "mcp.json"), "operator's");
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await symlink(join(outside, "mcp.json"), join(repo, ".mcp.json"));
    const { client, calls } = fakeClient();
    const opened = await provider(client).open(spec, context);
    const box = calls.filter(({ args }) => args[0] === "run")[1]!.args;
    expect(box.join(" ")).not.toContain(".mcp.json");
    // An agent points `.claude` at the operator's, and the kept link elsewhere.
    await symlink(join(outside, "claude"), join(repo, ".claude"));
    await rm(join(repo, ".mcp.json"));
    await symlink(join(root, "notes"), join(repo, ".mcp.json"));
    await opened.close();
    expect(await readFile(join(outside, "claude", "settings.json"), "utf8")).toBe("operator's");
    expect(await readFile(join(outside, "mcp.json"), "utf8")).toBe("operator's");
    expect(await lstat(join(repo, ".claude")).catch(() => undefined)).toBeUndefined();
    expect(await lstat(join(repo, ".mcp.json")).catch(() => undefined)).toBeUndefined();
    expect(opened.record?.quarantined).toEqual(
      expect.arrayContaining([join(repo, ".claude"), join(repo, ".mcp.json")]),
    );
  });

  test("a kept link an agent replaced with a directory of its own is moved whole", async () => {
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await mkdir(join(root, "dots"), { recursive: true });
    await symlink(join(root, "dots"), join(repo, ".claude"));
    const { client, quarantinedLast } = fakeClient();
    const opened = await provider(client).open(spec, context);
    await rm(join(repo, ".claude"));
    await mkdir(join(repo, ".claude"));
    await writeFile(join(repo, ".claude", "settings.json"), "the agent's");
    await opened.close();
    expect(await lstat(join(repo, ".claude")).catch(() => undefined)).toBeUndefined();
    expect(opened.record?.quarantined).toEqual([join(repo, ".claude")]);
    // At close, after nothing of the box's is left running.
    expect(quarantinedLast).toEqual([[join(repo, ".claude")]]);
  });

  test("a link made above a kept link is moved, and the operator's file never is", async () => {
    const outside = join(root, "home-claude");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "settings.json"), "operator's");
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await mkdir(join(repo, ".claude"), { recursive: true });
    await mkdir(join(repo, "shared"), { recursive: true });
    await writeFile(join(repo, "shared", "s.json"), "kept");
    await symlink(join(repo, "shared", "s.json"), join(repo, ".claude", "settings.json"));
    const { client } = fakeClient();
    const opened = await provider(client).open(spec, context);
    await rename(join(repo, ".claude"), join(repo, ".claude-old"));
    await symlink(outside, join(repo, ".claude"));
    await opened.close();
    expect(await readFile(join(outside, "settings.json"), "utf8")).toBe("operator's");
    expect(opened.record?.quarantined).toEqual([join(repo, ".claude")]);
    await rm(join(repo, ".claude-old"), { recursive: true });
    await rm(join(repo, "shared"), { recursive: true });
  });

  test("a protected file a renamed directory put back is moved; one edited in place stays", async () => {
    await mkdir(join(repo, ".git", "hooks"), { recursive: true });
    await mkdir(join(repo, ".claude"), { recursive: true });
    await writeFile(join(repo, ".claude", "settings.json"), "operator's");
    await writeFile(join(repo, ".gitmodules"), "operator's");
    const { client } = fakeClient();
    const opened = await provider(client).open(spec, context);
    // The operator edits one on the host: a new file, in the same directory.
    await rm(join(repo, ".gitmodules"));
    await writeFile(join(repo, ".gitmodules"), "operator's, edited");
    // An agent moves the other's directory away, and makes it again with its own.
    await rename(join(repo, ".claude"), join(repo, ".claude-moved"));
    await mkdir(join(repo, ".claude"));
    await writeFile(join(repo, ".claude", "settings.json"), "the agent's");
    await opened.close();
    expect(await readFile(join(repo, ".gitmodules"), "utf8")).toBe("operator's, edited");
    expect(
      await lstat(join(repo, ".claude", "settings.json")).catch(() => undefined),
    ).toBeUndefined();
    expect(opened.record?.quarantined).toEqual([join(repo, ".claude", "settings.json")]);
    await rm(join(repo, ".claude-moved"), { recursive: true });
    await rm(join(repo, ".gitmodules"));
  });

  // The run root is refused for every provider, by `resolveSandbox`.
  test("refuses a mount that would expose the daemon's socket", async () => {
    const { client } = fakeClient();
    await expect(provider(client).open({ ...spec, read: ["/var/run"] }, context)).rejects.toThrow(
      "holds docker's socket",
    );
  });
});
