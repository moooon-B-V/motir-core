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
      // MOTIR-1167's target read — Panel 9's "Support actions" log. A READ, so
      // it belongs on this list rather than falsifying it. The assertion is
      // pinned TIGHT on purpose: a consumer adding a read extends it and says
      // so, which is the moment a `deleteMany` slipped in beside one would have
      // to be argued for rather than merged.
      'listByTarget',
    ]);
  });
});

describe('the reason rule', () => {
  // ⚠️ THE POLICY PER ACTION IS THE ADR'S §7 ALLOCATION TABLE, ASSERTED AS A MAP.
  //
  // This case used to read *"every seeded action is a READ, so none requires a
  // reason"* — true of MOTIR-2896's build, and it stopped being true the moment
  // MOTIR-1167 added the day-1 writes, exactly as the sibling case below
  // predicted it would. A loop asserting one value over every member cannot say
  // anything once the members differ, so it is replaced by the allocation
  // itself: each action, its required degree of accountability, named. A new
  // verb added without a decided policy fails the exhaustiveness check below
  // rather than defaulting into whichever arm the loop happened to assert.
  const EXPECTED_POLICY = {
    'console.open': 'never',
    'estate.read': 'never',
    'health.read': 'never',
    'user.read': 'never',
    'user.password_reset_sent': 'required',
    'user.suspend': 'required',
    'user.unsuspend': 'required',
    // MOTIR-4565's org classification — the first members from outside Epic 10
    // and Story 8.5, and the first at the `superadmin` degree. Both `required`:
    // they change what an organization is BILLED, and ADR §7's table puts every
    // billing-affecting write there with a reason. The unset carries one for the
    // reason `user.unsuspend` does — the trail has to answer "why is this org
    // being billed again?" as readably as it answers why it stopped.
    'org.internal_billing_set': 'required',
    'org.internal_billing_unset': 'required',
  } as const;

  it('every action carries the policy the ADR allocates it', () => {
    for (const action of Object.keys(PLATFORM_AUDIT_ACTIONS)) {
      const key = action as keyof typeof PLATFORM_AUDIT_ACTIONS;
      expect(EXPECTED_POLICY[key], `${action} has no decided reason policy`).toBeDefined();
      expect(reasonPolicyFor(key), action).toBe(EXPECTED_POLICY[key]);
    }
    // Both directions: an action retired from the vocabulary must not linger
    // here claiming to be governed.
    expect(Object.keys(PLATFORM_AUDIT_ACTIONS).sort()).toEqual(Object.keys(EXPECTED_POLICY).sort());
  });

  it('every READ is reason-free and every WRITE demands one', () => {
    // The property underneath the table above, stated so it survives the table
    // growing: the ADR's rule is *"REQUIRED for every write action, NULL for a
    // read"*, and `<domain>.<verb>` names the verb. Reads are the closed set;
    // anything else is a write.
    const READS = ['console.open', 'estate.read', 'health.read', 'user.read'];
    for (const action of Object.keys(PLATFORM_AUDIT_ACTIONS)) {
      const key = action as keyof typeof PLATFORM_AUDIT_ACTIONS;
      expect(reasonPolicyFor(key), action).toBe(READS.includes(action) ? 'never' : 'required');
    }
  });

  it('holds in both arms', () => {
    // Written by MOTIR-2896 when NO action carried `required`, so that the
    // rule's load-bearing half did not ship unexecuted. MOTIR-1167's three
    // writes are now the first callers to take that arm through the action
    // lookup, and the case stays as the direct test of the pure function.
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

  // Unconditional since MOTIR-2734 retired `TEST_DB_APP_ROLE`: `@/lib/db` is
  // always `motir_app`, so this is the only arm there is.
  it('refuses an UNBOUND reader under the non-bypass role', async () => {
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
