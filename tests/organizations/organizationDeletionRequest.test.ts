import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  ORGANIZATION_BILLING_RETENTION_YEARS,
  ORGANIZATION_DELETION_WINDOW_DAYS,
  erasureDueAt,
  isOrganizationClosing,
  retentionCutoff,
  retentionEndsAt,
} from '@/lib/organizations/deletion';
import { withOrgContext } from '@/lib/organizations/context';
import { organizationDeletionRequestRepository } from '@/lib/repositories/organizationDeletionRequestRepository';
import { toOrganizationDeletionRequestDTO } from '@/lib/mappers/organizationDeletionMappers';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { REPO_ROOT, stripComments } from '../helpers/importGraph';

// The organization-deletion SUBSTRATE (Story MOTIR-6306 · Subtask MOTIR-6391)
// against a REAL Postgres. The partial unique index, the RLS policy, the
// `FOR UPDATE` re-read and the Restrict FK are all properties of the DATABASE, so a
// mocked repository would assert nothing this card promises.
//
// `organization_deletion_request` references `organization` and `user`, and
// `truncateAuthTables` truncates both `… CASCADE`, which reaches it — no new
// truncate target is owed.

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUESTED_AT = new Date('2026-09-26T10:00:00.000Z');

async function makeUser(email: string) {
  return adminDb.user.create({ data: { email, name: email.split('@')[0]!, emailVerified: true } });
}

async function makeOrg(slug: string) {
  return adminDb.organization.create({ data: { name: slug, slug } });
}

function schedule(organizationId: string, userId: string, requestedAt = REQUESTED_AT) {
  return withOrgContext({ userId, organizationId }, (tx) =>
    organizationDeletionRequestRepository.create(
      {
        organizationId,
        requestedByUserId: userId,
        requestedAt,
        erasureDueAt: erasureDueAt(requestedAt),
      },
      tx,
    ),
  );
}

/** A rendezvous both parties reach before either proceeds (the MOTIR-3707 shape). */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= parties) release();
    await open;
  };
}

afterAll(async () => {
  await db.$disconnect();
});

describe('the window is the published promise', () => {
  it('equals the thirty days DPA §10 promises', () => {
    // motir.co DPA §10 ("Deletion and return"), verbatim:
    //   "Unless you ask otherwise, we delete it within **thirty days** of termination"
    // A PROMISE, not documentation: if this fails, read §10 before touching the literal.
    const PUBLISHED_DPA_DELETION_DAYS = 30;
    expect(ORGANIZATION_DELETION_WINDOW_DAYS).toBe(PUBLISHED_DPA_DELETION_DAYS);
  });

  it('derives the due date as exactly requestedAt + 30 days', () => {
    expect(erasureDueAt(REQUESTED_AT).getTime()).toBe(
      REQUESTED_AT.getTime() + ORGANIZATION_DELETION_WINDOW_DAYS * DAY_MS,
    );
    expect(erasureDueAt(REQUESTED_AT).toISOString()).toBe('2026-10-26T10:00:00.000Z');
  });

  it('cites DPA §10 beside the constant', () => {
    const source = readFileSync(path.join(REPO_ROOT, 'lib/organizations/deletion.ts'), 'utf8');
    const head = source.slice(0, source.indexOf('export const ORGANIZATION_DELETION_WINDOW_DAYS'));
    expect(head).toMatch(/DPA|Data Processing Agreement/);
    expect(head).toContain('§10');
  });

  it('keeps billing seven CALENDAR years from the erasure', () => {
    expect(ORGANIZATION_BILLING_RETENTION_YEARS).toBe(7);
    // A leap day inside the window must not shorten the retention by a day.
    const erased = new Date('2027-03-01T00:00:00.000Z');
    expect(retentionEndsAt(erased).toISOString()).toBe('2034-03-01T00:00:00.000Z');
    expect(retentionCutoff(new Date('2034-03-01T00:00:00.000Z')).toISOString()).toBe(
      erased.toISOString(),
    );
  });

  it('reads an org as closing only while it is scheduled and not yet a tombstone', () => {
    const at = new Date();
    expect(isOrganizationClosing({ closingSince: null, erasedAt: null })).toBe(false);
    expect(isOrganizationClosing({ closingSince: at, erasedAt: null })).toBe(true);
    expect(isOrganizationClosing({ closingSince: at, erasedAt: at })).toBe(false);
  });
});

describe('the columns are Postgres enums', () => {
  async function enumLabels(typeName: string): Promise<string[]> {
    const rows = await adminDb.$queryRaw<Array<{ label: string }>>`
      SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = ${typeName} ORDER BY e.enumsortorder
    `;
    return rows.map((row) => row.label);
  }

  it('status is the five-state lifecycle', async () => {
    expect(await enumLabels('organization_deletion_status')).toEqual([
      'scheduled',
      'cancelled',
      'erasing',
      'erased',
      'purged',
    ]);
  });

  it('erasure steps are in DECISION §6 order — Git first', async () => {
    expect(await enumLabels('organization_erasure_step')).toEqual([
      'git',
      'workspaces',
      'ai',
      'tombstone',
    ]);
  });
});

describe('at most one OPEN request per organization', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('refuses a second scheduled row for the same org', async () => {
    const owner = await makeUser('owner-dup@example.com');
    const org = await makeOrg('org-dup');
    await schedule(org.id, owner.id);
    await expect(schedule(org.id, owner.id)).rejects.toMatchObject({ code: 'P2002' });
    expect(
      await adminDb.organizationDeletionRequest.count({ where: { organizationId: org.id } }),
    ).toBe(1);
  });

  it('accepts a cancelled row beside a scheduled one', async () => {
    const owner = await makeUser('owner-cancel@example.com');
    const org = await makeOrg('org-cancel');
    const first = await schedule(org.id, owner.id);
    await withOrgContext({ userId: owner.id, organizationId: org.id }, (tx) =>
      organizationDeletionRequestRepository.update(
        first.id,
        { status: 'cancelled', cancelledAt: new Date(), cancelledByUserId: owner.id },
        tx,
      ),
    );
    const second = await schedule(org.id, owner.id, new Date('2026-09-27T10:00:00.000Z'));
    expect(second.id).not.toBe(first.id);
    expect(
      await adminDb.organizationDeletionRequest.findMany({
        where: { organizationId: org.id },
        select: { status: true },
        orderBy: { requestedAt: 'asc' },
      }),
    ).toEqual([{ status: 'cancelled' }, { status: 'scheduled' }]);
  });

  it('treats an ERASING row as open too', async () => {
    const owner = await makeUser('owner-erasing@example.com');
    const org = await makeOrg('org-erasing');
    const first = await schedule(org.id, owner.id);
    await withSystemContext((tx) =>
      organizationDeletionRequestRepository.update(
        first.id,
        { status: 'erasing', erasingStartedAt: new Date() },
        tx,
      ),
    );
    await expect(schedule(org.id, owner.id)).rejects.toMatchObject({ code: 'P2002' });
  });

  it('is not confused by ANOTHER org holding an open request', async () => {
    const owner = await makeUser('owner-two@example.com');
    const a = await makeOrg('org-a');
    const b = await makeOrg('org-b');
    await schedule(a.id, owner.id);
    await schedule(b.id, owner.id);
    expect(await adminDb.organizationDeletionRequest.count()).toBe(2);
  });

  it('lets exactly one of two simultaneous schedules through, five times over', async () => {
    // The lock cannot be what decides this: over zero rows `FOR UPDATE` locks
    // nothing, so both racers read null (asserted) and the index is the guard.
    const owner = await makeUser('owner-race@example.com');
    const org = await makeOrg('org-race');
    for (let round = 0; round < 5; round += 1) {
      await adminDb.organizationDeletionRequest.deleteMany({ where: { organizationId: org.id } });
      const arrive = barrier(2);
      const sawOpen: unknown[] = [];
      const attempt = () =>
        withOrgContext({ userId: owner.id, organizationId: org.id }, async (tx) => {
          sawOpen.push(
            await organizationDeletionRequestRepository.findOpenByOrganizationIdForUpdate(
              org.id,
              tx,
            ),
          );
          await arrive();
          return organizationDeletionRequestRepository.create(
            {
              organizationId: org.id,
              requestedByUserId: owner.id,
              requestedAt: REQUESTED_AT,
              erasureDueAt: erasureDueAt(REQUESTED_AT),
            },
            tx,
          );
        });
      const results = await Promise.allSettled([attempt(), attempt()]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length, `round ${round}`).toBe(1);
      const reason = (rejected[0] as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((reason as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
      expect(sawOpen, `round ${round}: a racer saw the other's row`).toEqual([null, null]);
    }
  });
});

describe('the locking read serialises writers and re-reads the status', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it("makes a second caller WAIT, then hands it the first caller's committed status", async () => {
    // Two real connections: a cancel holds the lock and commits `cancelled`; the
    // sweep's claim, blocked on the same row, must then see `cancelled` — not the
    // `scheduled` it would have read before, and not ZERO rows (which a status
    // filter would return under READ COMMITTED's re-evaluation).
    const owner = await makeUser('owner-lock@example.com');
    const org = await makeOrg('org-lock');
    const request = await schedule(org.id, owner.id);

    let releaseCancel!: () => void;
    const cancelMayCommit = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let cancelHoldsLock!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      cancelHoldsLock = resolve;
    });
    const order: string[] = [];

    const cancel = withOrgContext({ userId: owner.id, organizationId: org.id }, async (tx) => {
      const locked = await organizationDeletionRequestRepository.findOpenByOrganizationIdForUpdate(
        org.id,
        tx,
      );
      expect(locked?.status).toBe('scheduled');
      cancelHoldsLock();
      await cancelMayCommit;
      await organizationDeletionRequestRepository.update(
        request.id,
        { status: 'cancelled', cancelledAt: new Date(), cancelledByUserId: owner.id },
        tx,
      );
      order.push('cancel-committing');
    });

    await lockHeld;
    const claim = withSystemContext(async (tx) => {
      const locked = await organizationDeletionRequestRepository.findOpenByOrganizationIdForUpdate(
        org.id,
        tx,
      );
      order.push('claim-read');
      return locked;
    });

    // Give the claim every chance to run ahead: it must still be blocked.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(order).toEqual([]);

    releaseCancel();
    await cancel;
    const seen = await claim;
    expect(order).toEqual(['cancel-committing', 'claim-read']);
    expect(seen?.id).toBe(request.id);
    expect(seen?.status).toBe('cancelled');
  });
});

describe('row-level security', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it("hides one organization's request from a context bound to another org", async () => {
    const alice = await makeUser('rls-alice@example.com');
    const mallory = await makeUser('rls-mallory@example.com');
    const aliceOrg = await makeOrg('rls-alice-org');
    const malloryOrg = await makeOrg('rls-mallory-org');
    await schedule(aliceOrg.id, alice.id);

    const seen = await withOrgContext(
      { userId: mallory.id, organizationId: malloryOrg.id },
      async (tx) => ({
        open: await organizationDeletionRequestRepository.findOpenByOrganizationId(aliceOrg.id, tx),
        locked: await organizationDeletionRequestRepository.findOpenByOrganizationIdForUpdate(
          aliceOrg.id,
          tx,
        ),
        due: await organizationDeletionRequestRepository.listDue(new Date('2030-01-01'), 10, tx),
      }),
    );
    expect(seen).toEqual({ open: null, locked: null, due: [] });
    // The row is really there — the emptiness is the policy.
    expect(
      await adminDb.organizationDeletionRequest.count({ where: { organizationId: aliceOrg.id } }),
    ).toBe(1);
  });

  it('refuses a write into another org', async () => {
    const mallory = await makeUser('rls-writer@example.com');
    const victim = await makeOrg('rls-victim');
    const own = await makeOrg('rls-own');
    await expect(
      withOrgContext({ userId: mallory.id, organizationId: own.id }, (tx) =>
        organizationDeletionRequestRepository.create(
          {
            organizationId: victim.id,
            requestedByUserId: mallory.id,
            requestedAt: REQUESTED_AT,
            erasureDueAt: erasureDueAt(REQUESTED_AT),
          },
          tx,
        ),
      ),
    ).rejects.toThrow();
    expect(await adminDb.organizationDeletionRequest.count()).toBe(0);
  });

  it('admits the userless sweeps through the system arm, and a context with nothing bound sees nothing', async () => {
    const owner = await makeUser('rls-sweep@example.com');
    const org = await makeOrg('rls-sweep-org');
    const request = await schedule(org.id, owner.id);

    const locked = await withSystemContext((tx) =>
      organizationDeletionRequestRepository.findOpenByOrganizationIdForUpdate(org.id, tx),
    );
    expect(locked?.id).toBe(request.id);

    const unbound = await db.$transaction((tx) =>
      organizationDeletionRequestRepository.findOpenByOrganizationId(org.id, tx),
    );
    expect(unbound).toBeNull();
  });
});

describe('the sweep and purge work sets', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('listDue returns scheduled-and-past-due plus every erasing row, oldest deadline first', async () => {
    const owner = await makeUser('due@example.com');
    const [notDue, due, erasing, cancelled] = await Promise.all(
      ['due-not', 'due-yes', 'due-erasing', 'due-cancelled'].map((slug) => makeOrg(slug)),
    );
    const now = new Date('2026-11-01T00:00:00.000Z');
    await schedule(notDue!.id, owner.id, new Date('2026-10-20T00:00:00.000Z')); // due 2026-11-19
    const dueRow = await schedule(due!.id, owner.id, new Date('2026-09-01T00:00:00.000Z')); // due 2026-10-01
    const erasingRow = await schedule(erasing!.id, owner.id, new Date('2026-09-15T00:00:00.000Z'));
    const cancelledRow = await schedule(
      cancelled!.id,
      owner.id,
      new Date('2026-08-01T00:00:00.000Z'),
    );

    const result = await withSystemContext(async (tx) => {
      await organizationDeletionRequestRepository.update(
        erasingRow.id,
        { status: 'erasing', erasureStep: 'git' },
        tx,
      );
      await organizationDeletionRequestRepository.update(
        cancelledRow.id,
        { status: 'cancelled' },
        tx,
      );
      return organizationDeletionRequestRepository.listDue(now, 10, tx);
    });
    expect(result.map((r) => r.id)).toEqual([dueRow.id, erasingRow.id]);
  });

  it('listErasedBefore returns only erased tombstones older than the cutoff', async () => {
    const owner = await makeUser('purge@example.com');
    const [old, recent] = await Promise.all([makeOrg('purge-old'), makeOrg('purge-recent')]);
    const oldRow = await schedule(old.id, owner.id);
    const recentRow = await schedule(recent.id, owner.id);
    const result = await withSystemContext(async (tx) => {
      await organizationDeletionRequestRepository.update(
        oldRow.id,
        { status: 'erased', erasedAt: new Date('2026-01-01T00:00:00.000Z') },
        tx,
      );
      await organizationDeletionRequestRepository.update(
        recentRow.id,
        { status: 'erased', erasedAt: new Date('2027-01-01T00:00:00.000Z') },
        tx,
      );
      return organizationDeletionRequestRepository.listErasedBefore(
        retentionCutoff(new Date('2033-06-01T00:00:00.000Z')),
        10,
        tx,
      );
    });
    expect(result.map((r) => r.id)).toEqual([oldRow.id]);
  });
});

describe('the organization row keeps its deletion record', () => {
  beforeEach(async () => {
    await truncateAuthTables();
  });

  it('refuses to delete an org that has a deletion request (Restrict)', async () => {
    const owner = await makeUser('restrict@example.com');
    const org = await makeOrg('restrict-org');
    await schedule(org.id, owner.id);
    await expect(adminDb.organization.delete({ where: { id: org.id } })).rejects.toThrow();
    expect(await adminDb.organization.count({ where: { id: org.id } })).toBe(1);
  });

  it('nulls the actor, not the record, when the scheduling account is deleted', async () => {
    const owner = await makeUser('setnull@example.com');
    const org = await makeOrg('setnull-org');
    const request = await schedule(org.id, owner.id);
    await adminDb.user.delete({ where: { id: owner.id } });
    const row = await adminDb.organizationDeletionRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(row.requestedByUserId).toBeNull();
    expect(toOrganizationDeletionRequestDTO(row)).toMatchObject({
      id: request.id,
      organizationId: org.id,
      status: 'scheduled',
      requestedByUserId: null,
      erasureDueAt: '2026-10-26T10:00:00.000Z',
    });
  });
});

describe('only the repository reaches the table', () => {
  const ACCESSOR = /\.organizationDeletionRequest\b/;
  const SOURCE_DIRS = ['lib', 'app', 'components', 'scripts'];
  const ALLOWED_PREFIX = path.join('lib', 'repositories') + path.sep;

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = path.join(current, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) out.push(path.relative(REPO_ROOT, full));
      }
    };
    walk(path.join(REPO_ROOT, dir));
    return out;
  }

  it('no file outside lib/repositories/ addresses the model', () => {
    const offenders = SOURCE_DIRS.flatMap(sourceFiles)
      .filter((file) => !file.startsWith(ALLOWED_PREFIX))
      .filter((file) =>
        ACCESSOR.test(stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'))),
      );
    expect(offenders).toEqual([]);
  });

  it('the repository that IS allowed to exists', () => {
    const found = sourceFiles('lib').filter((file) =>
      ACCESSOR.test(stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8'))),
    );
    expect(found).toEqual([
      path.join('lib', 'repositories', 'organizationDeletionRequestRepository.ts'),
    ]);
  });
});
