import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  PLATFORM_AUDIT_ACTIONS,
  isPlatformAuditAction,
  reasonPolicyFor,
  reasonSatisfied,
} from '@/lib/platform/auditActions';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { MissingAuditReasonError } from '@/lib/platform/errors';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import { assertReasonSatisfied, platformAuditService } from '@/lib/services/platformAuditService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { isAppRoleTestMode } from '../helpers/parallelDb';
import { truncateAuthTables } from '../helpers/db';

// `PlatformAuditLog` — the record, its write path, and the two properties that
// make it worth having (MOTIR-2896 · `docs/decisions/platform-staff-auth.md` §3).
//
// The ADR's load-bearing claim about this table is STRUCTURAL rather than
// procedural: *"a read that rolls back leaves no audit row, and a read that
// commits cannot exist without one."* That is a claim about a transaction, so
// it is tested by rolling one back — not by reading `withPlatformRead` and
// agreeing with it.

async function seedStaff(role: 'support' | 'operator' | 'superadmin' = 'support') {
  const user = await createTestUser({ email: `ops+${role}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the write path', () => {
  it('persists actor, actor role, action, target and timestamp', async () => {
    const principal = await seedStaff('operator');
    const owner = await createTestUser({ email: 'owner@example.com' });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const organizationId = workspace.organizationId;

    const before = new Date();
    await platformAuditService.record(principal, {
      action: 'estate.read',
      targetKind: 'organization',
      targetId: organizationId,
      targetLabel: 'Acme',
      organizationId,
    });
    const after = new Date();

    const rows = await adminDb.platformAuditLog.findMany();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actorUserId).toBe(principal.userId);
    expect(row.actorRole).toBe('operator');
    expect(row.action).toBe('estate.read');
    expect(row.targetKind).toBe('organization');
    expect(row.targetId).toBe(organizationId);
    expect(row.targetLabel).toBe('Acme');
    expect(row.organizationId).toBe(organizationId);
    expect(row.reason).toBeNull();
    expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row.createdAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  it('snapshots the role AT THE TIME — a later revoke does not rewrite history', async () => {
    const principal = await seedStaff('superadmin');
    await platformAuditService.record(principal, {
      action: 'console.open',
      targetKind: 'platform',
    });

    await adminDb.user.update({ where: { id: principal.userId }, data: { platformRole: null } });

    const row = await adminDb.platformAuditLog.findFirstOrThrow();
    expect(row.actorRole).toBe('superadmin');
  });

  it('writes the audit row BEFORE the work, in the same transaction', async () => {
    // The ADR's structural claim, both directions. The work throws, so the
    // transaction rolls back, so the audit row that was already INSERTed goes
    // with it — auditing is the price of the transaction, not a step beside it.
    const principal = await seedStaff();

    await expect(
      withPlatformRead(principal, { action: 'estate.read', targetKind: 'platform' }, async () => {
        throw new Error('the read failed');
      }),
    ).rejects.toThrow('the read failed');

    expect(await adminDb.platformAuditLog.count()).toBe(0);

    // And the commit direction: the row is there, and it was visible to the
    // work itself, which is what "first statement inside" means.
    const seenInside = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'platform' },
      (tx) => platformAuditLogRepository.listByActor(principal.userId, 10, tx),
    );
    expect(seenInside).toHaveLength(1);
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('reads back through the DTO, with an ISO timestamp', async () => {
    const principal = await seedStaff();
    await platformAuditService.record(principal, {
      action: 'console.open',
      targetKind: 'platform',
    });

    const rows = await platformAuditService.listByActor(principal, principal.userId);
    // Two: the recorded `console.open`, plus the `estate.read` that reading the
    // log is itself audited as. Reading the audit trail is a platform read.
    expect(rows.map((r) => r.action)).toContain('console.open');
    expect(rows[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(rows[0]!.actorRole).toBe('support');
  });
});

describe('append-only, as an application property', () => {
  it('the repository exposes create and reads and NO mutator', () => {
    // The database policy is `FOR ALL` because the four-verb totality guard
    // requires every verb to be covered — so what makes this table append-only
    // is exactly this surface. A future `update` / `delete` added here fails the
    // assertion rather than passing review.
    expect(Object.keys(platformAuditLogRepository).sort()).toEqual([
      'create',
      'listByActor',
      'listByOrganization',
    ]);
  });
});

describe('the reason rule', () => {
  it('every seeded action is a READ, so none requires a reason', () => {
    for (const action of Object.keys(PLATFORM_AUDIT_ACTIONS)) {
      expect(reasonPolicyFor(action as keyof typeof PLATFORM_AUDIT_ACTIONS)).toBe('never');
    }
  });

  it('holds in both arms, including the one no action carries yet', () => {
    // MOTIR-1167 adds the first two `required` actions (send password reset,
    // suspend an account). The rule ships now, with the mechanism it guards, so
    // that card inherits a tested check instead of writing the first one.
    expect(reasonSatisfied('never', null)).toBe(true);
    expect(reasonSatisfied('never', 'anything')).toBe(true);
    expect(reasonSatisfied('required', 'customer asked us to')).toBe(true);
    expect(reasonSatisfied('required', null)).toBe(false);
    expect(reasonSatisfied('required', undefined)).toBe(false);
    expect(reasonSatisfied('required', '')).toBe(false);
    // A space is not a reason. The design puts it behind a confirm dialog
    // precisely so somebody has to type one.
    expect(reasonSatisfied('required', '   ')).toBe(false);
  });

  it('a read passes the service check with no reason', () => {
    expect(() =>
      assertReasonSatisfied({ action: 'console.open', targetKind: 'platform' }),
    ).not.toThrow();
  });

  it('MissingAuditReasonError names the action it refused', () => {
    const err = new MissingAuditReasonError('account.suspend');
    expect(err.code).toBe('MISSING_AUDIT_REASON');
    expect(err.action).toBe('account.suspend');
    expect(err.message).toContain('account.suspend');
  });

  it('the vocabulary guard narrows a value read back out of the String column', () => {
    expect(isPlatformAuditAction('console.open')).toBe(true);
    expect(isPlatformAuditAction('account.suspend')).toBe(false);
    // Not a prototype probe: `Object.hasOwn`, not `in`.
    expect(isPlatformAuditAction('toString')).toBe(false);
  });
});

describe('row-level security', () => {
  it('ships ENABLE + FORCE and ONE policy covering all four verbs', async () => {
    const [table] = await adminDb.$queryRawUnsafe<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'platform_audit_log'`,
    );
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policies = await adminDb.$queryRawUnsafe<{ policyname: string; cmd: string }[]>(
      `SELECT policyname, cmd FROM pg_policies WHERE tablename = 'platform_audit_log'`,
    );
    expect(policies).toEqual([{ policyname: 'platform_audit_log_platform_only', cmd: 'ALL' }]);
  });

  it('has NO tenant arm — no workspace, org or user GUC appears in the predicate', async () => {
    // The whole point of the table: a tenant request cannot read the operator
    // audit trail even by accident, and no `app.system_admin` arm hands it to
    // the job runtime either (ADR §3's three reasons).
    const [policy] = await adminDb.$queryRawUnsafe<{ qual: string; with_check: string }[]>(
      `SELECT qual, with_check FROM pg_policies WHERE tablename = 'platform_audit_log'`,
    );
    for (const clause of [policy!.qual, policy!.with_check]) {
      expect(clause).toContain('app.platform_staff');
      expect(clause).not.toContain('app.workspace_id');
      expect(clause).not.toContain('app.organization_id');
      expect(clause).not.toContain('app.project_id');
      expect(clause).not.toContain('app.system_admin');
    }
  });

  it.runIf(isAppRoleTestMode())('refuses an UNBOUND reader under the non-bypass role', async () => {
    const principal = await seedStaff();
    await platformAuditService.record(principal, {
      action: 'console.open',
      targetKind: 'platform',
    });
    expect(await adminDb.platformAuditLog.count()).toBe(1);

    // `db` is the application client. Outside a platform context the GUC is
    // unset, the predicate is false, and the row is invisible — zero rows, no
    // error, which is why the repository requires `tx` rather than allowing the
    // singleton (`CLAUDE.md`'s read-method rule is deliberately tightened there).
    expect(await db.platformAuditLog.count()).toBe(0);
  });
});
