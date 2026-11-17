/**
 * The criteria judge's version: its minor goes up when its voters or prompt change, so `score`
 * judges every criterion again; a patch says it judges the same. A `judgeAgent` change is told
 * apart by the agent each grade records.
 */
export const JUDGE_VERSION = "1.0.0";

/**
 * The judge as task 1 checked it against a person: its version and agent. Until that check is
 * recorded, every report marks the judge "not checked against a person".
 */
export const JUDGE_CHECKED: { version: string; harness: string; model: string } | undefined =
  undefined;
