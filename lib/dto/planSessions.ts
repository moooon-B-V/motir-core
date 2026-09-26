import type { PlanSessionOriginDto } from '@/lib/dto/planChange';
import type { PlanStatusDto } from '@/lib/dto/plans';

// The Plans page's SESSION LIST (MOTIR-6025, `agent-authored-plans.md`
// AMENDMENT 17 §8; built to `design/ai-planning/design-notes.md` Part XIX).
// `/plans` lists planning CONVERSATIONS, newest activity first, and each row
// states its latest plan's state — or that it has proposed nothing yet.

/**
 * A session's PLAN STATE — its LATEST plan's `PlanStatus`, or `none` when it has
 * proposed nothing (§8). `none` is a member of the vocabulary in its own right,
 * never a fallback: the filter, the counts and the chip are all TOTAL over it.
 * The type is derived from the array, so the two cannot drift.
 */
export const PLAN_SESSION_STATE_VALUES = [
  'none',
  'generating',
  'planned',
  'stale',
  'approved',
  'declined',
] as const satisfies readonly ('none' | PlanStatusDto)[];

export type PlanSessionStateDto = (typeof PLAN_SESSION_STATE_VALUES)[number];

/** How many sessions hold each plan state — total over the vocabulary. */
export type PlanSessionStateCountsDto = Record<PlanSessionStateDto, number>;

/**
 * The gate kinds a session can be SEEDED by (story MOTIR-6068 · MOTIR-6209) —
 * the refusals `isRefusalSeedGate` accepts today: the three decision kinds and,
 * since MOTIR-6424, a `design_result` sent back with the Re-plan verdict. Widening
 * it further is MOTIR-6071's, together with the row's verb lookup, which is TOTAL
 * over this list.
 */
export const PLAN_SESSION_SEED_GATE_KINDS = [
  'decision_approval',
  'decision_confirmation',
  'decision_choice',
  'design_result',
] as const;

export type PlanSessionSeedGateKindDto = (typeof PLAN_SESSION_SEED_GATE_KINDS)[number];

/** Where a SEEDED session came from: the refused gate's work item and kind. */
export interface PlanSessionSeedDto {
  /** The refused work item's identifier (`ACME-44`) — the row links to it. */
  cardKey: string;
  gateKind: PlanSessionSeedGateKindDto;
}

/** One row of the list: one session, and the one plan it is known by. */
export interface PlanSessionRowDto {
  id: string;
  origin: PlanSessionOriginDto;
  /** The anchor set, as identifiers; empty = the whole project. */
  targetKeys: string[];
  lastActivityAt: string;
  /** Who started it. Null on a cadence session and on a departed member's. */
  startedBy: { id: string; name: string } | null;
  /** The session's first `user` turn — what was asked. Null when it has none
   *  (every door but a conversation opens a session without a turn). */
  firstTurn: string | null;
  /** The LATEST plan, or null when the session has proposed nothing. */
  latestPlan: { id: string; status: PlanStatusDto; title: string | null } | null;
  /** How many plans the session holds — `latestPlan` included. */
  planCount: number;
  /** The refused gate that SEEDED the session (MOTIR-6207's `seedGateId`),
   *  resolved to its work item. Null on an unseeded session, when the gate row is
   *  gone (`SetNull`), and when the viewer cannot browse the gate's work item —
   *  an unresolvable seed reads exactly like no seed (MOTIR-6209). */
  seed: PlanSessionSeedDto | null;
}

export interface PlanSessionListPageDto {
  sessions: PlanSessionRowDto[];
  /** Opaque; null at the end of the list. */
  nextCursor: string | null;
}
