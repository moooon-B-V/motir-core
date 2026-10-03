import 'server-only';

import { type Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import { computeAuditEntryHash, normaliseAuditMetadata } from './auditChain';
import { type PlatformAuditAction } from './auditActions';
import { type PlatformPrincipal } from './auth';
import { type PlatformAuditTargetKind } from '@/generated/prisma/client';

/**
 * The platform context — `docs/decisions/platform-staff-auth.md` §3a, the ADR's
 * own load-bearing paragraph:
 *
 * > There is no way to open a platform context without naming, up front, what
 * > is about to be read. The audit row is INSERTed as the first statement
 * > inside the same transaction as the read. A read that rolls back leaves no
 * > audit row, and a read that commits cannot exist without one. Auditing is
 * > therefore not a step a caller can forget — it is the price of the
 * > transaction.
 *
 * That is why `entry` is a required parameter and not an options bag, and why
 * there is no `withPlatformReadUnaudited` sibling. If you find yourself wanting
 * one, the thing you want is a tenant-scoped context (`withWorkspaceContext`),
 * not this.
 *
 * ⚠️ `app.platform_staff`, NOT `app.system_admin`. The ADR argues it in full;
 * the decisive half is that `withSystemContext` is what the job ledger, the
 * webhook paths and the meters already bind, so arming a tenant table for
 * `system_admin` on the console's behalf would silently widen the JOB
 * RUNTIME's reach over that table. A separate GUC keeps the console's arms
 * visible to the console and to nothing else.
 *
 * ⚠️ It binds NO TENANT GUC. `app.workspace_id` / `app.project_id` are
 * deliberately left unbound — binding one would NARROW the very read this
 * context exists to widen. `app.user_id` is bound because the audit INSERT and
 * any user-keyed policy need an actor, not because it scopes anything.
 *
 * WHAT THIS CARD SHIPS AND WHAT IT DOES NOT. MOTIR-2896 ships the mechanism and
 * the audit write it performs. It ships NO cross-tenant READ: no
 * `platform*Repository` reading a tenant table exists yet, and no tenant
 * table has gained a `platform_staff` policy arm. Which tables get one, and
 * each policy's SQL, is MOTIR-730 (10.1.3) — named in the ADR's own
 * "deliberately does NOT decide" table. Until those arms land, a tenant read
 * inside this context returns zero rows, which is the correct behaviour for a
 * card whose acceptance criteria forbid a cross-tenant read.
 */

/** What a platform context is about to do — the audit row, named up front. */
export interface PlatformAuditEntry {
  action: PlatformAuditAction;
  targetKind: PlatformAuditTargetKind;
  /** The target's id, or `null` for an estate-wide action (`targetKind: 'platform'`). */
  targetId?: string | null;
  /**
   * A human-readable name for the target, snapshotted. The record must stay
   * readable after the tenant it describes is deleted — which is also why
   * `targetId` carries no FK (see the model's own comment).
   */
  targetLabel?: string | null;
  /** The org the action touched, when one is resolvable — the read index's key. */
  organizationId?: string | null;
  /**
   * REQUIRED for a write action, absent for a read. Enforced here rather than
   * by the column, because reads legitimately have none (ADR §3b). The ADR's §7
   * table says which actions require one.
   */
  reason?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/** Options for one platform transaction. */
export interface PlatformTransactionOptions {
  /**
   * The interactive-transaction timeout, in ms (Prisma's default is 5 000). Only
   * a caller that legitimately reads a LOT inside one audited transaction — the
   * chain verifier — raises it; see the chain-lock note below for what a long
   * platform transaction costs everyone else.
   */
  timeoutMs?: number;
}

/**
 * Open an audited platform transaction, bind `app.platform_staff`, append the
 * audit row, and run `fn`.
 *
 * The statement ORDER is the contract: `set_config` first (so the INSERT itself
 * passes the table's own policy — the audit row is subject to the gate it
 * records), the audit row second, the caller's work last.
 *
 * ⚠️ THE AUDIT ROW IS A LINK IN A HASH CHAIN (MOTIR-751). The append takes the
 * chain lock, reads the head, and writes `seq = head.seq + 1`,
 * `prevHash = head.entryHash` and `entryHash` over the row's canonical form
 * (`lib/platform/auditChain.ts`). The lock is transaction-scoped, so it is held
 * until this transaction COMMITS — which is what stops two concurrent appends
 * forking the chain, and also means PLATFORM TRANSACTIONS SERIALIZE: a staff
 * action that is slow inside `fn` (a remote call, a long read) holds every other
 * staff action at the door until it finishes. Keep `fn` short; it always was the
 * rule for a transaction, and the chain makes it visible. The lock is taken
 * BEFORE anything `fn` locks, in every platform transaction, so the order is
 * the same everywhere and two of them cannot deadlock on each other.
 *
 * ⚠️ So `fn` must never open a SECOND platform context (`withPlatformRead`,
 * `platformAuditService.record`) — that one would wait on the lock this one
 * holds, on another connection, forever. Nothing in the tree does; a caller
 * that wants two audit rows makes two sequential calls.
 */
export async function withPlatformRead<T>(
  principal: PlatformPrincipal,
  entry: PlatformAuditEntry,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  options: PlatformTransactionOptions = {},
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_staff', 'true', true)`;
      await tx.$executeRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;

      await appendChainedEntry(principal, entry, tx);

      return fn(tx);
    },
    options.timeoutMs === undefined ? undefined : { timeout: options.timeoutMs },
  );
}

/**
 * The append itself: lock the head, chain to it, insert. Inside the caller's
 * transaction, after `app.platform_staff` is bound (the head read is subject to
 * the table's policy like any other read).
 */
async function appendChainedEntry(
  principal: PlatformPrincipal,
  entry: PlatformAuditEntry,
  tx: Prisma.TransactionClient,
): Promise<void> {
  await platformAuditLogRepository.lockChainHead(tx);
  const head = await platformAuditLogRepository.findChainHead(tx);

  const fields = {
    seq: head ? head.seq + 1 : 1,
    // Set here, not left to the column default: the hash must cover exactly the
    // value stored, and TIMESTAMP(3) stores a JavaScript Date to the millisecond.
    createdAt: new Date(),
    actorUserId: principal.userId,
    actorRole: principal.role,
    action: entry.action,
    targetKind: entry.targetKind,
    targetId: entry.targetId ?? null,
    targetLabel: entry.targetLabel ?? null,
    organizationId: entry.organizationId ?? null,
    reason: entry.reason ?? null,
    metadata: normaliseAuditMetadata(entry.metadata),
    prevHash: head?.entryHash ?? null,
  };

  await platformAuditLogRepository.create(
    {
      seq: fields.seq,
      prevHash: fields.prevHash,
      entryHash: computeAuditEntryHash(fields),
      createdAt: fields.createdAt,
      actor: { connect: { id: principal.userId } },
      actorRole: principal.role,
      action: fields.action,
      targetKind: fields.targetKind,
      targetId: fields.targetId,
      targetLabel: fields.targetLabel,
      organizationId: fields.organizationId,
      reason: fields.reason,
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
    },
    tx,
  );
}
