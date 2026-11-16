/** Answers one routed request, as a router's handler would. */
export type RouteHandler = (
  request: Request,
  match: { params: Record<string, string> },
) => Response | Promise<Response>;

export type Route = {
  /** As the case wrote it: `GET https://school.example/posts/:id`. */
  key: string;
  method: string;
  hostname: string;
  pattern: URLPattern;
  handler: RouteHandler;
  calls: number;
};

const METHOD = /^[A-Z]+$/;
// A hostname a route names is literal: a pattern there would make "a host a route names" unknowable.
const NOT_LITERAL = /[*:{}()?+\\]/;

/** A route from its key; throws why the key isn't one. */
export function parseRoute(key: string, handler: RouteHandler): Route {
  const space = key.indexOf(" ");
  const method = space > 0 ? key.slice(0, space) : "";
  const url = key.slice(space + 1).trim();
  if (!METHOD.test(method)) {
    throw new Error(`c.http: "${key}" is not "{METHOD} {URL pattern}", such as "GET https://x/y"`);
  }
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(url)?.[1];
  if (authority === undefined) {
    throw new Error(
      `c.http: "${key}" names no host: a route's URL is absolute, with a literal host`,
    );
  }
  const hostname = authority.replace(/:\d+$/, "").toLowerCase();
  if (hostname === "" || NOT_LITERAL.test(hostname)) {
    throw new Error(`c.http: "${key}": a route names a literal host, not "${hostname}"`);
  }
  let parsed: URLPattern;
  try {
    parsed = new URLPattern(url);
  } catch (error) {
    throw new Error(`c.http: "${key}" is not a URL pattern: ${(error as Error).message}`);
  }
  // Routed hosts compare by hostname: a route's scheme and port neither widen nor split it.
  const pattern = new URLPattern({
    hostname: parsed.hostname,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  });
  return { key, method, hostname, pattern, handler, calls: 0 };
}

/**
 * The route for a request: `unrouted` when no route names its host, `missing` when one does and none
 * matches.
 */
export function routeFor(
  routes: readonly Route[],
  method: string,
  url: URL,
): { route: Route; params: Record<string, string> } | "unrouted" | "missing" {
  const hostname = url.hostname.toLowerCase();
  if (!routes.some((route) => route.hostname === hostname)) return "unrouted";
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(url.href);
    if (!match) continue;
    const params: Record<string, string> = {};
    for (const part of [match.hostname, match.pathname, match.search, match.hash]) {
      for (const [name, value] of Object.entries(part.groups)) {
        if (value !== undefined && !/^\d+$/.test(name)) params[name] = value;
      }
    }
    return { route, params };
  }
  return "missing";
}

/** Whether `hostname` is one `hosts` lists: exactly, or under a `*.` entry. */
export function hostListed(hosts: readonly string[], hostname: string): boolean {
  const host = hostname.toLowerCase();
  return hosts.some((entry) => {
    const listed = entry.toLowerCase();
    return listed.startsWith("*.") ? host.endsWith(listed.slice(1)) : host === listed;
  });
}
