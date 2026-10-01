// Listens where an attached session's `wf` might have to reach and logs each connection.
const P = import.meta.dir;
const log = (where: string) => ({
  data(socket: { write(data: string): unknown; end(): unknown }, data: Buffer) {
    console.log(`${where} got ${data.toString().trim()}`);
    socket.write("ok\n");
    socket.end();
  },
});
for (const path of [`${P}/ws/awf.sock`, `${P}/outside/awf.sock`]) {
  try {
    require("node:fs").unlinkSync(path);
  } catch {}
  Bun.listen({
    unix: path,
    socket: log(path.includes("/ws/") ? "unix-in-workspace" : "unix-outside"),
  });
}
Bun.listen({ hostname: "127.0.0.1", port: 47917, socket: log("tcp-localhost") });
console.log("listening");
