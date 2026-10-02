// The operator console's AI PLANNING page — Story MOTIR-7220 · MOTIR-7227.
//
// Which model Motir plans with, one row per AUDIENCE. Staff-facing only: no
// tenant DTO carries any of this, and the console is the one reader.

import type { PlannerAudience } from '@/lib/ai/types';

/** One audience's row, as the page renders it. */
export interface PlatformPlannerModelRowDTO {
  audience: PlannerAudience;
  model: string;
  /** False once the stored model is no longer offered — planning falls back to Claude Opus 5.5. */
  offered: boolean;
  /** The last probe's verdict; null when the model was never probed. */
  reachable: boolean | null;
  lastProbeAt: string | null;
  lastProbeError: string | null;
  updatedAt: string;
  /** The changer's display name, or null for the seeded default (and an account since removed). */
  updatedBy: string | null;
}

/** A model the picker may offer. */
export interface PlatformPlannerOfferedModelDTO {
  id: string;
  provider: string;
}

/** The whole page: three rows in `customer`, `meta`, `internal` order. */
export interface PlatformPlannerModelSettingsDTO {
  rows: PlatformPlannerModelRowDTO[];
  offered: PlatformPlannerOfferedModelDTO[];
  /** True only for a `superadmin`; every other staff role reads. */
  canEdit: boolean;
}

/** What a save reports back. */
export interface PlatformPlannerModelWriteDTO {
  audience: PlannerAudience;
  fromModel: string;
  toModel: string;
  updatedAt: string;
}
