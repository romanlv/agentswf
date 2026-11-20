import { describe, expect, test } from "bun:test";
import { hostListed, parseRoute, routeFor } from "./routes";

const answer = () => new Response("ok");

describe("parseRoute", () => {
  test("takes a method and an absolute URL pattern with a literal host", () => {
    const route = parseRoute("GET https://School.example/posts/:id", answer);
    expect(route).toMatchObject({ method: "GET", hostname: "school.example", calls: 0 });
  });

  test("refuses a relative path, a host with a pattern in it, and a key without a method", () => {
    expect(() => parseRoute("GET /posts", answer)).toThrow("names no host");
    expect(() => parseRoute("GET https://*.example/x", answer)).toThrow("a literal host");
    expect(() => parseRoute("GET https://:sub.example/x", answer)).toThrow("a literal host");
    expect(() => parseRoute("https://school.example/x", answer)).toThrow("{METHOD} {URL pattern}");
    expect(() => parseRoute("get https://school.example/x", answer)).toThrow("{METHOD}");
  });
});

describe("routeFor", () => {
  const routes = [
    parseRoute("GET https://school.example/posts/:id", answer),
    parseRoute("POST https://school.example/forms", answer),
  ];

  test("matches by method and path, with the pattern's params", () => {
    const found = routeFor(routes, "GET", new URL("https://school.example/posts/7?x=1"));
    expect(found).toMatchObject({ route: { key: "GET https://school.example/posts/:id" } });
    expect(found !== "missing" && found !== "unrouted" && found.params).toEqual({ id: "7" });
  });

  test("compares a routed host by hostname: scheme and port neither widen nor split it", () => {
    expect(routeFor(routes, "GET", new URL("http://school.example:8080/posts/1"))).toMatchObject({
      params: { id: "1" },
    });
  });

  test("is missing for a routed host no route matches, unrouted for any other host", () => {
    expect(routeFor(routes, "GET", new URL("https://school.example/forms"))).toBe("missing");
    expect(routeFor(routes, "DELETE", new URL("https://school.example/posts/1"))).toBe("missing");
    expect(routeFor(routes, "GET", new URL("https://other.example/posts/1"))).toBe("unrouted");
  });
});

test("hostListed takes exact hosts and *. subdomains", () => {
  expect(hostListed(["openrouter.ai", "*.example.com"], "openrouter.ai")).toBe(true);
  expect(hostListed(["*.example.com"], "api.example.com")).toBe(true);
  expect(hostListed(["*.example.com"], "example.com")).toBe(false);
  expect(hostListed(["openrouter.ai"], "evil.ai")).toBe(false);
});
