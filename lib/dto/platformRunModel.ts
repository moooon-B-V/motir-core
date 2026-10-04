// The operator console's HOSTED-RUN MODELS page — Story MOTIR-7521 · MOTIR-7525.
//
// Which models a hosted run may use, for every project. Staff-facing only: no
// tenant DTO carries the list itself (a tenant sees only its RESULT, the
// narrowed Run hosted offer).

import type { WorkItemDifficultyDto } from '@/lib/dto/workItems';

/** One live project whose override names the model, and at which levels. */
export interface PlatformRunModelProjectUseDTO {
  projectKey: string;
  projectName: string;
  levels: WorkItemDifficultyDto[];
}

/** One listed model, as the page renders it. */
export interface PlatformRunModelEntryDTO {
  model: string;
  /** motir-ai's provider for it; null when motir-ai does not offer it now. */
  provider: string | null;
  /** Whether motir-ai offers it for hosted runs right now. */
  offered: boolean;
  createdAt: string;
  /** The adder's display name; null for a seeded row (and an account since removed). */
  addedBy: string | null;
  /** True for a row the first-read seed wrote rather than an operator added. */
  seeded: boolean;
  /** The levels motir-ai's platform default puts on it. */
  platformDefaultLevels: WorkItemDifficultyDto[];
  /** The live projects that override a level to it — what blocks a remove. */
  projects: PlatformRunModelProjectUseDTO[];
}

/** A model the Add picker may offer: offered by motir-ai, not yet listed. */
export interface PlatformRunModelAddableDTO {
  id: string;
  provider: string;
}

/** The whole page. */
export interface PlatformRunModelListDTO {
  entries: PlatformRunModelEntryDTO[];
  addable: PlatformRunModelAddableDTO[];
  /** True only for a `superadmin`; every other staff role reads. */
  canEdit: boolean;
}
