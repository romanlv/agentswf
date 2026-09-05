export type Run = {
  id: string;
  status: "succeeded" | "failed";
};

export function renderRunSummary(runs: Run[]): string {
  const succeeded = runs.filter((run) => run.status === "succeeded");
  const failed = runs.filter((run) => run.status === "failed");
  const successRate = Math.round((succeeded.length / runs.length) * 100);
  let report = `Success rate: ${successRate}%\n`;

  for (const run of succeeded) {
    report += `SUCCEEDED ${run.id}\n`;
  }
  for (const run of failed) {
    report += `FAILED ${run.id}\n`;
  }

  return report;
}
