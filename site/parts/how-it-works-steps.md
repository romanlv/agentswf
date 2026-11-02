1. Your code calls `agent.run({ prompt, schema })`.
2. awf hands the prompt to a coding agent, in a [Herdr](https://herdr.dev) pane you can watch or
   headless.
3. The agent works in your repo with its own tools and skills, then answers by running
   `wfa result`.
4. awf checks the answer against your schema. A wrong shape goes back to the agent to fix; a quiet
   agent gets a nudge.
5. `await` returns a typed value, and your code decides what happens next.
