// The ids a hosted run's pieces are keyed by (Story MOTIR-683). A leaf module
// with no imports, so the fleet's reaper (`ciRunnerBootService`) can name a hosted
// run's fleet slot without importing the hosted-run service and its graph.

/** The fleet dispatch id of a run's container — one run, one container. It is
 *  also the `ref` of the fleet slot the run holds (`workload: hosted_agent`). */
export function hostedRunDispatchId(dispatchRunId: string): string {
  return `hosted-run:${dispatchRunId}`;
}
