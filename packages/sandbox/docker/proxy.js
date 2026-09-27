// A CONNECT-only filtering proxy, run by `node -e` in a sandbox's proxy container (story 004, X8).
// The allowlist file is re-read on every request, so it grows as agents are admitted. Domain
// grammar: exact host, or `*.` and a name for its subdomains only. An address is never allowed.
const net = require("node:net"),
  http = require("node:http"),
  fs = require("node:fs");
const [list, port] = [process.argv[1], Number(process.argv[2] || 3128)];
// The sandbox's internal network is its first: listening there alone keeps other containers on
// the default bridge, which it joins later, from borrowing it.
const internal = Object.values(require("node:os").networkInterfaces())
  .flat()
  .find((address) => address && address.family === "IPv4" && !address.internal);
const allowed = (host) =>
  fs
    .readFileSync(list, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .some((d) => (d.startsWith("*.") ? host.endsWith(d.slice(1)) : host === d));
const server = http.createServer((req, res) => {
  console.log("deny plain", req.url);
  res.writeHead(403).end();
});
server.on("connect", (req, client, head) => {
  const [raw, p] = req.url.split(":");
  const host = raw.toLowerCase().replace(/\.$/, "");
  // A client that resets a refused connection must not take the proxy down with it.
  client.on("error", () => {});
  // TLS on 443 only: an allowed name's other ports are not what was allowed.
  if (net.isIP(host) || Number(p || 443) !== 443 || !allowed(host)) {
    console.log("deny", req.url);
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  console.log("allow", req.url);
  const up = net.connect(Number(p || 443), host, () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
  up.on("error", () => client.destroy());
  client.on("error", () => up.destroy());
});
server.listen(port, internal ? internal.address : "0.0.0.0");
