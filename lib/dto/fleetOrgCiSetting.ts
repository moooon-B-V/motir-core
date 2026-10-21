import type { FleetReadiness } from '@/lib/services/fleetReadinessService';

// The platform setting "Run Motir's private repositories' CI on the fleet"
// (Story MOTIR-8699 · MOTIR-8714) — what the /admin console reads and is answered.

/** One (project, connected org) pair the console offers the switch for. */
export interface FleetOrgCiTargetDTO {
  projectId: string;
  projectKey: string;
  workspaceId: string;
  organizationId: string;
  /** The org login as the repositories carry it. */
  org: string;
  /** The provisioning App's installation on that org. */
  installationId: string;
}

/** The STORED state of one pair — the operator's intent. */
export interface FleetOrgCiStoredStateDTO {
  enabled: boolean;
  updatedBy: { userId: string; email: string } | null;
  updatedAt: string | null;
  lastReason: string | null;
}

/** The org's `MOTIR_RUNNER` variable as GitHub holds it now — the EFFECT, read
 *  back so a drift from the stored state is visible. */
export type FleetOrgCiVariableDTO =
  | { state: 'present'; value: string; visibility: string }
  | { state: 'absent' }
  | { state: 'unknown'; status: number | null };

/** The console's full reading of one pair. */
export interface FleetOrgCiStateDTO extends FleetOrgCiStoredStateDTO {
  readiness: FleetReadiness;
  variable: FleetOrgCiVariableDTO;
}

/** What a flip answers. `unchanged` = the pair already held the asked state;
 *  nothing was written and no audit row exists. */
export interface FleetOrgCiFlipDTO {
  outcome: 'changed' | 'unchanged';
  state: FleetOrgCiStoredStateDTO;
}
