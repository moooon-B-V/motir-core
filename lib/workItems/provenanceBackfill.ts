import type {
  Executor,
  WorkItemImplementationSource,
  WorkItemPlanningSource,
  WorkItemType,
} from '@/generated/prisma/client';

// Provenance BACKFILL rules (MOTIR-1758, docs/decisions/work-item-provenance.md)
// — the pure decision table behind `pnpm db:backfill:provenance`.
//
// Story MOTIR-1685 shipped the six provenance columns and the Provenance
// section that renders them, but only rows written AFTER it landed carry a
// value; MOTIR's own tree — authored across ten epics before that — carries all
// six NULL. This module decides, for one already-read row, what (if anything)
// may be stamped on it TRUTHFULLY, from evidence already in the database.
//
// It is deliberately a PURE function over a row shape, with no Prisma / no I/O:
// the rules are the part that has to be right, so they are unit-testable
// without a database, and the repository/service layers own the reads + writes
// (4-layer applies to operator tooling too).
//
// THE ONE RULE ABOVE ALL OTHERS: a column that cannot be derived from evidence
// stays NULL. A null triple is a valid, honest state the DTO and the Provenance
// section already handle (`toWorkItemDto` maps null through; the section renders
// `—`); a fabricated one would put a false claim on ~1 700 items. That is why
// `planningHarness` / `planningModel` / `implementationHarness` /
// `implementationModel` are NEVER written by the backfill — the harness varied
// across six weeks and the model is recorded nowhere — and why `hosted` is never
// written (it is unreachable from self-reported seams by design; ADR Decision 4).

/**
 * The instant the `pnpm db:seed` bootstrap burst ENDED in the live MOTIR
 * project — the boundary that splits hand-authored-and-script-loaded rows
 * (`manual`) from everything created afterwards through the MCP (`mcp`).
 *
 * DERIVED FROM THE DATA on 2026-07-31, not guessed. `scripts/plan-seed/seed.ts`
 * creates each item in its own tiny transaction inside one loop, so the seed
 * shows up as a dense sub-minute burst followed by a long quiet gap. Read off
 * the live tenant (via the MCP `get_work_item`, which returns `createdAt`; the
 * equivalent SQL is below), bisecting on `key` — allocation order IS creation
 * order, so `createdAt` is monotonic in `key`:
 *
 *   MOTIR-1    2026-06-15T14:27:03.282Z  ─┐ the seed burst: 756 items in 13.0s
 *   MOTIR-400  2026-06-15T14:27:10.292Z   │
 *   MOTIR-756  2026-06-15T14:27:16.297Z  ─┘ LAST seed row
 *   MOTIR-757  2026-06-15T15:05:15.028Z  ←  first post-seed (MCP) row, +37m59s
 *
 * The 38-minute gap either side of this instant is what makes the boundary
 * unambiguous — no row sits near it. The equivalent query, for re-deriving it
 * against any tenant:
 *
 *   SELECT key, identifier, created_at,
 *          created_at - lag(created_at) OVER (ORDER BY key) AS gap
 *     FROM work_item
 *    WHERE project_id = $1
 *    ORDER BY key
 *    LIMIT 1000;   -- the seed burst is the leading run of sub-second gaps
 *
 * A row created EXACTLY at this instant counts as seed (the comparison is
 * inclusive) — MOTIR-756 is a seed row.
 *
 * This constant is MOTIR-specific. The script takes `--seed-burst-end` so the
 * same tooling can serve another tenant without editing code, and REPORTS the
 * boundary it used plus the row count either side, so the operator sees the
 * split before any write happens.
 */
export const MOTIR_SEED_BURST_END = new Date('2026-06-15T14:27:16.297Z');

/**
 * The `done`-CATEGORY status that means abandoned, not implemented. The
 * default workflow files `cancelled` under `category: 'done'` alongside `done`
 * (lib/workflows/defaultWorkflow.ts), so the terminal set alone would sweep
 * cancelled items into an implementation stamp. Nothing was implemented on a
 * cancelled card, so it is excluded — the same local-constant exclusion
 * `workItemsService` (ROADMAP_CANCELLED_KEY) and `publicProjectsService`
 * (ROADMAP_EXCLUDED_DONE_KEY) already make against this set.
 *
 * That claim was HALF TRUE when written: `workItemsService` made the exclusion on
 * its roadmap meter but NOT on its live `applyStatusTransition` stamp, so this
 * offline classifier and the live lane disagreed about which terminal statuses
 * mean implemented, and cancelling a human/manual card wrote `manual` onto
 * abandoned work. MOTIR-2221 closed the gap (guard + a forward data migration
 * clearing the rows already written); the two encodings now agree, and
 * `tests/integration/work-items/provenance-cancelled-parity.test.ts` pins them
 * together so they cannot drift apart again silently.
 */
export const CANCELLED_STATUS_KEY = 'cancelled';

/** The evidence the classifier reads. One already-fetched `work_item` row. */
export interface ProvenanceBackfillRow {
  id: string;
  identifier: string;
  createdAt: Date;
  /** The item's status KEY (`work_item.status`), matched against `implementedStatusKeys`. */
  status: string;
  type: WorkItemType | null;
  executor: Executor | null;
  /** Already-carried provenance — non-null means HANDS OFF, whatever the rules say. */
  planningSource: WorkItemPlanningSource | null;
  implementationSource: WorkItemImplementationSource | null;
  /** Whether at least one `GithubPullRequest` row points at this item (the 7.10.3 mirror). */
  hasLinkedPr: boolean;
  /** The integrated-awaiting-review branch, when the item still carries one. */
  sessionBranch: string | null;
}

/**
 * What the backfill would write on one row. `null` on either half means
 * "write nothing to that column" — either because the row already carries a
 * value, or because no evidence supports one.
 */
export interface ProvenanceVerdict {
  planningSource: BackfillablePlanningSource | null;
  implementationSource: BackfillableImplementationSource | null;
}

/**
 * The planning sources the backfill can DERIVE. `native` is absent by
 * construction: it means "materialized from a motir-ai-generated plan", which
 * only `plansService.materialize` can know — no row shape reveals it
 * retroactively. Narrowing the return type here is what makes that a
 * compile-time guarantee rather than a comment.
 */
export type BackfillablePlanningSource = Extract<WorkItemPlanningSource, 'manual' | 'mcp'>;

/**
 * The implementation sources the backfill can DERIVE. `hosted` is absent by
 * construction — it is unreachable from self-reported seams by design (the ADR)
 * and Epic 9 does not exist yet — so no code path can produce it.
 */
export type BackfillableImplementationSource = Extract<
  WorkItemImplementationSource,
  'byok' | 'manual'
>;

export interface ClassifyProvenanceOptions {
  /** The seed-burst boundary; rows created at or before it are `manual`. */
  seedBurstEnd: Date;
  /**
   * The status keys that mean "this work actually shipped" — the project's
   * `done`-category set MINUS {@link CANCELLED_STATUS_KEY}. Per-project rather
   * than a hardcoded `'done'` literal, because a custom workflow can name its
   * terminal states anything (the same generalization `getTerminalStatusKeys`
   * made for readiness).
   */
  implementedStatusKeys: ReadonlySet<string>;
}

/**
 * Decide the PLANNING source for one row.
 *
 * - Already stamped → `null` (never overwritten; an item created since
 *   provenance shipped keeps exactly what its writer recorded).
 * - Created in the seed burst → `manual`: those rows were authored by a
 *   human-driven planner and loaded by a script. They were not proposed by the
 *   product, so `native` would be false; and they did not come through the
 *   agent tool surface, so `mcp` would be false too.
 * - Created afterwards → `mcp`: every post-seed row in this project was created
 *   through the MCP, which is exactly what the write path stamps on new rows
 *   today (`createWorkItem`'s tool surface). The backfill records the same
 *   truth retroactively.
 *
 * The accompanying `planningHarness` / `planningModel` are NOT derivable and
 * stay NULL — see the module header.
 */
export function classifyPlanningSource(
  row: ProvenanceBackfillRow,
  opts: ClassifyProvenanceOptions,
): BackfillablePlanningSource | null {
  if (row.planningSource !== null) return null;
  return row.createdAt.getTime() <= opts.seedBurstEnd.getTime() ? 'manual' : 'mcp';
}

/**
 * Decide the IMPLEMENTATION source for one row.
 *
 * - Already stamped → `null` (a BYOK agent's own `mark_integrated` report wins).
 * - Not in an implemented-done status → `null`. Nothing was implemented yet, so
 *   any stamp would be a lie; that covers every `todo`/`blocked`/`in_progress`
 *   row, every `in_review` row (its work is not merged), and `cancelled`.
 * - A linked PR or a session branch → `byok`. Motir's own work has been
 *   implemented end-to-end by a bring-your-own-key agent on the user's machine,
 *   and a `GithubPullRequest` row (or the branch the session recorded) is the
 *   database's own evidence of it.
 * - No such evidence, but the card is human work (`executor: 'human'` or
 *   `type: 'manual'` — account setup, provisioning, DNS, approvals) → `manual`.
 * - Anything else → `null`. THIS IS THE LOAD-BEARING ABSTENTION: a done
 *   `coding_agent` card with no PR row is overwhelmingly a card that shipped
 *   before the GitHub App was ever installed on this workspace (MOTIR-1756),
 *   not a card someone did by hand. Stamping those `manual` would invent
 *   attribution for hundreds of items. Shipped code already settled this exact
 *   question the same way: `applyStatusTransition`'s manual lane gates on
 *   `executor === 'human' || type === 'manual'` and its comment records the
 *   rule — "a coding_agent item dragged to done without a report keeps null,
 *   not manual." The backfill obeys the same line rather than drawing a looser
 *   one, so a row's provenance means the same thing however it was written.
 *
 * `hosted` is never returned, and `implementationHarness` / `implementationModel`
 * stay NULL — see the module header.
 */
export function classifyImplementationSource(
  row: ProvenanceBackfillRow,
  opts: ClassifyProvenanceOptions,
): BackfillableImplementationSource | null {
  if (row.implementationSource !== null) return null;
  if (!opts.implementedStatusKeys.has(row.status)) return null;
  if (row.hasLinkedPr || row.sessionBranch !== null) return 'byok';
  if (row.executor === 'human' || row.type === 'manual') return 'manual';
  return null;
}

/** Both halves of the verdict for one row. */
export function classifyProvenance(
  row: ProvenanceBackfillRow,
  opts: ClassifyProvenanceOptions,
): ProvenanceVerdict {
  return {
    planningSource: classifyPlanningSource(row, opts),
    implementationSource: classifyImplementationSource(row, opts),
  };
}

/** How many identifiers a per-rule bucket keeps as a printable sample. */
export const PROVENANCE_BACKFILL_SAMPLE_SIZE = 5;

/** One rule's outcome: how many rows it selected, and a few of their identifiers. */
export interface ProvenanceBackfillBucket {
  /** Rows the rule selected (what a real run would write). */
  count: number;
  /** The first {@link PROVENANCE_BACKFILL_SAMPLE_SIZE} identifiers, in key order. */
  sample: string[];
  /** Rows actually written — `0` on a dry run, and `< count` if a row was stamped meanwhile. */
  written: number;
}

/** What one backfill pass decided and (unless dry-run) did. */
export interface ProvenanceBackfillReport {
  projectIdentifier: string;
  dryRun: boolean;
  /** The boundary used to split `manual` from `mcp`, echoed so the operator can check it. */
  seedBurstEnd: Date;
  /** The status keys treated as "implemented" (done-category minus cancelled). */
  implementedStatusKeys: string[];
  /** Rows read — every row still missing at least one source. */
  candidates: number;
  /** How many of those are archived (included deliberately; see the repository read). */
  archivedCandidates: number;
  /** Rows on either side of the boundary, so a wrong boundary is visible before it is used. */
  createdAtOrBeforeBoundary: number;
  createdAfterBoundary: number;
  planning: { manual: ProvenanceBackfillBucket; mcp: ProvenanceBackfillBucket };
  implementation: { byok: ProvenanceBackfillBucket; manual: ProvenanceBackfillBucket };
  /** Rows the implementation rules deliberately left NULL, by reason. */
  implementationLeftNull: {
    /** Already carried a source — untouched. */
    alreadyStamped: number;
    /** Not in an implemented-done status (incl. cancelled + in-review). */
    notImplementedYet: number;
    /** Done, but a coding-agent card with no PR and no branch — no evidence either way. */
    doneWithoutEvidence: number;
  };
}

/** An empty bucket, for a rule that selected nothing. */
export function emptyProvenanceBucket(): ProvenanceBackfillBucket {
  return { count: 0, sample: [], written: 0 };
}

/** Record one row against a bucket, keeping a bounded identifier sample. */
export function addToProvenanceBucket(bucket: ProvenanceBackfillBucket, identifier: string): void {
  bucket.count += 1;
  if (bucket.sample.length < PROVENANCE_BACKFILL_SAMPLE_SIZE) bucket.sample.push(identifier);
}
