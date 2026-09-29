import type {
  AgentInstanceChargeOutcome,
  AgentInstanceIntervalEndReason,
  AgentInstanceState,
} from '@/generated/prisma/client';

// The AGENT INSTANCE DTOs (Story MOTIR-6860 · MOTIR-6870), the shape the
// lifecycle service returns and the Instances page renders
// (`docs/decisions/agent-instances.md` §4).
//
// ⚠️ THE VOCABULARIES ARE THE PRISMA ENUMS, ALIASED — never re-declared, for
// `lib/dto/dispatchRuns.ts`'s reason: a member added to the schema is then a
// type error at every non-total `switch` that renders it.
//
// ⚠️ NO FLY IDENTIFIER IS ON THE WIRE. The app, machine and volume ids are
// Motir's handle on its own infrastructure, not something the owner acts on,
// and publishing them would make them a contract this shape owes stability to.

export type { AgentInstanceChargeOutcome, AgentInstanceIntervalEndReason, AgentInstanceState };

/** One instance, as its owner sees it. */
export interface AgentInstanceDto {
  id: string;
  name: string;
  projectId: string;
  /** The sandbox profile id (`claude`, `codex`, …). */
  profileId: string;
  /** The moving tag the pinned digest was resolved from. */
  imageTag: string;
  imageDigest: string;
  region: string;
  state: AgentInstanceState;
  /** Set on `failed`, in words; null otherwise. */
  failureReason: string | null;
  stateChangedAt: string;
  lastActivityAt: string;
  createdAt: string;
}

/** One running interval (§4). */
export interface AgentInstanceIntervalDto {
  id: string;
  startedAt: string;
  endedAt: string | null;
  endReason: AgentInstanceIntervalEndReason | null;
  billableSeconds: number | null;
  credits: number | null;
  chargeOutcome: AgentInstanceChargeOutcome | null;
}

/** One row of the My agents page: the instance plus its machine time this month. */
export interface AgentInstanceListItemDto extends AgentInstanceDto {
  profileName: string;
  /** Seconds of the running intervals overlapping the current calendar month (UTC). */
  machineSecondsThisMonth: number;
  /** The credits those seconds come to — each interval rounded up once, like its charge (§5). */
  creditsThisMonth: number;
  /**
   * Why Motir stopped a `hibernated` instance, when Motir did — out of credits, idle,
   * or the 12-hour backstop (AMENDMENT 2; the page's line under the name). Null for
   * any other state, and for a hibernate the person asked for.
   */
  stopReason: AgentInstanceStopReason | null;
}

/** The hibernations Motir makes on its own, which the page explains. */
export type AgentInstanceStopReason = 'credits' | 'idle' | 'backstop';

export interface AgentInstanceListPageDto {
  instances: AgentInstanceListItemDto[];
  total: number;
}
