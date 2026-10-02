/**
 * THE DEPLOYMENT-STATUS PORT (MOTIR-7332): is all of this deployment running,
 * and is it all running the same release?
 *
 * `identity.ts` answers where THIS PROCESS is, from what the platform injects
 * into it. This port answers a question no process can answer about itself: how
 * many of its siblings are up. That takes a call to the platform's API with a
 * credential, which `identity.ts` deliberately refuses to make (its header says
 * so, and the boundary guard enforces it). So the call lives behind this port,
 * in an adapter directory, and `lib/` above it sees only the neutral shape below.
 *
 * No provider type, machine id or state string crosses this file. A second
 * hosting provider is one more adapter plus one branch in `providers.ts`.
 */

/** How long the read may take before the card says it could not answer. */
export const DEPLOYMENT_STATUS_TIMEOUT_MS = 3000;

/** One process group: how many of its machines run, against how many should. */
export interface DeploymentGroupStatus {
  /** The group's name on the platform, e.g. `app` or `worker`. */
  readonly name: string;
  /** Machines in the group that are running now. */
  readonly started: number;
  /** Machines in the group that count toward it, running or not (standbys excluded). */
  readonly total: number;
  /** How many SHOULD be running: an operator's decision, from `expectedMachines.ts`. */
  readonly expected: number;
}

/** What the platform reports about the whole deployment. */
export interface DeploymentStatus {
  /** One entry per expected group, plus any group the platform runs that nobody expected. */
  readonly groups: readonly DeploymentGroupStatus[];
  /**
   * The distinct releases the counted machines run, NEWEST FIRST. One entry is the
   * steady state; more than one means a deploy stopped part-way.
   */
  readonly releases: readonly string[];
}

/** The port. An implementation THROWS when it cannot read; it never reports an empty fleet instead. */
export interface DeploymentStatusProvider {
  /** Is the credential this provider reads with present? Never throws. */
  configured(): boolean;
  /** Read the deployment's status now. Throws on any failure. */
  read(): Promise<DeploymentStatus>;
}
