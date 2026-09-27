// The door's half in a box (story 004, X6): listen at the door's path; each connection's request
// goes out on stdout as one line {id, b64}, and its reply comes back on stdin the same way. The
// socket is the agent's to connect to, so it is made connectable by any uid in the box.
const net = require("node:net"),
  fs = require("node:fs");
const path = process.argv[1];
try {
  fs.unlinkSync(path);
} catch {}
const open = new Map();
let next = 0;
net
  .createServer({ allowHalfOpen: true }, (c) => {
    const id = next++,
      chunks = [];
    open.set(id, c);
    c.on("data", (d) => chunks.push(d));
    c.on("end", () =>
      process.stdout.write(
        `${JSON.stringify({ id, b64: Buffer.concat(chunks).toString("base64") })}\n`,
      ),
    );
    c.on("error", () => open.delete(id));
  })
  .listen(path, () => {
    fs.chmodSync(path, 0o666);
    process.stderr.write("ready\n");
  });
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const { id, b64 } = JSON.parse(line);
  const c = open.get(id);
  open.delete(id);
  c?.end(Buffer.from(b64, "base64"));
});
lines.on("close", () => process.exit(0));
