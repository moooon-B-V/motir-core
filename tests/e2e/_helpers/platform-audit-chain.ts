import type {
  PlatformAuditLog,
  PlatformAuditTargetKind,
  PlatformRole,
} from '@/generated/prisma/client';
import {
  computeAuditEntryHash,
  findFirstChainBreak,
  normaliseAuditMetadata,
  type AuditChainBreak,
} from '@/lib/platform/auditChain';
import { adminDb } from './db-reset';

/**
 * Seed ONE `platform_audit_log` row as a valid next link of the hash chain
 * (MOTIR-9392).
 *
 * For an action the typed recorder (`platformAuditService.record`) can no longer
 * take — one that left `PLATFORM_AUDIT_ACTIONS`, such as the removed
 * `enterprise_request.transition`. A raw insert with a made-up hash would make the
 * audit-log page report a broken chain, a state production cannot reach. So this
 * does what the append path in `withPlatformRead` does: in one transaction, take
 * the chain lock, read the head, and write `seq = head + 1`, `prevHash =
 * head.entryHash` and the entry's own hash over exactly what is stored.
 */
export interface StaleAuditEntry {
  actorUserId: string;
  actorRole: PlatformRole;
  action: string;
  targetKind: PlatformAuditTargetKind;
  targetId: string | null;
  targetLabel: string | null;
  organizationId: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
}

export async function appendAuditChainLink(entry: StaleAuditEntry): Promise<PlatformAuditLog> {
  return adminDb.$transaction(async (tx) => {
    // The same lock key as `platformAuditLogRepository.lockChainHead`.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('platform-audit-chain', 0))`;
    const head = await tx.platformAuditLog.findFirst({
      orderBy: { seq: 'desc' },
      select: { seq: true, entryHash: true },
    });
    const metadata = normaliseAuditMetadata(entry.metadata);
    const fields = {
      ...entry,
      metadata,
      seq: (head?.seq ?? 0) + 1,
      createdAt: new Date(),
      prevHash: head?.entryHash ?? null,
    };
    return tx.platformAuditLog.create({
      data: {
        ...fields,
        metadata: metadata ?? undefined,
        entryHash: computeAuditEntryHash(fields),
      },
    });
  });
}

/** The first break in the whole stored chain, or `null` when every entry verifies. */
export async function firstAuditChainBreak(): Promise<AuditChainBreak | null> {
  const rows = await adminDb.platformAuditLog.findMany({ orderBy: { seq: 'asc' } });
  return findFirstChainBreak(rows, 'genesis');
}
