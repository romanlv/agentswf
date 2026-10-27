
## api 
- placement: `pane` is not clear, bad term



## run output

- a turn settled `blocked` keeps no evidence: no screen snapshot (`agent read --source detection`) in the call dir or `output.json`, and closing the run closes the pane unless the workflow said `keepPane: "on-failure"` (story 026). In the implement-ticket rerun a worker that was mid-tool-call was settled `blocked`, likely a misclassification, and nothing was left to check it against. Save the detection screen with every non-answered outcome.
