// A PLATFORM ADMIN'S STOP of one organisation's containers (Story MOTIR-6905 ·
// MOTIR-7317) — what the tenant page's confirmation shows, and what the stop did.

/** What a stop WOULD do now. */
export interface FleetStopPreviewDTO {
  /** Live GitHub Actions runs on the org's Motir-hosted repositories; null when
   *  GitHub could not be read — the confirmation says it does not know. */
  ciRuns: number | null;
  /** CI containers in flight. */
  ciContainers: number;
  /** Hosted-agent runs holding a container. */
  hostedRuns: number;
  /** Agent instances running now. */
  agentInstances: number;
  /** Index containers — counted, and NOT stopped: indexing is never charged. */
  indexContainers: number;
}

/** What one stop achieved. A partial stop is a result, never a throw. */
export interface FleetStopResultDTO {
  runsCancelled: number;
  ciContainersStopped: number;
  /** Hosted runs this stop closed (one already closed is not counted). */
  hostedRunsEnded: number;
  agentInstancesHibernated: number;
  failures: {
    /** Repositories whose runs could not be cancelled, and containers that could
     *  not be torn down. */
    ci: number;
    /** Hosted runs that could not be ended, or whose key could not be revoked. */
    hosted: number;
    /** Agent instances whose stop did not confirm. */
    instances: number;
  };
}
