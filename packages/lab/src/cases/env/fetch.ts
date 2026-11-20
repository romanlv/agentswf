import { TRIAL_ENV } from "../format/trial-env";
import { hostListed, routeFor } from "./routes";
import { type HttpRequest, refuse, shared, trialSettings } from "./state";

// The preload a trial's process starts with (`bun --preload`), so the lab's `fetch` is in place
// before the engine, `env.ts` or anything they import keeps a reference to `globalThis.fetch`.

/** Replaces `globalThis.fetch` with the lab's, once. */
export function installFetch(realHosts: readonly string[] = []): void {
  const state = shared();
  if (state.realFetch) return;
  const real = globalThis.fetch;
  state.realFetch = real;

  const labFetch = async (
    input: string | URL | Request,
    init?: RequestInit & { unix?: string },
  ): Promise<Response> => {
    const unix = init?.unix;
    const request = new Request(input, init);
    const seen: HttpRequest = { method: request.method, url: request.url };
    if (unix !== undefined) seen.unix = unix;
    if (request.body) seen.body = await request.clone().text();
    state.requests.push(seen);

    const url = new URL(request.url);
    // The built request goes on, its body whole: `input` and `init` again would read a stream twice.
    const onward = () => real(request, unix !== undefined ? ({ unix } as RequestInit) : undefined);
    // A socket names no host, nor does a scheme other than HTTP's: they go to the real `fetch`.
    if (unix !== undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
      return onward();
    }
    const found = routeFor(state.routes, request.method, url);
    if (found === "missing") {
      throw refuse(
        `${request.method} ${request.url}`,
        "host",
        `no route for ${request.method} ${request.url} in this case: add one to c.http`,
      );
    }
    if (found === "unrouted") {
      if (hostListed(realHosts, url.hostname)) return onward();
      throw refuse(
        `${request.method} ${request.url}`,
        "host",
        `reached ${url.hostname}: add a route, or list it in realHosts`,
      );
    }
    found.route.calls += 1;
    return found.route.handler(request, { params: found.params });
  };
  globalThis.fetch = Object.assign(labFetch, { preconnect: real.preconnect }) as typeof fetch;
}

if (process.env[TRIAL_ENV.case]) installFetch(trialSettings()?.realHosts ?? []);
