import { runMultiTurnSimulator } from "../evals/multiTurnSim.ts";

const report = await runMultiTurnSimulator();
const jsonOut = process.argv.includes("--json");

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `Multi-Turn Synthetic Simulator: ${report.passedScenarios}/${report.totalScenarios} scenarios passed (${report.totalTurns} turns).`,
  );
  for (const r of report.results) {
    console.log(
      `  ${r.passed ? "PASS" : "FAIL"} [${r.id}] (${r.turnsSimulated} turns) ${r.failure ?? r.details[0] ?? ""}`,
    );
  }
}

if (report.passedScenarios !== report.totalScenarios) {
  process.exitCode = 1;
}
