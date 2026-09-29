import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessSandboxNeeds } from "@agentswf/sandbox";
import { seedHome } from "./sandbox-homes";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function seeded() {
  const root = mkdtempSync(join(tmpdir(), "wf-homes-"));
  roots.push(root);
  const operator = join(root, "operator-auth.json");
  const home = join(root, "home");
  await writeFile(operator, '{"account":"a1","refresh":"one"}', { mode: 0o600 });
  const needs = {
    seed: [{ from: operator, to: join(home, "auth.json"), refreshes: ["refresh"] }],
    defaults: (cwd: string) => [
      { path: join(home, "settings.json"), contents: `{"cwd":"${cwd}"}` },
    ],
  } as unknown as HarnessSandboxNeeds;
  const seed = await seedHome(home, join(root, "staging", "a"), needs, "/repo", new Map());
  return { root, operator, copy: join(home, "auth.json"), home, seed };
}

test("seeds a private home with a private copy, and its harness's defaults", async () => {
  const { root, home, copy } = await seeded();
  expect(await readFile(join(home, "settings.json"), "utf8")).toBe('{"cwd":"/repo"}');
  expect((await stat(home)).mode & 0o777).toBe(0o700);
  expect((await stat(copy)).mode & 0o777).toBe(0o600);
  expect(await readFile(copy, "utf8")).toBe('{"account":"a1","refresh":"one"}');
  expect(await readdir(join(root, "staging"))).toEqual([]);
});

test("a link planted where the home goes refuses the home, never written through", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-homes-"));
  roots.push(root);
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);
  await mkdir(join(root, "homes"));
  await symlink(elsewhere, join(root, "homes", "a"));
  const needs = {
    seed: [],
    defaults: () => [{ path: join(root, "homes", "a", "settings.json"), contents: "{}" }],
  } as unknown as HarnessSandboxNeeds;
  await expect(
    seedHome(join(root, "homes", "a"), join(root, "staging", "a"), needs, "/repo", new Map()),
  ).rejects.toThrow();
  expect(await readdir(elsewhere)).toEqual([]);
});

test("a refreshed copy is written back atomically, private, and becomes the baseline", async () => {
  const { root, operator, copy, seed } = await seeded();
  await seed.writeBack();
  expect(await readFile(operator, "utf8")).toBe('{"account":"a1","refresh":"one"}');

  await writeFile(copy, '{"account":"a1","refresh":"two"}');
  await seed.writeBack();
  expect(await readFile(operator, "utf8")).toBe('{"account":"a1","refresh":"two"}');
  expect((await stat(operator)).mode & 0o777).toBe(0o600);
  expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

  // The written value is the baseline now, so a second refresh goes back too.
  await writeFile(copy, '{"account":"a1","refresh":"three"}');
  await seed.writeBack();
  expect(await readFile(operator, "utf8")).toBe('{"account":"a1","refresh":"three"}');
});

test("a refresh under any key a `*` stands for goes back; a field it names may appear", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-homes-"));
  roots.push(root);
  const operator = join(root, "auth.json");
  await writeFile(operator, '{"a":{"id":"1","token":"t1"},"b":{"id":"2"}}');
  const copy = join(root, "home", "auth.json");
  const needs = {
    seed: [{ from: operator, to: copy, refreshes: ["*.token"] }],
    defaults: () => [],
  } as unknown as HarnessSandboxNeeds;
  const seed = await seedHome(join(root, "home"), join(root, "staging"), needs, "/r", new Map());
  const refreshed = '{"a":{"id":"1","token":"t2"},"b":{"id":"2","token":"t3"}}';
  await writeFile(copy, refreshed);
  await seed.writeBack();
  expect(await readFile(operator, "utf8")).toBe(refreshed);
  await writeFile(copy, '{"a":{"id":"9","token":"t2"},"b":{"id":"2","token":"t3"}}');
  await expect(seed.writeBack()).rejects.toThrow("changed at a.id, which no refresh does");
  expect(await readFile(operator, "utf8")).toBe(refreshed);
});

test("a copy changed beyond what a refresh rewrites is refused once, and left alone", async () => {
  const { operator, copy, seed } = await seeded();
  const cases: [string, string][] = [
    ['{"account":"a2","refresh":"two"}', "account"],
    ['{"refresh":"two"}', "account"],
    ['{"account":"a1","refresh":"two","extra":true}', "extra"],
    ['{"account":"a1","refresh":"two","__proto__":{}}', "__proto__"],
    ['{"account":"a1","refresh":{"nested":"two"}}', "refresh"],
    ["[]", "its top"],
  ];
  for (const [swapped, at] of cases) {
    await writeFile(copy, swapped);
    await expect(seed.writeBack()).rejects.toThrow(`changed at ${at}, which no refresh does`);
    expect(await readFile(operator, "utf8")).toBe('{"account":"a1","refresh":"one"}');
  }
  // The same copy is not said again at the next operation.
  await seed.writeBack();
});

test("a copy that does not parse is refused; one after the operator logged in is left alone", async () => {
  const { operator, copy, seed } = await seeded();
  await writeFile(copy, '{"refresh":');
  await expect(seed.writeBack()).rejects.toThrow("changed at its top");
  expect(await readFile(operator, "utf8")).toBe('{"account":"a1","refresh":"one"}');

  await writeFile(operator, '{"refresh":"the operator logged in again"}');
  await writeFile(copy, '{"account":"a1","refresh":"two"}');
  await seed.writeBack();
  expect(await readFile(operator, "utf8")).toBe('{"refresh":"the operator logged in again"}');
});

test("a copy the agent replaced with a link is never followed", async () => {
  const { root, operator, copy, seed } = await seeded();
  const secret = join(root, "secret.json");
  await writeFile(secret, '{"secret":"elsewhere"}');
  await rm(copy);
  await symlink(secret, copy);
  await seed.writeBack();
  expect(await readFile(operator, "utf8")).toBe('{"account":"a1","refresh":"one"}');
});

test("a missing credential is refused, naming it", async () => {
  const root = mkdtempSync(join(tmpdir(), "wf-homes-"));
  roots.push(root);
  const needs = {
    seed: [{ from: join(root, "absent.json"), to: join(root, "home", "auth.json") }],
    defaults: () => [],
  } as unknown as HarnessSandboxNeeds;
  await expect(
    seedHome(join(root, "home"), join(root, "staging"), needs, "/repo", new Map()),
  ).rejects.toThrow(`${join(root, "absent.json")} is missing`);
  // Nothing it copied is left behind.
  expect(await readdir(root)).toEqual([]);
});
