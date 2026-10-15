import type { ApprovalQueueDto } from '@/lib/dto/approvalGate';
import type { HomePageDto, HomeTabCountsDto, WorkbenchPlanningPageDto } from '@/lib/dto/home';
import type { WorkflowDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberWithAccessDTO } from '@/lib/dto/workspaces';
import type { WorkbenchTab } from '@/lib/workbench/tab';

// The Workbench's LIVE wire types (Story MOTIR-5238 · Subtask MOTIR-5240).
//
// ⚠️ NOTHING HERE CARRIES WORK-ITEM CONTENT, and that is a property rather than
// an omission. The live stream answers one question — *has anything you can see
// changed since the watermark you hold, and in which tabs?* — and the client
// re-reads through the reads it already has. So every access decision stays in
// those reads, and this payload can never leak a row a reader may not see.

/**
 * The six tabs the Workbench strip renders.
 *
 * The five WORK tabs are `homeService`'s (the assignee-OR-reporter union); the
 * fifth is the approvals queue's, which routes to exactly one recipient
 * (`assigneeId ?? reporterId`, `docs/decisions/approval-gates.md` §2). Two tabs
 * in one strip meaning two different things by *me* is a divergence that ADR
 * records itself refusing to "fix" — so the watermark takes each tab over its
 * OWN predicate rather than over a sixth definition of who sees what.
 */
export const WORKBENCH_TAB_KEYS = [
  'toDo',
  'inProgress',
  // TO FIX (MOTIR-6604) — another slice of the SAME membership read, carved out of
  // In progress, so it takes the work tabs' predicate rather than a new one.
  'toFix',
  // TO RESUME (MOTIR-7707) — the third slice of In progress's category.
  'toResume',
  'recentlyFinished',
  'approvals',
  'watching',
] as const;

export type WorkbenchTabKey = (typeof WORKBENCH_TAB_KEYS)[number];

/**
 * ONE tab's watermark — its SIZE, and the most recent moment anything in it was
 * touched (`null` for an empty tab).
 *
 * ⚠️ BOTH NUMBERS, BECAUSE NEITHER ALONE DETECTS A CHANGE. A count moves on an
 * arrival and on a departure and stays put when a row is EDITED in place —
 * which is precisely the case the story exists for, a decision's subject moving
 * under somebody who is reading it. A maximum moves on an edit and on an
 * arrival and stays put when a row LEAVES. A count-only watermark passes every
 * naive test and misses the one that matters.
 */
export interface WorkbenchTabWatermarkDto {
  count: number;
  /** ISO-8601, or `null` when the tab is empty. */
  latest: string | null;
}

/**
 * WHAT THE READER HAS NOT SEEN, per tab — the whole answer, for one reader in
 * one project.
 *
 * ⚠️ FIXED SIZE, WHATEVER THE PROJECT'S SIZE: five pairs and a cursor. That is
 * the property that makes polling this once a second affordable at all, and it
 * must not be traded away later for a richer frame.
 */
export interface WorkbenchWatermarkDto {
  /**
   * The opaque cursor a client presents next time. Carries every tab's pair, so
   * a resume needs no server-side memory of what was sent — a route that
   * remembers what it sent is a route that is wrong after a redeploy.
   */
  cursor: string;
  /** Every tab's current pair, in {@link WORKBENCH_TAB_KEYS} order. */
  tabs: Record<WorkbenchTabKey, WorkbenchTabWatermarkDto>;
  /**
   * WHICH TABS MOVED since the cursor the caller presented.
   *
   * Empty when nothing moved, and empty when NO cursor was presented — a reader
   * who has seen nothing has had nothing move under them, and the surface they
   * are about to render is its own first observation. A cursor that cannot be
   * read is the opposite case and names every tab: re-reading costs one render,
   * and a missed frame costs a stale list.
   */
  moved: WorkbenchTabKey[];
}

// ── ONE WORKBENCH READ (Story MOTIR-8539 · Subtask MOTIR-8573) ──────────────
//
// ⚠️ UNLIKE THE WATERMARK ABOVE, THIS CARRIES CONTENT — the active tab's rows —
// and it is a READ, not a frame: every access decision is made by the same
// service reads the page makes, through `workbenchWindowService.read`, which is
// the one pairing of a tab's window with the strip's counts. A client applier
// re-reads it in place of a route refresh, and the rows and the counts arrive
// TOGETHER, so § 21 / § 26's "the strip and the list agree" holds without one.

/** A work-item tab's window, with what the page shapes its rows from. */
export interface WorkbenchWorkItemWindowDto {
  kind: 'workItems';
  page: HomePageDto;
  members: WorkspaceMemberWithAccessDTO[];
  workflow: WorkflowDto;
}

/** To approve's window — the gate queue, read as `<ApprovalsTab>` reads it. */
export interface WorkbenchApprovalsWindowDto {
  kind: 'approvals';
  queue: ApprovalQueueDto;
}

/** Planning's window — page 1 at the tab's ceiling, read as `<PlanningTab>` reads it. */
export interface WorkbenchPlanningWindowDto {
  kind: 'planning';
  page: WorkbenchPlanningPageDto;
}

export type WorkbenchWindowContentDto =
  | WorkbenchWorkItemWindowDto
  | WorkbenchApprovalsWindowDto
  | WorkbenchPlanningWindowDto;

/** `GET /api/workbench/window` — the active tab's window and every strip count, read together. */
export interface WorkbenchWindowDto {
  tab: WorkbenchTab;
  window: WorkbenchWindowContentDto;
  /** `homeService.tabCounts`, unchanged — every count the strip renders. */
  counts: HomeTabCountsDto;
  /** ISO-8601 moment the read started. */
  readAt: string;
}
