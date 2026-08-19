import 'server-only';

import { embedTexts } from '@/lib/ai/motirAiClient';
import {
  EMBEDDING_DIMENSIONS,
  efSearchForLimit,
  workItemEmbeddingRepository,
  type WorkItemEmbeddingRankRow,
} from '@/lib/repositories/workItemEmbeddingRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { composeEmbeddingDocument, hashEmbeddingDocument } from '@/lib/workItems/embeddingDocument';
import { EmbeddingDimensionMismatchError } from '@/lib/workItems/errors';

// The plan-tree embedding WRITE PATH (Story MOTIR-2694 · Subtask MOTIR-2696, per
// `docs/decisions/plan-tree-embeddings.md` §6.3) — plus the ranking read the
// storage layer owes MOTIR-2697's endpoint.
//
// ⚠️ THE EXTERNAL CALL IS NEVER INSIDE A WRITE TRANSACTION. Every method here is
// explicitly staged as read-tx → HTTP → write-tx, with the `embedTexts` call
// sitting between two SHORT transactions rather than inside one long one. Two
// reasons, and both are load-bearing:
//   - it is the repo's side-effects-outside-the-transaction rule (CLAUDE.md), so
//     a gateway that hangs cannot hold a row lock or burn Prisma's 5s
//     interactive-transaction budget; and
//   - a provider outage must degrade an item to "not yet a candidate" — never
//     fail or roll back a card write. It cannot do the latter from here anyway
//     (this runs in a background job, long after the create committed), which is
//     precisely why the enqueue happens post-commit at the call site.
//
// THE JOB RE-READS BEFORE IT EMBEDS (ADR §6.3.3). It takes a work item ID, not a
// payload captured at enqueue, and reads the item's CURRENT title/description at
// run time. Two rapid edits therefore converge on the current text whichever
// order their jobs run in — and the second job's hash then matches the row the
// first wrote, so it skips. No sequence number, no lock, no ordering guard: the
// re-read plus the content hash are the whole convergence story.

/** motir-ai's per-request batch cap (`MAX_EMBEDDING_BATCH_INPUTS`, MOTIR-2720).
 *  Respected by CHUNKING here rather than discovered as a 400 over there. */
export const EMBEDDING_BATCH_MAX_INPUTS = 64;

/** How many work items one backfill page scans. Independent of the batch cap:
 *  the scan is a cheap local read, the batch is a metered network call.
 *  Exported so the paging test asserts against the real boundary rather than a
 *  number copied beside it, which would stop testing the boundary the day one
 *  of the two moved. */
export const BACKFILL_PAGE_SIZE = 200;

/** Why an embedding attempt wrote nothing. Every one of these is a VALUE, not an
 *  error — "not a candidate yet" is a legitimate resting state (ADR §6.3.5). */
export type EmbeddingSkipReason =
  /** No motir-ai configured — a self-hosted open-core deployment. Never throws:
   *  the whole feature is a cloud capability, and a self-hoster must not
   *  dead-letter a job per work-item edit to learn that. */
  | 'ai-not-configured'
  /** The item was deleted between the enqueue and this read. */
  | 'not-found'
  /** The stored hash already matches — the idempotent no-op that makes a retry,
   *  and the second of two racing edits, free. */
  | 'unchanged';

export interface EmbedWorkItemResult {
  embedded: boolean;
  reason?: EmbeddingSkipReason;
  /** The model the vector was produced with, when one was written. */
  model?: string;
}

export interface BackfillResult {
  /** Items examined across every page. */
  scanned: number;
  /** Items whose vector was (re-)written. */
  embedded: number;
  /** The model the vectors were written under; null when nothing needed work. */
  model: string | null;
}

export interface RankSimilarInput {
  workspaceId: string;
  projectId: string;
  model: string;
  queryEmbedding: number[];
  limit: number;
}

export interface RankSimilarResult {
  results: WorkItemEmbeddingRankRow[];
  /** How many of the project's items are rankable for this model — ADR §6.1's
   *  `coverage.embedded`, and the denominator the under-return check uses. */
  rankable: number;
  /** How many LIVE items the project holds at all — ADR §6.1's `coverage.total`.
   *  Read in the SAME transaction as `rankable` so the pair is one snapshot: a
   *  ratio assembled from two transactions can report 413/412 while a backfill
   *  runs, and a coverage number nobody can trust is worse than none. */
  total: number;
  /** True when the approximate pass under-returned and the exact re-run was
   *  needed. Surfaced so the behaviour is observable in tests and in a job
   *  ledger rather than being an invisible internal retry. */
  exactFallbackUsed: boolean;
}

/** Whether the closed motir-ai backend is wired for this deployment. Mirrors
 *  `aiBugTelemetryService`'s gate, for the same reason: an open-core motir-core
 *  with no AI backend must degrade, not hard-fail. */
function motirAiConfigured(): boolean {
  return Boolean(process.env['MOTIR_AI_URL'] && process.env['MOTIR_AI_SERVICE_TOKEN']);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const workItemEmbeddingsService = {
  /**
   * Derive and store ONE work item's embedding — the `work-item/embedding.requested`
   * job's entry point.
   *
   * Idempotent by construction: it recomputes the document hash from the item's
   * current text and returns `unchanged` when the stored row already matches, so
   * a retry, a redelivered event, or the trailing job of two rapid edits all cost
   * one cheap read and no provider call.
   *
   * Throws only on a genuine transport/infra failure, so the job's retry budget
   * absorbs a transient motir-ai outage. Every "nothing to do" outcome is a
   * value.
   */
  async embedWorkItem(input: {
    workspaceId: string;
    workItemId: string;
  }): Promise<EmbedWorkItemResult> {
    if (!motirAiConfigured()) return { embedded: false, reason: 'ai-not-configured' };

    // ── Stage 1: READ (short transaction, workspace GUC bound for RLS) ────────
    const pending = await withWorkspaceServiceContext(input.workspaceId, async (tx) => {
      const item = await workItemRepository.findById(input.workItemId, tx);
      if (!item || item.workspaceId !== input.workspaceId) return null;

      const document = composeEmbeddingDocument({
        title: item.title,
        descriptionMd: item.descriptionMd,
      });
      const contentHash = hashEmbeddingDocument(document);
      const existing = await workItemEmbeddingRepository.findByWorkItemId(item.id, tx);
      return {
        projectId: item.projectId,
        document,
        contentHash,
        unchanged: existing?.contentHash === contentHash,
      };
    });

    if (pending === null) return { embedded: false, reason: 'not-found' };
    if (pending.unchanged) return { embedded: false, reason: 'unchanged' };

    // ── Stage 2: the EXTERNAL call — deliberately between the transactions ────
    const batch = await embedTexts([pending.document]);
    const vector = batch.embeddings[0];
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingDimensionMismatchError(
        EMBEDDING_DIMENSIONS,
        vector?.length ?? 0,
        batch.model,
      );
    }

    // ── Stage 3: WRITE (short transaction) ───────────────────────────────────
    // The item's own row is deliberately NOT re-locked or re-read here. If it was
    // edited again while the vector was in flight, its own job is already queued
    // and will overwrite this row with the newer text — converging forward, which
    // is exactly what §6.3.3 buys by re-reading rather than carrying a payload.
    await withWorkspaceServiceContext(input.workspaceId, (tx) =>
      workItemEmbeddingRepository.upsert(
        {
          workItemId: input.workItemId,
          workspaceId: input.workspaceId,
          projectId: pending.projectId,
          model: batch.model,
          dimensions: vector.length,
          contentHash: pending.contentHash,
          embeddedAt: new Date(),
          embedding: vector,
        },
        tx,
      ),
    );

    return { embedded: true, model: batch.model };
  },

  /**
   * Embed every item in a project that has no vector, or whose text has moved on
   * since the one it has — the backfill for rows that predate the feature (ADR
   * §6.3.1), driven by `scripts/backfill-work-item-embeddings.ts`.
   *
   * Batched against motir-ai's 64-input endpoint so a project is a handful of
   * round-trips rather than one per row, and keyset-paged so it stays correct
   * while it writes. Each page is independent: an interrupted run re-runs
   * cleanly, because the hash comparison makes already-done rows free.
   *
   * NOT covered here, deliberately: re-embedding rows written under a DIFFERENT
   * model. ADR §6.1 already handles a model swap by EXCLUDING incomparable rows
   * from ranking, which makes the swap a visible, rolling gap rather than a
   * silent quality collapse — refilling it is an operational sweep with its own
   * cost profile, not part of "cover the rows that predate the feature".
   */
  async backfillProject(input: {
    workspaceId: string;
    projectId: string;
  }): Promise<BackfillResult> {
    if (!motirAiConfigured()) return { scanned: 0, embedded: 0, model: null };

    let afterId: string | null = null;
    let scanned = 0;
    let embedded = 0;
    let model: string | null = null;

    for (;;) {
      const page = await withWorkspaceServiceContext(input.workspaceId, (tx) =>
        workItemEmbeddingRepository.listForBackfill(
          { projectId: input.projectId, afterId, limit: BACKFILL_PAGE_SIZE },
          tx,
        ),
      );
      if (page.length === 0) break;
      scanned += page.length;
      afterId = page[page.length - 1]!.id;

      // Recompute each item's document + hash and keep only the rows whose
      // stored hash disagrees — which covers both "never embedded" (null) and
      // "the text has moved on since". This is the SAME comparison
      // `embedWorkItem` makes, so a backfill and a live edit can never disagree
      // about whether a row is current.
      const stale: Array<{ id: string; document: string; contentHash: string }> = [];
      for (const row of page) {
        const document = composeEmbeddingDocument({
          title: row.title,
          descriptionMd: row.descriptionMd,
        });
        const contentHash = hashEmbeddingDocument(document);
        if (row.contentHash !== contentHash) stale.push({ id: row.id, document, contentHash });
      }

      for (const group of chunk(stale, EMBEDDING_BATCH_MAX_INPUTS)) {
        const batch = await embedTexts(group.map((c) => c.document));
        model = batch.model;
        await withWorkspaceServiceContext(input.workspaceId, async (tx) => {
          for (const [index, candidate] of group.entries()) {
            const vector = batch.embeddings[index];
            if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
              throw new EmbeddingDimensionMismatchError(
                EMBEDDING_DIMENSIONS,
                vector?.length ?? 0,
                batch.model,
              );
            }
            await workItemEmbeddingRepository.upsert(
              {
                workItemId: candidate.id,
                workspaceId: input.workspaceId,
                projectId: input.projectId,
                model: batch.model,
                dimensions: vector.length,
                contentHash: candidate.contentHash,
                embeddedAt: new Date(),
                embedding: vector,
              },
              tx,
            );
          }
        });
        embedded += group.length;
      }

      if (page.length < BACKFILL_PAGE_SIZE) break;
    }

    return { scanned, embedded, model };
  },

  /**
   * Embed ONE query string — the READ-path counterpart of {@link embedWorkItem}'s
   * stage 2, and the only thing MOTIR-3101's MCP tool needed that did not exist
   * (`docs/decisions/plan-tree-embeddings.md` Amendment 2).
   *
   * It calls the SAME `embedTexts` seam the write path calls, which is the whole
   * point of Amendment 2's decision: the row and the query then physically cannot
   * be embedded under different models, and `model` is a HARD ranking filter, so a
   * mismatch would return an empty result indistinguishable from "nothing similar
   * exists". Nothing new is added to this repo — no credential, no gateway token,
   * no second metering identity.
   *
   * ⚠️ RETURNS `null` RATHER THAN THROWING when the query cannot be embedded — an
   * unconfigured deployment (no `MOTIR_AI_URL` / `MOTIR_AI_SERVICE_TOKEN`, i.e.
   * open-core with no AI backend) or an unreachable one. That is a VALUE for the
   * same reason the skip reasons above are: the caller must be able to report
   * "I could not search" as a distinct state from "I searched and found nothing",
   * and an exception at this seam would collapse the two into an error or an empty
   * list. A dimension mismatch is NOT in that class and still throws — it means
   * motir-ai answered with a vector this store cannot rank, which is a real defect
   * rather than an absent backend.
   */
  async embedQuery(query: string): Promise<{ embedding: number[]; model: string } | null> {
    if (!motirAiConfigured()) return null;
    let batch;
    try {
      batch = await embedTexts([query]);
    } catch {
      // Swallowed HERE and nowhere else: `embedTexts` throws a typed error on any
      // transport failure by design, leaving the decision to the layer that knows
      // what an absent answer means. For a background job that is "retry"; for an
      // interactive search it is "say so".
      return null;
    }
    const vector = batch.embeddings[0];
    if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingDimensionMismatchError(
        EMBEDDING_DIMENSIONS,
        vector?.length ?? 0,
        batch.model,
      );
    }
    return { embedding: vector, model: batch.model };
  },

  /**
   * Rank a project's items against a query vector — the storage half of ADR
   * §6.1, which MOTIR-2697's endpoint wraps in its guard, its validation and its
   * `key`/`title`/`score` DTO.
   *
   * ⚠️ THIS IS WHERE HNSW'S PRE-FILTER UNDER-RETURN IS ANSWERED. The approximate
   * index collects candidates BEFORE `project_id` and `model` narrow them, so a
   * small project inside a large table can come back short — dropping real
   * candidates, which is the same false "nothing matches" this story exists to
   * remove, just further down the stack. So:
   *
   *   1. widen `hnsw.ef_search` for the requested page (cheap, makes step 3 rare);
   *   2. read how many rows the project ACTUALLY has for this model — a number
   *      the caller needs anyway, as §6.1's `coverage.embedded`;
   *   3. if the approximate pass returned fewer than `min(limit, rankable)`,
   *      take the ordered-index path away from the planner and re-run the SAME
   *      query, which is then an exact scan.
   *
   * The guarantee is therefore total and version-independent — never fewer than
   * `min(limit, rankable)` rows, at any table size, on any pgvector build. See
   * `workItemEmbeddingRepository.disableOrderedIndexScan` for why that rather
   * than `hnsw.iterative_scan`.
   *
   * All three steps share ONE transaction: `SET LOCAL` is scoped to it (so
   * neither GUC can leak onto the next borrower of the pooled connection), and
   * the workspace GUC it binds is what makes the rows visible at all.
   */

  async rankSimilar(input: RankSimilarInput): Promise<RankSimilarResult> {
    return withWorkspaceServiceContext(input.workspaceId, async (tx) => {
      await workItemEmbeddingRepository.setEfSearch(efSearchForLimit(input.limit), tx);

      const rankable = await workItemEmbeddingRepository.countRankable(
        input.projectId,
        input.model,
        tx,
      );
      // ADR §6.1's `coverage.total`. Read HERE, inside the same transaction, so
      // the caller cannot assemble the ratio from two snapshots — see
      // `workItemRepository.countLiveByProject` for why this particular count and
      // not one of the triage-excluding ones beside it.
      const total = await workItemRepository.countLiveByProject(
        input.projectId,
        input.workspaceId,
        tx,
      );
      const query = {
        projectId: input.projectId,
        model: input.model,
        queryEmbedding: input.queryEmbedding,
        limit: input.limit,
      };
      const approximate = await workItemEmbeddingRepository.rankByEmbedding(query, tx);
      if (approximate.length >= Math.min(input.limit, rankable)) {
        return { results: approximate, rankable, total, exactFallbackUsed: false };
      }

      await workItemEmbeddingRepository.disableOrderedIndexScan(tx);
      const exact = await workItemEmbeddingRepository.rankByEmbedding(query, tx);
      return { results: exact, rankable, total, exactFallbackUsed: true };
    });
  },
};
