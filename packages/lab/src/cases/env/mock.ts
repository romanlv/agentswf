import { type Mock, mock, spyOn } from "bun:test";
import { builtinModules } from "node:module";
import { basename, dirname, extname } from "node:path";
import { refuse, shared } from "./state";

/** What the case stood in for, by name, and whether it was used. */
type Entry = {
  what: string;
  spy: Mock<(...args: unknown[]) => unknown>;
  kind: "fake" | "refuser";
  /** `observe` read its `.mock`: a fake meant never to be called isn't unused. */
  read: boolean;
};

type Fn = (...args: unknown[]) => unknown;

/** Every fake and refusing stand-in of one trial: what `unused` and the module checks read. */
export class Mocks {
  readonly #entries: Entry[] = [];
  readonly #byTarget = new WeakMap<object, Map<string, Entry>>();
  /** The files of the modules mocked, for the copy check. */
  readonly files = new Set<string>();
  #fakes = 0;

  unused(): string[] {
    return this.#entries
      .filter((entry) => entry.kind === "fake" && !entry.read && entry.spy.mock.calls.length === 0)
      .map((entry) => entry.what);
  }

  module<T extends object>(
    target: T,
    fakes: Record<string, unknown>,
    options: { real?: readonly string[] } = {},
  ): Record<string, unknown> {
    if (target === null || (typeof target !== "object" && typeof target !== "function")) {
      throw new Error("c.mock takes a module (import * as name), an object or a prototype");
    }
    const builtin = builtinName(target);
    if (builtin) {
      throw new Error(
        `c.mock refuses ${builtin}: the engine shares the process and calls it too; mock the workflow's own module that wraps it`,
      );
    }
    const record = target as Record<string, unknown>;
    const file = fileOf(target);
    if (file) this.files.add(file);
    const label = labelOf(target, file);
    for (const [name, fake] of Object.entries(fakes)) {
      if (!(name in target)) throw new Error(`c.mock: ${label} has no export ${name}`);
      if (typeof record[name] !== "function") {
        throw new Error(`c.mock: ${label}.${name} is not a function`);
      }
      if (typeof fake !== "function")
        throw new Error(`c.mock: the fake for ${name} is no function`);
    }
    const real = new Set(options.real ?? []);
    // A CommonJS module: its exports object is `default`, and both it and the named export are
    // patched, since a caller may reach either.
    const exportsObject = file && isCommonJs(target, file) ? record.default : undefined;
    const spies: Record<string, unknown> = {};

    for (const name of ownFunctionNames(target)) {
      if (name === "constructor") continue;
      if (exportsObject !== undefined && name === "default") continue;
      const value = record[name] as Fn;
      const fake = fakes[name] as Fn | undefined;
      const holder =
        exportsObject && typeof exportsObject === "object" && name in exportsObject
          ? (exportsObject as object)
          : target;
      // Mocked already, by an earlier `c.mock`: only a fake given now replaces it.
      const existing = this.#byTarget.get(holder)?.get(name);
      if (fake === undefined && existing) {
        spies[name] = tracked(existing);
        continue;
      }
      if (fake === undefined && (real.has(name) || isClass(value))) continue;
      const what = `${label}.${name}`;
      const impl =
        fake ??
        this.#refuser(what, "fake it, or name it in `real` if it is a pure helper", isAsync(value));
      const entry = this.#install(holder, name, what, impl, fake ? "fake" : "refuser");
      if (holder !== target && !existing) {
        spyOn(record, name as never).mockImplementation(((...args: unknown[]) =>
          entry.spy(...args)) as never);
      }
      spies[name] = tracked(entry);
    }

    // An exported plain object's function members are the module's surface too.
    if (isNamespace(target) || exportsObject !== undefined) {
      for (const name of Object.getOwnPropertyNames(target)) {
        const value = record[name];
        if (value === exportsObject || real.has(name) || !isPlainObject(value)) continue;
        for (const member of ownFunctionNames(value)) {
          if (real.has(`${name}.${member}`) || isClass((value as Record<string, Fn>)[member]!)) {
            continue;
          }
          const what = `${label}.${name}.${member}`;
          if (this.#byTarget.get(value)?.has(member)) continue;
          this.#install(
            value,
            member,
            what,
            this.#refuser(
              what,
              `fake it with c.mock(${label}.${name}, …), or name it in \`real\``,
              isAsync((value as Record<string, Fn>)[member]!),
            ),
            "refuser",
          );
        }
      }
    }
    return spies;
  }

  fake<T extends object>(fakes: Partial<T>, options: { name?: string } = {}): T {
    this.#fakes += 1;
    const label = options.name ?? (this.#fakes === 1 ? "fake" : `fake${this.#fakes}`);
    const given = fakes as Record<PropertyKey, unknown>;
    const members = new Map<PropertyKey, unknown>();
    for (const [key, value] of Object.entries(given)) {
      if (typeof value !== "function") continue;
      const spy = mock(value as Fn) as unknown as Mock<Fn>;
      const entry: Entry = { what: `${label}.${key}`, spy, kind: "fake", read: false };
      this.#entries.push(entry);
      members.set(key, tracked(entry));
    }
    const refusers = new Map<string, Fn>();
    return new Proxy(given, {
      get: (target, key) => {
        if (members.has(key)) return members.get(key);
        if (key in target) return target[key];
        if (typeof key === "symbol" || key === "then" || key === "toJSON") return undefined;
        let refuser = refusers.get(key);
        if (!refuser) {
          refuser = this.#refuser(`${label}.${key}`, "fake it");
          refusers.set(key, refuser);
        }
        return refuser;
      },
    }) as T;
  }

  #install(holder: object, name: string, what: string, impl: Fn, kind: Entry["kind"]): Entry {
    let byName = this.#byTarget.get(holder);
    if (!byName) {
      byName = new Map();
      this.#byTarget.set(holder, byName);
    }
    const existing = byName.get(name);
    if (existing) {
      existing.spy.mockImplementation(impl);
      existing.kind = kind;
      existing.what = what;
      return existing;
    }
    const spy = spyOn(holder as Record<string, Fn>, name).mockImplementation(impl) as Mock<Fn>;
    const entry: Entry = { what, spy, kind, read: false };
    byName.set(name, entry);
    this.#entries.push(entry);
    return entry;
  }

  /** A stand-in that refuses: rejecting, for an async function, as the real one would fail. */
  #refuser(what: string, advice: string, async = false): Fn {
    const refused = () => refuse(what, "function", `no fake for ${what} in this case: ${advice}`);
    return async
      ? () => Promise.reject(refused())
      : () => {
          throw refused();
        };
  }
}

/** The spy, noting when `observe` reads its `.mock`. */
function tracked(entry: Entry): unknown {
  return new Proxy(entry.spy, {
    get(target, key) {
      if (key === "mock" && shared().phase === "observe") entry.read = true;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function ownFunctionNames(target: object): string[] {
  return Object.getOwnPropertyNames(target).filter((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, name);
    return (
      descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "function"
    );
  });
}

function isAsync(value: Fn): boolean {
  return value.constructor?.name === "AsyncFunction";
}

function isClass(value: Fn): boolean {
  return /^class[\s{]/.test(Function.prototype.toString.call(value));
}

function isNamespace(value: object): boolean {
  return Object.prototype.toString.call(value) === "[object Module]";
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cacheEntries(): [string, unknown][] {
  return Object.entries(require.cache).map(([file, entry]) => [file, entry?.exports]);
}

/** The file a namespace, or a CommonJS module's exports, was loaded from. */
export function fileOf(target: object): string | undefined {
  const exportsOfDefault = isNamespace(target)
    ? (target as { default?: unknown }).default
    : undefined;
  for (const [file, exported] of cacheEntries()) {
    if (exported === target) return file;
    if (exportsOfDefault !== undefined && exported === exportsOfDefault && isNamespace(target)) {
      return file;
    }
  }
  return undefined;
}

function isCommonJs(target: object, file: string): boolean {
  return (
    isNamespace(target) &&
    require.cache[file]?.exports === (target as { default?: unknown }).default
  );
}

function moduleName(file: string): string {
  const name = basename(file, extname(file));
  return name === "index" ? basename(dirname(file)) : name;
}

function labelOf(target: object, file: string | undefined): string {
  if (file) return moduleName(file);
  const owner = Object.getOwnPropertyDescriptor(target, "constructor")?.value;
  if (typeof owner === "function" && owner.prototype === target) {
    return owner.name || "prototype";
  }
  for (const [file, exported] of cacheEntries()) {
    if (typeof exported !== "object" || exported === null) continue;
    for (const name of Object.getOwnPropertyNames(exported)) {
      try {
        if ((exported as Record<string, unknown>)[name] === target) {
          return name === "default" ? moduleName(file) : `${moduleName(file)}.${name}`;
        }
      } catch {
        // An export still in its temporal dead zone.
      }
    }
  }
  return "object";
}

let builtins: Map<unknown, string> | undefined;

function builtinName(target: object): string | undefined {
  if (target === Bun) return "bun";
  const file = fileOf(target);
  if (file !== undefined) {
    if (/^(node|bun):/.test(file) || file === "bun") return file;
    return builtinModules.includes(file) ? `node:${file}` : undefined;
  }
  if (!builtins) {
    builtins = new Map();
    // `_`-prefixed modules are Node's internals, deprecated, and warn when loaded.
    for (const name of builtinModules.filter((each) => !each.startsWith("_"))) {
      try {
        builtins.set(process.getBuiltinModule(name), `node:${name.replace(/^node:/, "")}`);
      } catch {
        // Not loadable here.
      }
    }
  }
  return (
    builtins.get(target) ??
    (isNamespace(target) ? builtins.get((target as { default?: unknown }).default) : undefined)
  );
}
