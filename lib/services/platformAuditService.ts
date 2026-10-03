import 'server-only';

import {
  type PlatformAuditChainVerificationDTO,
  type PlatformAuditLogDTO,
  type PlatformAuditSearchFiltersDTO,
  type PlatformAuditSearchPageDTO,
} from '@/lib/dto/platform';
import { toPlatformAuditEntryDTO, toPlatformAuditLogDTO } from '@/lib/mappers/platformMappers';
import { findFirstChainBreak, type AuditChainCursor } from '@/lib/platform/auditChain';
import {
  PLATFORM_AUDIT_READ_ACTIONS,
  reasonPolicyFor,
  reasonSatisfied,
} from '@/lib/platform/auditActions';
import { requirePlatformStaff, type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead, type PlatformAuditEntry } from '@/lib/platform/context';
import { MissingAuditReasonError, PlatformAuditQueryInvalidError } from '@/lib/platform/errors';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';

/** The audit log's page size — the design's "keyset-paged 50 a page". */
export const AUDIT_LOG_PAGE_SIZE = 50;

/** How many rows the verifier hashes per keyset batch. */
const VERIFY_BATCH_SIZE = 1000;

/**
 * The verifier's transaction budget. It walks the whole chain inside ONE
 * audited transaction (one `audit.verify` row per check, not one per batch),
 * which at the design's 48k entries is well under a second of fetching and
 * hashing — but the default 5 s interactive-transaction timeout is not a
 * number to bet a growing table against.
 */
const VERIFY_TIMEOUT_MS = 60_000;

/**
 * The platform audit trail's business layer — `docs/decisions/platform-staff-auth.md` §3b.
 *
 * Thin by design. The audit APPEND is not a service-orchestrated write with a
 * transaction of its own: it is the first statement inside every platform
 * transaction, issued by `withPlatformRead`, and this service exists for the
 * one rule the ADR explicitly located above the column — *"REQUIRED for every
 * write action, NULL for a read. Enforced in the service, not by the column,
 * because reads legitimately have none."*
 *
 * MOTIR-2896 shipped the write path and the per-actor read. MOTIR-751 adds
 * the audit log's own surface — `searchEntries` and `verifyChain`, both
 * `superadmin` (ADR §7's "audit-log VIEW" row) and both themselves audited
 * (`audit.read` / `audit.verify`). The page that renders them is MOTIR-752.
 *
 * The chain they verify is written by `withPlatformRead`, not here: every
 * platform transaction's first write is a hash-chained append, so every caller
 * of `record` — and every 10.3 write that passes its entry to
 * `withPlatformRead` — is chained without doing anything.
 */
export const platformAuditService = {
  /**
   * Record one platform action, with nothing else inside the transaction.
   *
   * The shape a caller uses when the audited thing is the ACTION ITSELF — the
   * console being opened. A caller that audits a READ passes the same entry to
   * `withPlatformRead` and does its reading inside, so the row and the read
   * share one transaction and one fate.
   *
   * @throws MissingAuditReasonError when the action's reason policy is
   *   `required` and no non-blank reason was supplied.
   */
  async record(principal: PlatformPrincipal, entry: PlatformAuditEntry): Promise<void> {
    assertReasonSatisfied(entry);
    await withPlatformRead(principal, entry, async () => undefined);
  },

  /** The most recent actions by one operator, newest first. */
  async listByActor(
    principal: PlatformPrincipal,
    actorUserId: string,
    limit = 50,
  ): Promise<PlatformAuditLogDTO[]> {
    const rows = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'user', targetId: actorUserId },
      (tx) => platformAuditLogRepository.listByActor(actorUserId, limit, tx),
    );
    return rows.map(toPlatformAuditLogDTO);
  },

  /**
   * One page of the audit log, newest first (design Panel 6's table).
   *
   * Keyset-paged on `seq` — `cursor` is the `nextCursor` of the previous page —
   * so page N costs what page 1 costs and nothing ever loads the table. The
   * default view is WRITES (`writesOnly` omitted or true); `false` is "Writes &
   * reads". The search is itself an audited read: one `audit.read` row, its
   * filters in `metadata`, scoped to the tenant when the search names one.
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws PlatformAuditQueryInvalidError for a cursor this service did not
   *   hand out, an unparseable date, or a range that ends before it starts.
   */
  async searchEntries(
    principal: PlatformPrincipal,
    filters: PlatformAuditSearchFiltersDTO = {},
    cursor: string | null = null,
  ): Promise<PlatformAuditSearchPageDTO> {
    await requirePlatformStaff('superadmin');

    const beforeSeq = parseCursor(cursor);
    const createdFrom = parseDate(filters.dateFrom, 'dateFrom');
    const createdTo = parseDate(filters.dateTo, 'dateTo');
    if (createdFrom && createdTo && createdTo <= createdFrom) {
      throw new PlatformAuditQueryInvalidError('dateTo');
    }
    const writesOnly = filters.writesOnly !== false;
    const organizationId = filters.organizationId?.trim() || null;
    const text = filters.text?.trim() || null;

    const rows = await withPlatformRead(
      principal,
      {
        action: 'audit.read',
        targetKind: organizationId ? 'organization' : 'platform',
        targetId: organizationId,
        organizationId,
        metadata: {
          actorUserId: filters.actorUserId ?? null,
          organizationId,
          action: filters.action ?? null,
          dateFrom: createdFrom?.toISOString() ?? null,
          dateTo: createdTo?.toISOString() ?? null,
          writesOnly,
          text,
          cursor: beforeSeq,
        },
      },
      (tx) =>
        platformAuditLogRepository.search(
          {
            actorUserId: filters.actorUserId?.trim() || null,
            organizationId,
            action: filters.action?.trim() || null,
            excludeActions: writesOnly ? PLATFORM_AUDIT_READ_ACTIONS : null,
            createdFrom,
            createdTo,
            text,
          },
          beforeSeq,
          AUDIT_LOG_PAGE_SIZE + 1,
          tx,
        ),
    );

    const page = rows.slice(0, AUDIT_LOG_PAGE_SIZE);
    const reads = new Set<string>(PLATFORM_AUDIT_READ_ACTIONS);
    return {
      entries: page.map((row) => toPlatformAuditEntryDTO(row, !reads.has(row.action))),
      nextCursor: rows.length > AUDIT_LOG_PAGE_SIZE ? String(page[page.length - 1]!.seq) : null,
      pageSize: AUDIT_LOG_PAGE_SIZE,
    };
  },

  /**
   * Recompute the hash chain and report the FIRST entry where it breaks, or OK
   * (design Panels 6/7 — "Chain verified" / "The chain is broken at entry #n").
   *
   * Walks `[fromSeq, toSeq]` (default: the whole chain, through the head as it
   * stands — including this check's own `audit.verify` row, which is appended
   * first like every platform read's) in keyset batches, recomputing each
   * entry's hash and checking its link and its `seq` against the entry before.
   * A range that starts after #1 is anchored on the STORED hash of the entry
   * before it, so it proves the range is intact and attached to what precedes
   * it — not that what precedes it is intact; only a full check (no `fromSeq`)
   * proves the whole log. It changes nothing either way.
   *
   * Once broken, everything after the break is reported as untrusted
   * (`entriesAfter`), never re-verified against the broken entry: a chain that
   * is wrong at #n vouches for nothing after it.
   *
   * ⚠️ It runs in one platform transaction, so for its duration it holds the
   * chain lock and other staff actions wait (`withPlatformRead`'s note).
   *
   * @throws NotPlatformStaffError below `superadmin`.
   * @throws PlatformAuditQueryInvalidError for a non-positive or reversed range.
   */
  async verifyChain(
    principal: PlatformPrincipal,
    range: { fromSeq?: number | null; toSeq?: number | null } = {},
  ): Promise<PlatformAuditChainVerificationDTO> {
    await requirePlatformStaff('superadmin');

    const fromSeq = range.fromSeq ?? 1;
    const toSeq = range.toSeq ?? null;
    if (!Number.isInteger(fromSeq) || fromSeq < 1) {
      throw new PlatformAuditQueryInvalidError('fromSeq');
    }
    if (toSeq !== null && (!Number.isInteger(toSeq) || toSeq < fromSeq)) {
      throw new PlatformAuditQueryInvalidError('toSeq');
    }

    return withPlatformRead(
      principal,
      {
        action: 'audit.verify',
        targetKind: 'platform',
        metadata: { fromSeq, toSeq },
      },
      async (tx) => {
        const checkedAt = new Date().toISOString();

        let cursor: AuditChainCursor = 'genesis';
        // No entry just before the range: whatever the range starts with is
        // chained to something that is not there — a deleted entry, reported as
        // a gap at the range's first entry.
        let anchorMissing = false;
        if (fromSeq > 1) {
          const anchor = await platformAuditLogRepository.findBySeq(fromSeq - 1, tx);
          if (anchor) cursor = { seq: anchor.seq, entryHash: anchor.entryHash };
          else anchorMissing = true;
        }

        let afterSeq = fromSeq - 1;
        let checkedCount = 0;
        let lastSeq: number | null = null;
        for (;;) {
          const batch = await platformAuditLogRepository.listChainBatch(
            afterSeq,
            toSeq,
            VERIFY_BATCH_SIZE,
            tx,
          );
          if (batch.length === 0) break;

          const broken =
            anchorMissing && checkedCount === 0
              ? { seq: batch[0]!.seq, createdAt: batch[0]!.createdAt, reason: 'seq_gap' as const }
              : findFirstChainBreak(batch, cursor);
          if (broken) {
            const entriesAfter = await platformAuditLogRepository.countAfterSeq(
              broken.seq,
              toSeq,
              tx,
            );
            const verifiedInBatch = batch.findIndex((r) => r.seq === broken.seq);
            return {
              status: 'broken',
              fromSeq,
              // The end of the range considered: the requested end, or the head.
              throughSeq: toSeq ?? broken.seq + entriesAfter,
              checkedCount: checkedCount + Math.max(0, verifiedInBatch),
              checkedAt,
              brokenAtSeq: broken.seq,
              brokenAtTime: broken.createdAt.toISOString(),
              reason: broken.reason,
              entriesAfter,
            };
          }

          checkedCount += batch.length;
          const last = batch[batch.length - 1]!;
          lastSeq = last.seq;
          cursor = { seq: last.seq, entryHash: last.entryHash };
          afterSeq = last.seq;
          if (batch.length < VERIFY_BATCH_SIZE) break;
        }

        return { status: 'ok', fromSeq, throughSeq: lastSeq, checkedCount, checkedAt };
      },
      { timeoutMs: VERIFY_TIMEOUT_MS },
    );
  },
};

/** A cursor is the decimal `seq` of the previous page's last entry. */
function parseCursor(cursor: string | null): number | null {
  if (cursor === null || cursor === '') return null;
  if (!/^[1-9]\d{0,9}$/.test(cursor)) throw new PlatformAuditQueryInvalidError('cursor');
  return Number(cursor);
}

function parseDate(value: string | null | undefined, field: string): Date | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new PlatformAuditQueryInvalidError(field);
  return date;
}

/**
 * The reason rule, applied to one entry. Composes the pure `reasonSatisfied`
 * (which is where both arms are tested — no action in this build is `required`)
 * with the action's own policy.
 */
export function assertReasonSatisfied(entry: PlatformAuditEntry): void {
  if (!reasonSatisfied(reasonPolicyFor(entry.action), entry.reason)) {
    throw new MissingAuditReasonError(entry.action);
  }
}
