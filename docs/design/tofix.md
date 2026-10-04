
## api 
- placement: `pane` is not clear, bad term

## run output
- accounting's `byStage` is by convention the call path plus the agent key's prefix (`contract/src/records.ts:163`), so one agent that spans a workflow's stages (implement-ticket's worker, ~$14.81 of ~$18.29) is a single line. Fill it from real stages once they exist ([[018-workflow-stages|story 018]]).
- a turn settled `blocked` keeps no evidence: no screen snapshot (`agent read --source detection`) in the call dir or `output.json`, and closing the run closes the pane. In the AIRS-1515 rerun a worker that was mid-tool-call was settled `blocked`, likely a misclassification, and nothing was left to check it against. Save the detection screen with every non-answered outcome.
