import 'server-only';

import { type Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
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

/**
 * Open an audited platform transaction, bind `app.platform_staff`, append the
 * audit row, and run `fn`.
 *
 * The statement ORDER is the contract: `set_config` first (so the INSERT itself
 * passes the table's own policy — the audit row is subject to the gate it
 * records), the audit row second, the caller's work last.
 */
export async function withPlatformRead<T>(
  principal: PlatformPrincipal,
  entry: PlatformAuditEntry,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_staff', 'true', true)`;
    await tx.$executeRaw`SELECT set_config('app.user_id', ${principal.userId}, true)`;

    await platformAuditLogRepository.create(
      {
        actor: { connect: { id: principal.userId } },
        actorRole: principal.role,
        action: entry.action,
        targetKind: entry.targetKind,
        targetId: entry.targetId ?? null,
        targetLabel: entry.targetLabel ?? null,
        organizationId: entry.organizationId ?? null,
        reason: entry.reason ?? null,
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      },
      tx,
    );

    return fn(tx);
  });
}
