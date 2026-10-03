import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  auditEntryChainStatus,
  canonicalJson,
  computeAuditEntryHash,
  findFirstChainBreak,
  type AuditChainFields,
} from '@/lib/platform/auditChain';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead } from '@/lib/platform/context';
import { NotPlatformStaffError, PlatformAuditQueryInvalidError } from '@/lib/platform/errors';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';
import { AUDIT_LOG_PAGE_SIZE, platformAuditService } from '@/lib/services/platformAuditService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The platform audit log's HASH CHAIN, its verifier and its search (MOTIR-751).
//
// The card's load-bearing claim is that the log is tamper-EVIDENT, not merely
// append-only: a row changed directly in the database must make `verifyChain`
// fail AT that row and vouch for nothing after it. That is a claim about rows
// the application did not write, so it is tested by writing them — raw SQL on
// the owner client, the way an operator with a psql session would.

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The one mock `CLAUDE.md` allows, at the platform tier's `getSession`
    // equivalent (no cookies in the test environment). The stub re-runs the
    // ladder comparison the real gate makes, so a refusal below is the
    // service's own `requirePlatformStaff('superadmin')`, not the mock's.
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

let currentPrincipal: PlatformPrincipal | null = null;

async function seedStaff(role: 'support' | 'operator' | 'superadmin', tag: string = role) {
  const user = await createTestUser({ email: `ops+chain-${tag}@moooon.net`, name: `Op ${tag}` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

async function chainRows() {
  return adminDb.platformAuditLog.findMany({ orderBy: { seq: 'asc' } });
}

async function recordWrites(principal: PlatformPrincipal, n: number, orgId = 'org_a') {
  for (let i = 0; i < n; i++) {
    await platformAuditService.record(principal, {
      action: 'user.suspend',
      targetKind: 'user',
      targetId: `user_${i}`,
      targetLabel: `Person ${i}`,
      organizationId: orgId,
      reason: `ticket #${i}`,
    });
  }
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  currentPrincipal = await seedStaff('superadmin');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the canonical form', () => {
  const base: AuditChainFields = {
    seq: 7,
    createdAt: new Date('2026-10-03T09:14:02.123Z'),
    actorUserId: 'user_1',
    actorRole: 'superadmin',
    action: 'ai.planner_model.set',
    targetKind: 'platform',
    targetId: 'customer',
    targetLabel: null,
    organizationId: null,
    reason: 'ticket 42',
    metadata: { toModel: 'b', audience: 'customer', fromModel: null },
    prevHash: 'a'.repeat(64),
  };

  it('sorts object keys, so key ORDER (which jsonb does not keep) cannot change a hash', () => {
    expect(canonicalJson({ b: 1, a: [true, null, { d: 'x', c: 2.5 }] })).toBe(
      '{"a":[true,null,{"c":2.5,"d":"x"}],"b":1}',
    );
    const reordered = {
      ...base,
      metadata: { fromModel: null, audience: 'customer', toModel: 'b' },
    };
    expect(computeAuditEntryHash(reordered)).toBe(computeAuditEntryHash(base));
  });

  it('covers every field, prevHash included', () => {
    const h = computeAuditEntryHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    const variants: Partial<AuditChainFields>[] = [
      { seq: 8 },
      { createdAt: new Date('2026-10-03T09:14:02.124Z') },
      { actorUserId: 'user_2' },
      { actorRole: 'operator' },
      { action: 'org.internal_billing_set' },
      { targetKind: 'organization' },
      { targetId: 'meta' },
      { targetLabel: 'x' },
      { organizationId: 'org_1' },
      { reason: 'ticket 43' },
      { metadata: { toModel: 'c', audience: 'customer', fromModel: null } },
      { prevHash: 'b'.repeat(64) },
      { prevHash: null },
    ];
    for (const v of variants) {
      expect(computeAuditEntryHash({ ...base, ...v }), JSON.stringify(v)).not.toBe(h);
    }
  });

  it('is reproduced BYTE-FOR-BYTE by the SQL mirror the migration chained legacy rows with', async () => {
    // `platform_audit_entry_hash()` is what numbered and hashed every row that
    // existed before this card. If it and the TypeScript drift apart, every
    // legacy row reads as tampered — so the two are held equal here, over the
    // inputs most likely to make two JSON serialisers disagree.
    const cases: AuditChainFields[] = [
      base,
      { ...base, seq: 1, prevHash: null, metadata: null, reason: null, targetId: null },
      {
        ...base,
        targetLabel: 'Ünïcode "quotes" \\ back\tslash\nnewline \u0001 ctrl 汉字 😀',
        reason: 'line one\r\nline two / slash',
        metadata: {
          z: [1, 2.5, -3, 0, { b: true, a: 'é', c: null }],
          A: '\u001f',
          nested: { list: [], obj: {} },
          'key with space': 'v',
        },
      },
      { ...base, createdAt: new Date('2026-01-05T00:00:00.000Z'), metadata: [1, 'two', null] },
    ];
    for (const f of cases) {
      const [row] = await adminDb.$queryRaw<{ h: string }[]>`
        SELECT platform_audit_entry_hash(
          ${f.seq}::int,
          (${f.createdAt.toISOString()}::timestamptz AT TIME ZONE 'UTC')::timestamp(3),
          ${f.actorUserId}::text, ${f.actorRole}::text, ${f.action}::text, ${f.targetKind}::text,
          ${f.targetId}::text, ${f.targetLabel}::text, ${f.organizationId}::text, ${f.reason}::text,
          ${f.metadata === null ? null : JSON.stringify(f.metadata)}::jsonb,
          ${f.prevHash}::text
        ) AS h`;
      expect(row!.h, JSON.stringify(f)).toBe(computeAuditEntryHash(f));
    }
  });
});

describe('the append path chains every row', () => {
  it('numbers entries 1, 2, 3 and links each to the one before', async () => {
    await recordWrites(currentPrincipal!, 3);
    const rows = await chainRows();
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0]!.prevHash).toBeNull();
    expect(rows[1]!.prevHash).toBe(rows[0]!.entryHash);
    expect(rows[2]!.prevHash).toBe(rows[1]!.entryHash);
    // The stored hash is the hash of the stored row — the property the verifier
    // depends on, read back through the database (jsonb, TIMESTAMP(3)).
    for (const r of rows) expect(computeAuditEntryHash(r)).toBe(r.entryHash);
    expect(findFirstChainBreak(rows, 'genesis')).toBeNull();
  });

  it('chains a row with metadata exactly as stored (jsonb re-orders keys)', async () => {
    await platformAuditService.record(currentPrincipal!, {
      action: 'ai.planner_model.set',
      targetKind: 'platform',
      targetId: 'customer',
      reason: 'cheaper model',
      metadata: { toModel: 'model-b', audience: 'customer', fromModel: null },
    });
    const [row] = await chainRows();
    expect(computeAuditEntryHash(row!)).toBe(row!.entryHash);
  });

  it('a rolled-back transaction leaves no row AND no gap', async () => {
    await recordWrites(currentPrincipal!, 1);
    await expect(
      withPlatformRead(currentPrincipal!, { action: 'estate.read', targetKind: 'platform' }, () => {
        throw new Error('the read failed');
      }),
    ).rejects.toThrow('the read failed');
    await recordWrites(currentPrincipal!, 1);
    expect((await chainRows()).map((r) => r.seq)).toEqual([1, 2]);
  });

  it('CONCURRENT appends serialize on the chain lock — one chain, no fork, no gap', async () => {
    const N = 12;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        platformAuditService.record(currentPrincipal!, {
          action: 'estate.read',
          targetKind: 'platform',
          targetLabel: `concurrent ${i}`,
        }),
      ),
    );
    const rows = await chainRows();
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    // A fork is two rows chained to the same parent.
    expect(new Set(rows.map((r) => r.prevHash)).size).toBe(N);
    expect(findFirstChainBreak(rows, 'genesis')).toBeNull();
  });
});

describe('verifyChain', () => {
  it('validates an untampered chain', async () => {
    await recordWrites(currentPrincipal!, 4);
    const v = await platformAuditService.verifyChain(currentPrincipal!);
    // Four writes plus the check's own `audit.verify` row, appended first.
    expect(v).toMatchObject({ status: 'ok', fromSeq: 1, throughSeq: 5, checkedCount: 5 });
    expect(v.checkedAt).toMatch(/Z$/);
    const own = await adminDb.platformAuditLog.findUniqueOrThrow({ where: { seq: 5 } });
    expect(own.action).toBe('audit.verify');
  });

  it('after a row is altered in the DB, FAILS at that seq and vouches for nothing after it', async () => {
    await recordWrites(currentPrincipal!, 5);
    await adminDb.$executeRaw`UPDATE "platform_audit_log" SET "reason" = 'nothing to see' WHERE "seq" = 3`;

    const v = await platformAuditService.verifyChain(currentPrincipal!);
    expect(v).toMatchObject({
      status: 'broken',
      brokenAtSeq: 3,
      reason: 'hash_mismatch',
      checkedCount: 2,
      // #4, #5, and the check's own row #6.
      entriesAfter: 3,
    });
    if (v.status !== 'broken') throw new Error('unreachable');
    const row3 = await adminDb.platformAuditLog.findUniqueOrThrow({ where: { seq: 3 } });
    expect(v.brokenAtTime).toBe(row3.createdAt.toISOString());

    // Panel 7's markers: verified before, mismatch at, unverified after.
    expect([1, 2, 3, 4, 5, 6].map((seq) => auditEntryChainStatus(seq, v))).toEqual([
      'verified',
      'verified',
      'mismatch',
      'unverified',
      'unverified',
      'unverified',
    ]);

    // And it STAYS failed: a later check, and a check of a range starting at the
    // altered row, both stop at #3 — the chain is not repaired by new entries.
    await recordWrites(currentPrincipal!, 2);
    expect(await platformAuditService.verifyChain(currentPrincipal!)).toMatchObject({
      status: 'broken',
      brokenAtSeq: 3,
    });
    expect(await platformAuditService.verifyChain(currentPrincipal!, { fromSeq: 3 })).toMatchObject(
      { status: 'broken', brokenAtSeq: 3 },
    );
  });

  it('a PAYLOAD (metadata) edit fails at that seq and marks every later seq unverified (MOTIR-753)', async () => {
    await recordWrites(currentPrincipal!, 4);
    await adminDb.$executeRaw`UPDATE "platform_audit_log" SET "metadata" = '{"credits": 999999}'::jsonb WHERE "seq" = 2`;

    const v = await platformAuditService.verifyChain(currentPrincipal!);
    // #3, #4, and the check's own row #5 follow the altered entry.
    expect(v).toMatchObject({
      status: 'broken',
      brokenAtSeq: 2,
      reason: 'hash_mismatch',
      checkedCount: 1,
      entriesAfter: 3,
    });
    expect([1, 2, 3, 4, 5].map((seq) => auditEntryChainStatus(seq, v))).toEqual([
      'verified',
      'mismatch',
      'unverified',
      'unverified',
      'unverified',
    ]);
  });

  it('an edit that RE-HASHES the altered row is caught at the next link', async () => {
    await recordWrites(currentPrincipal!, 5);
    await adminDb.$executeRaw`
      UPDATE "platform_audit_log"
         SET "reason" = 'rewritten',
             "entry_hash" = platform_audit_entry_hash(
               "seq", "created_at", "actor_user_id", "actor_role"::text, "action",
               "target_kind"::text, "target_id", "target_label", "organization_id",
               'rewritten', "metadata", "prev_hash")
       WHERE "seq" = 3`;
    expect(await platformAuditService.verifyChain(currentPrincipal!)).toMatchObject({
      status: 'broken',
      brokenAtSeq: 4,
      reason: 'link_mismatch',
    });
  });

  it('a DELETED row is caught as a gap at the entry after it', async () => {
    await recordWrites(currentPrincipal!, 5);
    await adminDb.$executeRaw`DELETE FROM "platform_audit_log" WHERE "seq" = 2`;
    expect(await platformAuditService.verifyChain(currentPrincipal!)).toMatchObject({
      status: 'broken',
      brokenAtSeq: 3,
      reason: 'seq_gap',
    });
    // A range anchored on the missing entry reports the same gap.
    expect(await platformAuditService.verifyChain(currentPrincipal!, { fromSeq: 3 })).toMatchObject(
      { status: 'broken', brokenAtSeq: 3, reason: 'seq_gap' },
    );
  });

  it('verifies a range against its anchor', async () => {
    await recordWrites(currentPrincipal!, 6);
    expect(
      await platformAuditService.verifyChain(currentPrincipal!, { fromSeq: 3, toSeq: 5 }),
    ).toMatchObject({ status: 'ok', fromSeq: 3, throughSeq: 5, checkedCount: 3 });
    await expect(
      platformAuditService.verifyChain(currentPrincipal!, { fromSeq: 5, toSeq: 3 }),
    ).rejects.toBeInstanceOf(PlatformAuditQueryInvalidError);
  });
});

describe('searchEntries', () => {
  it('filters by actor, tenant, action, date and text; Writes by default', async () => {
    const other = await seedStaff('operator', 'other');
    await recordWrites(currentPrincipal!, 2, 'org_a');
    await recordWrites(other, 1, 'org_b');
    await platformAuditService.record(other, {
      action: 'estate.read',
      targetKind: 'organization',
      targetId: 'org_b',
      organizationId: 'org_b',
    });

    const writes = await platformAuditService.searchEntries(currentPrincipal!);
    // Three writes; the estate.read and the search's own audit.read are reads.
    expect(writes.entries.map((e) => e.seq)).toEqual([3, 2, 1]);
    expect(writes.entries.every((e) => e.isWrite)).toBe(true);
    expect(writes.nextCursor).toBeNull();

    const all = await platformAuditService.searchEntries(currentPrincipal!, { writesOnly: false });
    expect(all.entries.map((e) => e.action)).toEqual([
      'audit.read', // THIS search — appended first, so it sees itself
      'audit.read', // the previous search, recorded
      'estate.read',
      'user.suspend',
      'user.suspend',
      'user.suspend',
    ]);

    const byActor = await platformAuditService.searchEntries(currentPrincipal!, {
      actorUserId: other.userId,
    });
    expect(byActor.entries.map((e) => e.seq)).toEqual([3]);
    expect(byActor.entries[0]!.actor).toMatchObject({ role: 'operator', name: 'Op other' });

    const byTenant = await platformAuditService.searchEntries(currentPrincipal!, {
      organizationId: 'org_a',
    });
    expect(byTenant.entries.map((e) => e.seq)).toEqual([2, 1]);

    const byAction = await platformAuditService.searchEntries(currentPrincipal!, {
      action: 'estate.read',
      writesOnly: false,
    });
    expect(byAction.entries.map((e) => e.action)).toEqual(['estate.read']);

    const byText = await platformAuditService.searchEntries(currentPrincipal!, {
      text: 'TICKET #1',
    });
    expect(byText.entries.map((e) => e.seq)).toEqual([2]);

    const future = await platformAuditService.searchEntries(currentPrincipal!, {
      dateFrom: '2999-01-01',
    });
    expect(future.entries).toEqual([]);
    const past = await platformAuditService.searchEntries(currentPrincipal!, {
      dateTo: '2000-01-01',
    });
    expect(past.entries).toEqual([]);
  });

  it('carries what the open row draws — entry #, hash, the entry it chains to', async () => {
    await recordWrites(currentPrincipal!, 2);
    const { entries } = await platformAuditService.searchEntries(currentPrincipal!);
    const [second, first] = entries;
    expect(second).toMatchObject({ seq: 2, chainedToSeq: 1, prevHash: first!.entryHash });
    expect(first).toMatchObject({ seq: 1, chainedToSeq: null, prevHash: null });
    expect(second!.reason).toBe('ticket #1');
    expect(second!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('is keyset-paginated, 50 a page, newest first, with no overlap', async () => {
    await recordWrites(currentPrincipal!, AUDIT_LOG_PAGE_SIZE + 5);
    const page1 = await platformAuditService.searchEntries(currentPrincipal!);
    expect(page1.entries).toHaveLength(AUDIT_LOG_PAGE_SIZE);
    expect(page1.entries[0]!.seq).toBe(AUDIT_LOG_PAGE_SIZE + 5);
    expect(page1.nextCursor).toBe(String(6));

    const page2 = await platformAuditService.searchEntries(currentPrincipal!, {}, page1.nextCursor);
    expect(page2.entries.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(page2.nextCursor).toBeNull();
  });

  it('records the search itself as an `audit.read`, scoped to the tenant searched', async () => {
    await platformAuditService.searchEntries(currentPrincipal!, { organizationId: 'org_z' });
    const [row] = await chainRows();
    expect(row).toMatchObject({
      action: 'audit.read',
      targetKind: 'organization',
      targetId: 'org_z',
      organizationId: 'org_z',
      reason: null,
    });
  });

  it('refuses a cursor it did not hand out, and an inverted date range', async () => {
    for (const cursor of ['abc', '0', '-1', '1.5']) {
      await expect(
        platformAuditService.searchEntries(currentPrincipal!, {}, cursor),
      ).rejects.toBeInstanceOf(PlatformAuditQueryInvalidError);
    }
    await expect(
      platformAuditService.searchEntries(currentPrincipal!, {
        dateFrom: '2026-10-02',
        dateTo: '2026-10-01',
      }),
    ).rejects.toBeInstanceOf(PlatformAuditQueryInvalidError);
  });
});

describe('staff-gated', () => {
  it('search and verify refuse below superadmin, before anything is written', async () => {
    for (const role of ['support', 'operator'] as const) {
      currentPrincipal = await seedStaff(role);
      await expect(platformAuditService.searchEntries(currentPrincipal)).rejects.toBeInstanceOf(
        NotPlatformStaffError,
      );
      await expect(platformAuditService.verifyChain(currentPrincipal)).rejects.toBeInstanceOf(
        NotPlatformStaffError,
      );
    }
    expect(await adminDb.platformAuditLog.count()).toBe(0);
  });
});

describe('append-only at the repository surface', () => {
  it('has no update, delete or upsert — the chain is appended to and read, never edited', () => {
    const mutators = Object.keys(platformAuditLogRepository).filter((k) =>
      /update|delete|upsert|remove|set/i.test(k),
    );
    expect(mutators).toEqual([]);
  });
});
