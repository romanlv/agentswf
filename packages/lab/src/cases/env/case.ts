import type { Mock } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Mocks } from "./mock";
import { parseRoute, type RouteHandler } from "./routes";
import { type HttpRequest, shared } from "./state";

// biome-ignore lint/suspicious/noExplicitAny: a module's functions, of any signature.
type AnyFunction = (...args: any[]) => any;
// biome-ignore lint/suspicious/noExplicitAny: a class, faked only by name.
type AnyClass = abstract new (...args: any[]) => any;

/** The keys of `T` a fake may stand in for: its functions, and its classes by name. */
export type FakeableKeys<T> = {
  [K in keyof T]-?: T[K] extends AnyFunction | AnyClass ? K : never;
}[keyof T] &
  string;

/** A spy as `bun:test` makes it, typed as the function it stands in for. */
export type Spy<F> = F extends AnyFunction ? F & Mock<F> : F;

/** What `c.mock` returns: each function's spy, by name. */
export type Spies<T> = { [K in FakeableKeys<T>]: Spy<T[K]> };

/** A stand-in typed as `T`, whose function members are spies. */
export type Faked<T> = T & { [K in FakeableKeys<T>]: Spy<T[K]> };

export type Routes = Record<string, RouteHandler>;

export type Case = {
  /** `input.json`, typed where it is read: `const input: { today: string } = c.input`. `{}` without one. */
  // biome-ignore lint/suspicious/noExplicitAny: typed by the reader, as `JSON.parse` is.
  readonly input: any;
  /** The built case folder: the dataset's shared files and the case's own, and `input.json`. */
  readonly dir: string;
  /** The trial's empty working folder, the run's `--cwd`. */
  readonly scratch: string;
  /** The code folder: your checkout, or the folder `--against` names. */
  readonly root: string;
  /**
   * The trial's parameters, from `--param` and `--vary`: `{}` without them. Turn them into argv or
   * a module to load; a value is always a string.
   */
  readonly params: Readonly<Record<string, string>>;
  /** A JSON file of the case folder, parsed. */
  // biome-ignore lint/suspicious/noExplicitAny: typed by the reader, as `JSON.parse` is.
  json<T = any>(name: string): T;
  /** A text file of the case folder. */
  text(name: string): string;
  /**
   * Replaces a module's functions with `bun:test` spies, strictly: each one faked, and any other
   * refusing when called unless named in `real`. Classes stay real unless faked by name.
   */
  mock<M extends object>(
    module: M,
    fakes: { [K in FakeableKeys<M>]?: M[K] },
    options?: { real?: readonly string[] },
  ): Spies<M>;
  /** A strict stand-in for an object a factory returns; `name` labels its refusals. */
  fake<T extends object>(fakes: Partial<T>, options?: { name?: string }): Faked<T>;
  /** Answers the workflow's `fetch` from routes keyed `"{METHOD} {URL pattern}"`. */
  http: ((routes: Routes) => void) & { readonly requests: readonly HttpRequest[] };
  /** Teardown, run after `observe` even when the run fails, last given first. */
  cleanup(fn: () => unknown): void;
};

export type CaseFolders = {
  dir: string;
  scratch: string;
  root: string;
  params: Record<string, string>;
};

export function makeCase(folders: CaseFolders, mocks: Mocks, cleanups: (() => unknown)[]): Case {
  const read = (name: string) => readFileSync(join(folders.dir, name), "utf8");
  const inputFile = join(folders.dir, "input.json");
  const input = existsSync(inputFile) ? JSON.parse(readFileSync(inputFile, "utf8")) : {};
  const state = shared();

  const http = (routes: Routes) => {
    if (!state.realFetch) {
      throw new Error("c.http needs the lab's fetch preload: run the case with awf-lab");
    }
    const parsed = Object.entries(routes).map(([key, handler]) => parseRoute(key, handler));
    for (const route of parsed) {
      if (state.routes.some((each) => each.key === route.key)) {
        throw new Error(`c.http: "${route.key}" is routed twice`);
      }
    }
    state.routes.push(...parsed);
  };
  Object.defineProperty(http, "requests", { get: () => state.requests });

  return {
    input,
    dir: folders.dir,
    scratch: folders.scratch,
    root: folders.root,
    params: Object.freeze({ ...folders.params }),
    json: (name) => JSON.parse(read(name)),
    text: read,
    mock: (module, fakes, options) =>
      mocks.module(module, fakes as Record<string, unknown>, options) as never,
    fake: (fakes, options) => mocks.fake(fakes, options) as never,
    http: http as Case["http"],
    cleanup: (fn) => {
      cleanups.push(fn);
    },
  };
}
