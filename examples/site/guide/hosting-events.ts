import { typed } from "agentswf/typebox";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

export const DEPLOYED = typed(
  Type.Object(
    { service: Type.String(), version: Type.String() },
    { additionalProperties: false },
  ),
);
export const ROLLED_BACK = typed(
  Type.Object({ version: Type.String() }, { additionalProperties: false }),
);
export const CHECK = typed(
  Type.Object(
    { healthy: Type.Boolean(), notes: Type.String() },
    { additionalProperties: false },
  ),
);

// #region workflow
export default defineWorkflow({
  meta: {
    name: "post-deploy",
    description: "Checks a deploy once it has had an hour to settle.",
  },
  file: import.meta.path,
  events: { "deploy.done": DEPLOYED, "deploy.rolled-back": ROLLED_BACK },
  starts: ["deploy.done"],
  async run(wf) {
    const started = wf.started;
    if (started?.name !== "deploy.done")
      return wf.stop("started by hand: send deploy.done");
    const { service, version } = started.data;

    // Parks here: no process until an hour passes or a rollback arrives.
    const next = await wf.race(
      "settle",
      { settled: "1h", rolledBack: wf.signal("deploy.rolled-back") },
      { label: `${service} ${version} settling` },
    );
    if (next.rolledBack) return { service, version, checked: false };

    const checker = await wf.agents.open({ key: "checker", runtime: "codex" });
    const { outcome } = await checker.run({
      prompt:
        `Read the last hour of ${service}'s logs and metrics ` +
        `since ${version} went out. Is it healthy?`,
      schema: CHECK,
    });
    if (!outcome.answered) return wf.stop(`no check: ${outcome.kind}`);
    return { service, version, checked: true, ...outcome.value };
  },
});
// #endregion workflow
