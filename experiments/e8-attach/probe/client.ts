// Tries each address and prints what the sandbox allowed.
const P = import.meta.dir;

const attempt = (name: string, connect: (socket: Handlers) => Promise<unknown>) =>
  new Promise<string>((done) => {
    connect({
      open(s) {
        s.write(`hello from ${name}\n`);
      },
      data(_s, d) {
        done(`reply ${d.toString().trim()}`);
      },
      error(_s, e) {
        done(`error ${e.message}`);
      },
    }).catch((e) => done(`refused ${e.code ?? ""} ${e.message}`));
    setTimeout(() => done("timeout"), 3000);
  });

type Handlers = {
  open(s: { write(data: string): unknown }): void;
  data(s: unknown, d: Buffer): void;
  error(s: unknown, e: Error): void;
};

console.log(
  `unix-in-workspace: ${await attempt("unix-in-workspace", (socket) => Bun.connect({ unix: `${P}/ws/awf.sock`, socket }))}`,
);
console.log(
  `unix-outside: ${await attempt("unix-outside", (socket) => Bun.connect({ unix: `${P}/outside/awf.sock`, socket }))}`,
);
console.log(
  `tcp-localhost: ${await attempt("tcp-localhost", (socket) => Bun.connect({ hostname: "127.0.0.1", port: 47917, socket }))}`,
);
