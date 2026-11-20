import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as bun from "bun";
import * as legacy from "./fixtures/app/legacy.cjs";
import * as service from "./fixtures/app/service";
import { Mocks } from "./mock";
import { shared } from "./state";

const state = shared();

beforeEach(() => {
  state.refused.length = 0;
  state.phase = "body";
});

afterEach(() => {
  mock.restore();
});

describe("c.mock", () => {
  test("fakes the functions given and returns their spies, which record calls", async () => {
    const mocks = new Mocks();
    const spies = mocks.module(service, { list: async () => ["x"] });
    expect(await service.list()).toEqual(["x"]);
    expect((spies.list as { mock: { calls: unknown[] } }).mock.calls).toEqual([[]]);
  });

  test("refuses every other function, recording it even when the caller catches it", async () => {
    new Mocks().module(service, { list: async () => [] });
    await expect(service.remove("a")).rejects.toThrow(
      "no fake for service.remove in this case: fake it, or name it in `real` if it is a pure helper",
    );
    expect(state.refused).toEqual([
      {
        what: "service.remove",
        by: "function",
        phase: "body",
        message:
          "no fake for service.remove in this case: fake it, or name it in `real` if it is a pure helper",
      },
    ]);
  });

  test("leaves a function named in real, and classes, real", () => {
    new Mocks().module(service, {}, { real: ["parse"] });
    expect(service.parse("a,b")).toEqual(["a", "b"]);
    expect(new service.ServiceError("x")).toBeInstanceOf(service.ServiceError);
    expect(state.refused).toEqual([]);
  });

  test("refuses an exported object's function members until they are faked", async () => {
    const mocks = new Mocks();
    mocks.module(service, {});
    await expect(service.client.ping()).rejects.toThrow("no fake for service.client.ping");
    mocks.module(service.client, { ping: async () => "pong" });
    expect(await service.client.ping()).toBe("pong");
    await expect(service.client.reply("x")).rejects.toThrow("no fake for service.client.reply");
  });

  test("a second c.mock of a module keeps the first one's fakes", async () => {
    const mocks = new Mocks();
    mocks.module(service, { list: async () => ["x"] });
    mocks.module(service, { send: async () => {} });
    expect(await service.list()).toEqual(["x"]);
    await service.send("a", "b");
    expect(state.refused).toEqual([]);
  });

  test("fakes a class's methods on its prototype, leaving its constructor real", async () => {
    new Mocks().module(service.Sender.prototype, { send: async () => "sent" });
    const sender = new service.Sender();
    expect(sender).toBeInstanceOf(service.Sender);
    expect(await sender.send("x")).toBe("sent");
    await expect(sender.archive()).rejects.toThrow("no fake for Sender.archive");
  });

  test("refuses a key the module doesn't export, or one that isn't a function", () => {
    const mocks = new Mocks();
    expect(() => mocks.module(service, { nope: () => 1 })).toThrow(
      "c.mock: service has no export nope",
    );
    expect(() => mocks.module(service.client, { ping: "x" as never })).toThrow(
      "the fake for ping is no function",
    );
  });

  test("refuses node: modules and bun", () => {
    const mocks = new Mocks();
    expect(() => mocks.module(fs, {})).toThrow("c.mock refuses node:fs");
    expect(() => mocks.module(bun, {})).toThrow("c.mock refuses bun");
    expect(fs.existsSync(import.meta.path)).toBe(true);
  });

  test("patches a CommonJS module on its named export and on default", () => {
    const mocks = new Mocks();
    const spies = mocks.module(legacy, { greet: () => "faked" });
    expect(legacy.greet("a")).toBe("faked");
    expect((legacy as unknown as { default: typeof legacy }).default.greet("a")).toBe("faked");
    expect(() => legacy.shout("a")).toThrow("no fake for legacy.shout");
    expect((spies.greet as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  test("lists a fake never called as unused, unless observe read its .mock", () => {
    const mocks = new Mocks();
    const spies = mocks.module(service, { list: async () => [], send: async () => {} }) as Record<
      string,
      { mock: { calls: unknown[] } }
    >;
    mocks.module(service.client, { ping: async () => "pong" });
    expect(mocks.unused()).toEqual(["service.list", "service.send", "service.client.ping"]);
    state.phase = "observe";
    expect(spies.send!.mock.calls).toHaveLength(0);
    expect(mocks.unused()).toEqual(["service.list", "service.client.ping"]);
  });
});

describe("c.fake", () => {
  type Db = service.Db;

  test("spies on the functions given and passes plain values through", async () => {
    const mocks = new Mocks();
    const db = mocks.fake<Db>({ name: "db1", query: async () => ["row"] });
    expect(db.name).toBe("db1");
    expect(await db.query("q")).toEqual(["row"]);
    expect((db.query as unknown as { mock: { calls: unknown[] } }).mock.calls).toEqual([["q"]]);
  });

  test("refuses a member not given, when called, and labels it", () => {
    const mocks = new Mocks();
    const db = mocks.fake<Db>({ query: async () => [] }, { name: "Db" });
    expect(() => db.close()).toThrow("no fake for Db.close in this case: fake it");
    expect(state.refused.map((each) => each.what)).toEqual(["Db.close"]);
  });

  test("can be awaited and logged: then, toJSON and symbols are undefined", async () => {
    const mocks = new Mocks();
    const db = mocks.fake<Db>({ name: "db1" });
    const connect = async () => db;
    expect(await connect()).toBe(db);
    expect(JSON.stringify(db)).toBe('{"name":"db1"}');
    expect(String((db as unknown as Record<symbol, unknown>)[Symbol.iterator])).toBe("undefined");
    expect(state.refused).toEqual([]);
  });

  test("lists a function given and never called as unused", () => {
    const mocks = new Mocks();
    mocks.fake<Db>({ query: async () => [], close: async () => {} });
    expect(mocks.unused()).toEqual(["fake.query", "fake.close"]);
  });
});
