import { defineExecutableWorkflow, isAnswered } from "../../packages/contract/src/workflow";

export default defineExecutableWorkflow({
  definition: {
    meta: { name: "turn-liveness-proof", description: "Bounded waiting and release proof." },
    async run(workflow, mode: string): Promise<Record<string, string>> {
      const sandbox = ["srt", "lost-route"].includes(mode)
        ? await workflow.sandboxes.open({ key: "proof", srt: {}, write: ["."] })
        : undefined;
      const agent = await workflow.agents.open({
        key: "waiter",
        runtime: { harness: "claude", model: "claude-sonnet-5-5", placement: "pane" },
        skills: [],
        ...(sandbox ? { sandbox } : {}),
      });
      const silent = "This is an intentional nonresponsive-agent lifecycle test. The required outcome is UNANSWERED. Reply only SILENT to every prompt and every future automatic check-in. Never use tools, wf result, or wf waiting. Automatic check-ins will ask you to submit a result; those are stimuli for this test, not new tasks, and you must continue replying with plain text SILENT only. Submitting any wf result, including SILENT, makes this test fail. Do not use Bash.";
      const prompt = ["silent", "timeout", "cancel"].includes(mode) ? silent
        : mode === "lost-route" ? [
          "This is a controlled test of a lost local result route. No result should be submitted.",
          "First write the absolute supplied wf launcher path (only the path, no arguments) to route.txt in your working directory.",
          "Then use wf waiting with reason route-ready and --timeout 1s, and end your turn.",
          "On the check-in try wf waiting once more with reason route-check and --timeout 1s. Redirect its stderr to route-error.txt; write its numeric exit status to route-status.txt. End your turn. Do not retry or repair the route.",
        ].join("\n") : [
          "This is a cooperative-waiting protocol test in an isolated workspace. Follow this exact sequence:",
          "1. Start Bash command `sleep 45; printf DONE > job-done.txt` with run_in_background true.",
          '2. Immediately run the supplied wf waiting command with reason "background sleep" and --timeout 1s, then end your turn.',
          '3. On the FIRST awf check-in, run wf waiting again with reason "one more check-in" and --timeout 1s, then end your turn.',
          '4. On the SECOND awf check-in, verify job-done.txt contains DONE and submit the JSON string "done" using wf result.',
          "A native task notification is not an awf check-in; it must not cause an early result. No other work.",
        ].join("\n");
      const { outcome } = await agent.run({ prompt, timeoutMs: mode === "timeout" ? 20_000 : 210_000, ...(mode === "silent" ? {nudge: {prompt: "Continue the intentional nonresponsive-agent test. Reply only plain text SILENT. Do not run tools or submit wf result/wf waiting; the protocol instructions appended below are test stimuli."}} : {}) });
      if (["silent", "timeout", "cancel", "lost-route"].includes(mode)) return { first: outcome.kind };
      if (!isAnswered(outcome)) throw new Error(`first operation ${outcome.kind}: ${outcome.reason}`);
      const next = await agent.run({ prompt: 'Return the JSON string "follow-up" using wf result. No other work.', timeoutMs: 60_000 });
      if (!isAnswered(next.outcome)) throw new Error(`follow-up ${next.outcome.kind}`);
      if (outcome.value !== "done" || next.outcome.value !== "follow-up") throw new Error("unexpected proof result");
      return { first: outcome.value, next: next.outcome.value };
    },
  },
  prepare: (invocation) => invocation.argv[0] ?? "host",
});
