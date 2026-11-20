import { typed } from "agentswf/typebox";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";
import * as service from "./service";

const ITEMS = typed(Type.Array(Type.String()));
const DECISION = typed(
  Type.Object(
    { count: Type.Number(), sent: Type.Array(Type.String()) },
    { additionalProperties: false },
  ),
);

export type Outcome = { mode: string; count: number; sent: string[]; notes: string[] };

/** Two stages and plain code, each mode a way a workflow behaves under a case. */
export default defineWorkflow<{ mode: string; urls: string[] }, Outcome>({
  meta: {
    name: "case-fixture",
    description: "A two-stage workflow for the lab's tests.",
    version: "1.2.0",
  },
  prepare: ({ argv }) => {
    const [mode, ...urls] = argv;
    if (!mode || mode === "bad") throw new Error(`no mode ${mode ?? ""}`);
    return { mode, urls };
  },
  run: async (wf, { mode, urls }) => {
    const notes: string[] = [];
    const guard = <T>(work: () => Promise<T>): Promise<T | undefined> =>
      mode === "swallow" || mode === "stop-after"
        ? work().catch((error) => {
            notes.push(String(error));
            if (mode === "stop-after") wf.stop("enough");
            return undefined;
          })
        : work();
    if (mode === "early") return { mode, count: 0, sent: [], notes: ["nothing to do"] };
    if (mode === "throw") throw new Error("the workflow broke");
    if (mode === "slow") await Bun.sleep(30_000);
    if (mode === "exit") process.exit(3);
    if (mode === "catch-refused-throw" || mode === "catch-refused-slow") {
      try {
        await service.remove("x");
      } catch {}
      if (mode === "catch-refused-slow") await Bun.sleep(30_000);
      throw new Error("broke after the refusal");
    }
    if (mode === "post") {
      for (const url of urls) {
        const stream = await fetch(url, {
          method: "POST",
          body: new Blob(["streamed"]).stream(),
          duplex: "half",
        } as RequestInit);
        notes.push(await stream.text());
        const request = await fetch(new Request(url, { method: "POST", body: "built" }));
        notes.push(await request.text());
      }
    }
    if (mode === "catch-refused") {
      try {
        await service.remove("x");
      } catch (error) {
        notes.push((error as Error).message);
      }
    }
    if (mode === "class") {
      notes.push(String(new service.ServiceError("x") instanceof service.ServiceError));
      notes.push(service.parse("a,b").join("+"));
    }
    if (mode === "fake") {
      const db = await service.connect();
      notes.push(...(await db.query("q")), db.name);
      if (urls[0] === "close") {
        try {
          await db.close();
        } catch (error) {
          notes.push((error as Error).message);
        }
      }
    }
    if (mode === "fetch") {
      for (const url of urls) {
        try {
          const response = await fetch(url);
          notes.push(`${response.status} ${await response.text()}`);
        } catch (error) {
          notes.push(`refused: ${(error as Error).message}`);
        }
      }
    }
    const items = await guard(() => wf.stage("gather", { result: ITEMS }, () => service.list()));
    const decision = await guard(() =>
      wf.stage("decide", { result: DECISION }, async () => {
        const sent: string[] = [];
        for (const item of items ?? []) {
          await service.send(item, "hi");
          sent.push(item);
        }
        return { count: sent.length, sent };
      }),
    );
    return { mode, count: decision?.count ?? -1, sent: decision?.sent ?? [], notes };
  },
});
