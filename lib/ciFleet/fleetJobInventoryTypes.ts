// The SHAPE of `lib/ciFleet/fleetJobInventory.json` (Story MOTIR-8699 ·
// MOTIR-8701 wrote it; MOTIR-8713 reads it). Declared here so the checker never
// gives a 48 KB manifest a literal type (the MOTIR-8405 sidecar pattern —
// `fleetJobInventory.d.json.ts` points the import at this).

export type FleetJobVerdict = 'runnable' | 'needs-image' | 'cannot-host';

export interface FleetInventoryJob {
  jobId: string;
  runsOn: unknown;
  triggers: unknown;
  verdict: FleetJobVerdict;
  /** Stable tool slugs; `["unverified"]` for a job the inventory did not reach. */
  missing: string[];
  evidence: string | null;
  reason?: string;
  calls?: string;
}

export interface FleetInventoryRepo {
  repoRef: string;
  ref: string;
  sha: string;
  visibility: string;
  /** ISO-8601. */
  measuredAt: string;
  imageDockerfileSha: string;
  /** `workflowFingerprint` of the repository's workflows at `sha` (MOTIR-8870).
   *  When present, a newer workflow commit makes the entry stale only if the
   *  fingerprint at the new head differs. Absent: any newer commit does. */
  structureFingerprint?: string;
  jobCount: number;
  workflows: Array<{ path: string; jobs: FleetInventoryJob[] }>;
}

export interface FleetJobInventory {
  schemaVersion: number;
  imageDockerfileBlob?: string;
  /** Keyed by `owner/name`, as GitHub spells it. */
  repos: Record<string, FleetInventoryRepo>;
}
