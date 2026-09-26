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
 * the three refusals `isRefusalSeedGate` accepts today. Widening it is
 * MOTIR-6070 / MOTIR-6071's, together with the row's verb lookup, which is
 * TOTAL over this list.
 */
export const PLAN_SESSION_SEED_GATE_KINDS = [
  'decision_approval',
  'decision_confirmation',
  'decision_choice',
] as const;

export type PlanSessionSeedGateKindDto = (typeof PLAN_SESSION_SEED_GATE_KINDS)[number];

/** Whether a seeded session re-plans after a REFUSAL, or plans the follow-up to a PICK. */
export type PlanSessionSeedOriginDto = 'refusal' | 'pick';

/** Where a SEEDED session came from: the seeding gate's work item and kind. */
export interface PlanSessionSeedDto {
  /** The seeding work item's identifier (`ACME-44`) — the row links to it. For a
   *  pick it is the CHOICE card, not the session's anchor. */
  cardKey: string;
  gateKind: PlanSessionSeedGateKindDto;
  /** A pick is never a refusal (MOTIR-6434): the row words them differently. */
  origin: PlanSessionSeedOriginDto;
  /** The chosen option's label on a pick; null on a refusal. */
  chosenLabel: string | null;
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

/**
 * WHICH sessions a Plans-room read covers (Story MOTIR-6179 · MOTIR-6330).
 *
 *   * `project` — every session of the project; served only to a reader who
 *     holds `plan:view_any`.
 *   * `mine` — the sessions the reader started, and those holding a plan they
 *     asked for, decided, or have routed to them; served to anyone who browses.
 *
 * A caller only ASKS for one. The service resolves what it SERVES and says so on
 * the DTO, the `approvalGatesService.listRecords` shape: a `project` request from
 * a reader without the key is served `mine`, never refused.
 */
export type PlanSessionView = 'mine' | 'project';

export interface PlanSessionListPageDto {
  sessions: PlanSessionRowDto[];
  /** Opaque; null at the end of the list. */
  nextCursor: string | null;
  /** The scope the service actually SERVED — see {@link PlanSessionView}. */
  scope: PlanSessionView;
}
