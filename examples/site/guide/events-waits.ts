import { typed } from "agentswf/typebox";
import { defineWorkflow } from "agentswf/workflow";
import Type from "typebox";

export const SHIPPED = typed(
  Type.Object(
    { version: Type.String(), flag: Type.String() },
    { additionalProperties: false },
  ),
);
export const INCIDENT = typed(
  Type.Object(
    { version: Type.String(), summary: Type.String() },
    { additionalProperties: false },
  ),
);
export const SMOKE = typed(
  Type.Object({ passed: Type.Boolean() }, { additionalProperties: false }),
);
export const REMOVED = typed(
  Type.Object({ commit: Type.String() }, { additionalProperties: false }),
);

export default defineWorkflow({
  meta: {
    name: "flag-cleanup",
    description: "Remove a release's feature flag once it has held.",
  },
  file: import.meta.path,
  events: { "release.shipped": SHIPPED, "incident.opened": INCIDENT },
  starts: ["release.shipped"],
  async run(wf) {
    const shipped = wf.started;
    if (shipped?.name !== "release.shipped")
      return wf.stop("send release.shipped to start it");
    const { version, flag } = shipped.data;
    const engineer = await wf.agents.open({
      key: "engineer",
      runtime: "claude",
    });

    const passed = await wf.stage(
      "smoke",
      { result: Type.Boolean() },
      async () => {
        const { outcome } = await engineer.run({
          prompt: `Run the smoke tests against ${version}. Did they pass?`,
          schema: SMOKE,
        });
        return outcome.answered && outcome.value.passed;
      },
    );
    if (!passed) return { version, ended: "smoke tests failed" };

    // #region race
    const firstDay = await wf.race(
      "first-day",
      { incident: wf.signal("incident.opened"), quiet: "1d" },
      { label: `watching ${version}` },
    );
    if (firstDay.incident)
      return { version, ended: `incident: ${firstDay.incident.data.summary}` };
    // #endregion race

    // #region sleep
    await wf.sleep("hold", "14d");
    const removed = await wf.stage(
      "remove-flag",
      { result: REMOVED },
      async () => {
        const { outcome } = await engineer.run({
          prompt:
            `${version} has held for two weeks. ` +
            `Remove the ${flag} flag and its dead branch, and commit.`,
          schema: REMOVED,
        });
        if (!outcome.answered)
          return wf.stop(`flag not removed: ${outcome.reason}`);
        return outcome.value;
      },
    );
    return { version, ended: `removed ${flag} in ${removed.commit}` };
    // #endregion sleep
  },
});
