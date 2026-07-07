// The importer PERSIST engine (Story 7.16 · MOTIR-941) — the write-enabled half.
// 4-layer (`motir-core/CLAUDE.md`): a service that turns the SLICE-A classifier's
// verdicts into real work items, entirely THROUGH `workItemsService` + its
// sibling Epic-2 services (labels / comments / links). There is NO second write
// path around the authority, so every imported row obeys the 6.4 permission
// gate, the tenant guard, and validation (the ADR §2 contract).
//
// ── The "one engine" invariant ────────────────────────────────────────────
// The real run is the SLICE-A preview with writes switched ON, NOT a separate
// path: `runImport` calls the IDENTICAL `importEngineService.classifyIssue`
// (resolve → hash → idempotency lookup → CREATE/UPDATE/SKIP) the dry-run
// `preview` calls, then persists per the returned plan. The run can therefore
// never diverge from the preview (ADR §4).
//
// ── Idempotency (ADR §3) ──────────────────────────────────────────────────
// Absent `(project, source, externalId)` mapping → CREATE + record the mapping;
// present → UPDATE the mapped work item (re-sync source-owned fields; the
// sourceHash SKIPs an unchanged issue). A re-run creates zero duplicates: the
// per-run status guard rejects a second concurrent run of the SAME import, the
// mapping write locks `FOR UPDATE` + converges concurrent first-inserts on the
// `@@unique(project, source, externalId)` via a P2002 catch.
//
// ── At scale (ADR §1) ─────────────────────────────────────────────────────
// Pages stream from the connector (never all-into-memory) and each issue is its
// OWN short transaction chain — the opposite of one giant tx, so a 10k-issue
// import never holds a single long-lived transaction. A per-issue failure is
// recorded and the run CONTINUES (partial success), never aborts the page/run.
//
// ── Parent + links: a SECOND pass ─────────────────────────────────────────
// A child may be imported before its parent, so parent/link edges resolve in a
// second pass over a compact in-run index (falling back to the persisted map
// for a parent imported in a PRIOR run). The kind-parent matrix is honoured —
// an illegal edge is a surfaced WARNING, never a 500.

import { Prisma } from '@prisma/client';
import type { Import, ImportSource } from '@prisma/client';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { labelsService } from '@/lib/services/labelsService';
import { commentsService } from '@/lib/services/commentsService';
import { importRepository } from '@/lib/repositories/importRepository';
import { importedIssueRepository } from '@/lib/repositories/importedIssueRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { relationshipToLink } from '@/lib/workItems/linkRelationships';
import type { RelationshipKind } from '@/lib/dto/workItemLinks';
import { canParent, type IssueType } from '@/lib/issues/parentRules';
import type { IssueSourceConnector, SourceIssue } from '../connectors/types';
import { importEngineService, type ImportEngineDeps } from './importEngineService';
import type {
  ImportMapping,
  ImportResolveContext,
  ImportPlanRow,
  ResolvedComment,
  ResolvedWorkItemPayload,
} from './types';
import { ImportAlreadyRunningError } from '../errors';

/** Live per-outcome tallies of a run (mirrors the `Import.*Count` columns). */
export interface ImportRunCounts {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

/** One streamed progress event. A per-issue `item` as each is persisted, then a
 *  terminal `summary` with the final counts + status. Consumed by the run
 *  route's streaming response and the vitest assertions. */
export type ImportRunProgress =
  | {
      type: 'item';
      externalId: string;
      plan: ImportPlanRow['plan'];
      /** The work item's identifier (e.g. `MOTIR-42`) on create/update, else null. */
      workItemKey: string | null;
      warnings: string[];
      /** Set when this issue FAILED to persist (counted in `failed`). */
      error?: string;
    }
  | { type: 'summary'; counts: ImportRunCounts; status: Import['status'] };

/** How often (in processed issues) the run flushes its live counts to the
 *  `Import` row so `GET /api/import/:id` reflects progress mid-run. */
const COUNTS_FLUSH_EVERY = 50;

/** A resolved item, indexed by its source externalId for the 2nd pass. */
interface ResolvedRef {
  workItemId: string;
  /** The DESIRED final kind (a subtask whose parent is deferred is CREATED as a
   *  `task`, then restored to `subtask` alongside its parent edge in pass 2). */
  desiredKind: IssueType;
}

/** A pass-2 work item: has a parent and/or links to wire once every item exists. */
interface PendingEdge {
  externalId: string;
  workItemId: string;
  desiredKind: IssueType;
  parentExternalId: string | null;
  links: ResolvedWorkItemPayload['links'];
}

export interface RunImportParams {
  /** The draft/previewed `Import` row's id (owns source + mapping + counts). */
  importId: string;
  /** The paginated source connector (its `.source` tags the idempotency key). */
  connector: IssueSourceConnector;
  /** The user-confirmed field mapping (from `Import.mapping`). */
  mapping: ImportMapping;
  /** The per-run resolve context (built by `importEngineService.buildResolveContext`). */
  ctx: ImportResolveContext;
}

export const importPersistService = {
  /**
   * Execute an import: stream the connector, persist each issue through
   * `workItemsService`, wire parents/links in a 2nd pass, and record per-issue
   * outcomes on the `Import` row. Yields streamed progress (an event per issue,
   * then a final summary). The SAME `classifyIssue` the dry-run preview uses
   * decides CREATE/UPDATE/SKIP — writes are the only addition.
   *
   * `engineDeps` injects the classifier's READ seams (default: the real
   * repositories) so the classify half stays unit-testable; the WRITE half runs
   * against the real services + Postgres (the motir-core test convention).
   */
  async *runImport(
    params: RunImportParams,
    engineDeps: ImportEngineDeps = {},
  ): AsyncGenerator<ImportRunProgress> {
    const { importId, connector, mapping, ctx } = params;
    const source = connector.source as ImportSource;
    const svcCtx: ServiceContext = { userId: ctx.importingUserId, workspaceId: ctx.workspaceId };

    // ── Run-status guard ──────────────────────────────────────────────────
    // Flip draft/previewed/(retryable) → running ATOMICALLY; a second concurrent
    // run of the SAME import (already `running`) is rejected. This is the
    // primary defence against a re-run racing itself into duplicate creates —
    // the per-issue `FOR UPDATE` + `@@unique` cover the rarer cross-import race.
    await db.$transaction(async (tx) => {
      const current = await importRepository.findById(importId, tx);
      if (current && current.status === 'running') {
        throw new ImportAlreadyRunningError(importId);
      }
      await importRepository.update(importId, { status: 'running' }, tx);
    });

    const counts: ImportRunCounts = { created: 0, updated: 0, skipped: 0, failed: 0 };
    const resolved = new Map<string, ResolvedRef>();
    const pending: PendingEdge[] = [];
    let processed = 0;

    // ── Pass 1 — create/update every issue (no parent edges yet) ──────────
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (;;) {
      const page = await connector.listIssues(cursor);
      for (const issue of page.issues) {
        const progress = await persistOnePass1(
          issue,
          { source, mapping, ctx, svcCtx, importId },
          engineDeps,
          resolved,
          pending,
          counts,
        );
        yield progress;
        if (++processed % COUNTS_FLUSH_EVERY === 0) await flushCounts(importId, counts);
      }
      // A connector's own per-issue fetch errors surface as failed issues too.
      for (const e of page.errors) {
        counts.failed += 1;
        yield {
          type: 'item',
          externalId: e.externalId ?? '(unknown)',
          plan: 'create',
          workItemKey: null,
          warnings: [],
          error: e.message,
        };
      }
      if (page.nextCursor === null || seenCursors.has(page.nextCursor)) break;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    // ── Pass 2 — wire parents + relationship links now every item exists ──
    for (const edge of pending) {
      const warnings = await wireEdges(edge, { source, ctx, svcCtx }, resolved);
      if (warnings.length > 0) {
        yield {
          type: 'item',
          externalId: edge.externalId,
          plan: 'update',
          workItemKey: null,
          warnings,
        };
      }
    }

    // ── Finalise the run status + counts ──────────────────────────────────
    const status: Import['status'] =
      counts.failed === 0
        ? 'succeeded'
        : counts.created + counts.updated + counts.skipped > 0
          ? 'partially_failed'
          : 'failed';
    await db.$transaction((tx) =>
      importRepository.update(
        importId,
        {
          status,
          createdCount: counts.created,
          updatedCount: counts.updated,
          skippedCount: counts.skipped,
          failedCount: counts.failed,
        },
        tx,
      ),
    );
    yield { type: 'summary', counts, status };
  },
};

/** Persist ONE issue (pass 1): classify (identical to preview) → CREATE / UPDATE
 *  / SKIP through `workItemsService`, apply status + labels + comments, record
 *  the idempotency mapping, and index the item for the 2nd pass. Any failure is
 *  captured per-issue (counted, surfaced) and the run continues. */
async function persistOnePass1(
  issue: SourceIssue,
  env: {
    source: ImportSource;
    mapping: ImportMapping;
    ctx: ImportResolveContext;
    svcCtx: ServiceContext;
    importId: string;
  },
  engineDeps: ImportEngineDeps,
  resolved: Map<string, ResolvedRef>,
  pending: PendingEdge[],
  counts: ImportRunCounts,
): Promise<ImportRunProgress> {
  const { source, mapping, ctx, svcCtx, importId } = env;
  try {
    // The SHARED classifier — the exact call the dry-run preview makes.
    const row = await importEngineService.classifyIssue(source, issue, mapping, ctx, engineDeps);
    const { plan, payload } = row;

    if (plan === 'skip') {
      counts.skipped += 1;
      return {
        type: 'item',
        externalId: issue.externalId,
        plan,
        workItemKey: row.existingWorkItemId,
        warnings: row.warnings,
      };
    }

    const desiredKind = payload.kind;
    // A subtask MUST have a parent (parentRules `TYPES_REQUIRING_PARENT`), but a
    // parent may be imported LATER — so create a deferred-parent subtask as a
    // parent-legal `task` and restore its kind alongside the edge in pass 2.
    // (A subtask is a leaf, never a legal parent, so a downgraded item is never
    // someone's parent in a valid tree — pass 2 has no ordering hazard.)
    const deferParent = payload.parentExternalId !== null;
    const createKind: IssueType = desiredKind === 'subtask' && deferParent ? 'task' : desiredKind;

    let workItemId: string;
    let workItemKey: string;
    if (plan === 'create') {
      const created = await workItemsService.createWorkItem(
        {
          projectId: ctx.projectId,
          kind: createKind,
          title: payload.title,
          descriptionMd: payload.descriptionMd,
          priority: payload.priority,
          assigneeId: payload.assigneeId,
          // reporterId is NOT settable on create (forced to the importing user);
          // the source reporter is preserved via an attribution note below (the
          // ADR §Consequences #2 degraded fallback).
        },
        svcCtx,
      );
      workItemId = created.id;
      workItemKey = created.identifier;
      counts.created += 1;
    } else {
      // UPDATE (re-run) — re-sync the source-owned scalar fields on the mapped
      // item. Kind + parent are re-synced in pass 2 (uniform with create);
      // Motir-local-only fields (local comments, links, estimate) are never
      // touched (ADR §3 update policy).
      workItemId = row.existingWorkItemId as string;
      const updated = await workItemsService.updateWorkItem(
        workItemId,
        {
          title: payload.title,
          descriptionMd: payload.descriptionMd,
          priority: payload.priority,
          assigneeId: payload.assigneeId,
        },
        svcCtx,
      );
      workItemKey = updated.identifier;
      counts.updated += 1;
    }

    // Status (ADR §Consequences #1): apply the mapped status through the
    // import/system status path — reaches a done-category status so a closed
    // source issue lands closed. A no-op when it already matches.
    if (payload.statusKey) {
      await workItemsService.setImportedStatus(workItemId, payload.statusKey, svcCtx);
    }

    // Labels — find-or-create by name (setLabels replaces the source-label set,
    // a source-owned field on re-run).
    if (payload.labels.length > 0) {
      await labelsService.setLabels(workItemId, payload.labels, svcCtx);
    }

    // Comments — only on CREATE (append-new-on-re-run needs comment provenance
    // not modelled yet; re-importing on every run would duplicate). Author +
    // timestamp preserved via an in-body attribution line (ADR §Consequences #3
    // degraded fallback — `addComment` forces the importing user + now()).
    const commentWarnings: string[] = [];
    if (plan === 'create' && payload.comments.length > 0) {
      for (const c of payload.comments) {
        await commentsService.addComment(workItemId, { bodyMd: commentWithAttribution(c) }, svcCtx);
      }
    } else if (plan === 'update' && payload.comments.length > 0) {
      commentWarnings.push('source comments are imported once, on first import — not re-synced');
    }

    // Attachments — recorded as a warning: fetching source bytes needs the
    // connector's per-source auth scope (MOTIR-943), out of this slice's scope.
    const attachmentWarnings =
      payload.attachments.length > 0
        ? [`${payload.attachments.length} source attachment(s) not imported (needs source auth)`]
        : [];

    // Reporter attribution (degraded fallback) — the source reporter is captured
    // in a warning when it couldn't be preserved as the Motir reporter.
    const reporterWarnings =
      payload.reporterEmail && !payload.reporterId
        ? [`reporter ${payload.reporterEmail} preserved as the importing user (unmatched)`]
        : [];

    // Record the idempotency mapping (locked + P2002-converged).
    await upsertMappingSafely({
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      source,
      externalId: issue.externalId,
      workItemId,
      importId,
      sourceHash: row.sourceHash,
    });

    resolved.set(issue.externalId, { workItemId, desiredKind });
    if (payload.parentExternalId !== null || payload.links.length > 0) {
      pending.push({
        externalId: issue.externalId,
        workItemId,
        desiredKind,
        parentExternalId: payload.parentExternalId,
        links: payload.links,
      });
    }

    return {
      type: 'item',
      externalId: issue.externalId,
      plan,
      workItemKey,
      warnings: [...row.warnings, ...commentWarnings, ...attachmentWarnings, ...reporterWarnings],
    };
  } catch (err) {
    // Per-issue partial failure — record it, keep the rest of the run going.
    counts.failed += 1;
    return {
      type: 'item',
      externalId: issue.externalId,
      plan: 'create',
      workItemKey: null,
      warnings: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Pass 2 for ONE item: resolve its parent edge (kind-parent matrix honoured;
 *  illegal / unresolved → warning) and its relationship links. Returns the
 *  warnings surfaced. Never throws — a bad edge is a warning, not a 500. */
async function wireEdges(
  edge: PendingEdge,
  env: { source: ImportSource; ctx: ImportResolveContext; svcCtx: ServiceContext },
  resolved: Map<string, ResolvedRef>,
): Promise<string[]> {
  const { source, ctx, svcCtx } = env;
  const warnings: string[] = [];

  // ── Parent edge ─────────────────────────────────────────────────────────
  if (edge.parentExternalId !== null) {
    const parent = await resolveRef(edge.parentExternalId, source, ctx, resolved);
    if (!parent) {
      warnings.push(
        `parent "${edge.parentExternalId}" of "${edge.externalId}" was not imported — left top-level`,
      );
      // A subtask with no resolvable parent stays the `task` it was created as.
    } else if (!canParent(parent.desiredKind, edge.desiredKind)) {
      warnings.push(
        `"${parent.desiredKind}" cannot parent "${edge.desiredKind}" — parent edge of "${edge.externalId}" dropped`,
      );
    } else {
      try {
        await workItemsService.updateWorkItem(
          edge.workItemId,
          { parentId: parent.workItemId, kind: edge.desiredKind },
          svcCtx,
        );
      } catch (err) {
        warnings.push(
          `could not set parent of "${edge.externalId}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ── Relationship links ────────────────────────────────────────────────────
  for (const link of edge.links) {
    const target = await resolveRef(link.targetExternalId, source, ctx, resolved);
    if (!target) {
      warnings.push(`link target "${link.targetExternalId}" of "${edge.externalId}" not imported`);
      continue;
    }
    const relationship = sourceLinkToRelationship(link.type);
    const directed = relationshipToLink(relationship, edge.workItemId, target.workItemId);
    try {
      await workItemsService.linkWorkItems(directed, svcCtx);
    } catch (err) {
      // A duplicate / illegal link is a warning, never fatal.
      warnings.push(
        `link "${link.type}" → "${link.targetExternalId}" skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return warnings;
}

/** Resolve a source externalId to a Motir work item — this run's index first,
 *  then the PERSISTED map (a parent imported in a PRIOR run). */
async function resolveRef(
  externalId: string,
  source: ImportSource,
  ctx: ImportResolveContext,
  resolved: Map<string, ResolvedRef>,
): Promise<ResolvedRef | null> {
  const inRun = resolved.get(externalId);
  if (inRun) return inRun;
  const mapped = await importedIssueRepository.findBySourceId(ctx.projectId, source, externalId);
  if (!mapped) return null;
  // A prior-run item's kind is unknown here; the DB trigger backstops legality.
  return { workItemId: mapped.workItemId, desiredKind: 'task' };
}

/** Upsert the `(project, source, externalId) → work_item` mapping under a row
 *  lock, converging a concurrent first-insert race on the `@@unique` via a
 *  single P2002-retry (the row then exists → the upsert takes its UPDATE arm).
 *  The lock-before-read-derived-update rule (`notes.html` #35). */
async function upsertMappingSafely(input: {
  workspaceId: string;
  projectId: string;
  source: ImportSource;
  externalId: string;
  workItemId: string;
  importId: string;
  sourceHash: string;
}): Promise<void> {
  const write = () =>
    db.$transaction(async (tx) => {
      await importedIssueRepository.lockBySourceId(
        input.projectId,
        input.source,
        input.externalId,
        tx,
      );
      await importedIssueRepository.upsert(input, tx);
    });
  try {
    await write();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      await write(); // the row now exists — the upsert converges on UPDATE.
      return;
    }
    throw err;
  }
}

/** Map a source link's raw type token to a Motir relationship (default
 *  `relates_to` — the safe, always-legal relationship). */
function sourceLinkToRelationship(type: string): RelationshipKind {
  const t = type
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (t === 'blocks' || t === 'is_blocking') return 'blocks';
  if (t === 'blocked_by' || t === 'is_blocked_by') return 'blocked_by';
  if (t === 'duplicates' || t === 'duplicate') return 'duplicates';
  if (t === 'clones' || t === 'clone') return 'clones';
  return 'relates_to';
}

/** Prefix an imported comment with a source-author/timestamp attribution line —
 *  the ADR §Consequences #3 degraded fallback (`addComment` forces the importing
 *  user + `now()`, so the original is captured in the body). */
function commentWithAttribution(c: ResolvedComment): string {
  const who = c.authorName ?? c.authorEmail ?? 'unknown';
  const when = c.createdAt ? ` on ${c.createdAt}` : '';
  return `_Imported comment — originally by ${who}${when}_\n\n${c.body}`;
}

/** Flush live counts to the `Import` row (mid-run progress for `GET /:id`). */
async function flushCounts(importId: string, counts: ImportRunCounts): Promise<void> {
  await db.$transaction((tx) =>
    importRepository.update(
      importId,
      {
        createdCount: counts.created,
        updatedCount: counts.updated,
        skippedCount: counts.skipped,
        failedCount: counts.failed,
      },
      tx,
    ),
  );
}
