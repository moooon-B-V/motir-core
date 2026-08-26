import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Attachment, Prisma, Workspace } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { attachmentRepository } from '@/lib/repositories/attachmentRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../fixtures';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// attachmentRepository — the Subtask 5.2.1 link/management leaves, against a
// REAL Postgres (no-mocks rule). Surfaces under test: the `workItemId` link
// lifecycle (SetNull on issue delete — NOT cascade: the row must survive,
// unlinked, for the 5.2.7 GC to retire its blob), the `source` backfill
// default, the paged panel read, the workspace-scoped URL lookup, link/unlink,
// delete, and the orphan-GC read — plus the empty-input guards on every new
// method (the coverage-gate discipline).
//
// ⚠️ WRITES RUN THROUGH `adminDb` (MOTIR-2751), for the same reason the sibling
// `repositories.test.ts` suites do: the subject is the repository CONTRACT and the
// migration-built constraints — the SetNull-not-cascade link lifecycle, the `source`
// backfill default, the empty-input guards — none of which is a claim about
// visibility. Under the non-bypass role a constraint test that fails with a policy
// error proves nothing about the constraint, and the workspace-scoped lookup would
// pass because the POLICY filtered rather than because the query's own gate did.

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "attachment", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(truncateAll);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Insert an attachment row directly (test setup — the legitimate cross-layer reach). */
async function makeAttachment(
  fx: WorkItemFixture,
  overrides: Partial<{
    workItemId: string | null;
    blobPathname: string;
    createdAt: Date;
    source: 'editor' | 'panel';
  }> = {},
): Promise<Attachment> {
  return adminDb.attachment.create({
    data: {
      workspaceId: fx.workspaceId,
      uploaderUserId: fx.ownerId,
      blobPathname:
        overrides.blobPathname ?? `https://blob.example/attachments/${fx.workspaceId}/f.png`,
      mimeType: 'image/png',
      sizeBytes: 4,
      originalFilename: 'f.png',
      ...(overrides.workItemId !== undefined ? { workItemId: overrides.workItemId } : {}),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      ...(overrides.source ? { source: overrides.source } : {}),
    },
  });
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe('attachment.workItemId schema (5.2.1)', () => {
  it('hard-deleting the issue SETS NULL — the row survives unlinked (GC-eligible), never cascades', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Doomed' });
    const att = await makeAttachment(fx, { workItemId: issue.id });

    await adminDb.workItem.delete({ where: { id: issue.id } });

    const survivor = await adminDb.attachment.findUnique({ where: { id: att.id } });
    expect(survivor).not.toBeNull();
    expect(survivor!.workItemId).toBeNull();
  });

  it("`source` defaults to 'editor' — the backfill stamp for every pre-5.2 row (the 2.3.7 write path sets no source)", async () => {
    const fx = await makeWorkItemFixture();
    const att = await makeAttachment(fx); // no source supplied, like 2.3.7's create
    expect(att.source).toBe('editor');
    expect(att.workItemId).toBeNull(); // rows are born unlinked
  });
});

describe('attachmentRepository.listByWorkItem / countByWorkItem', () => {
  it('returns only the issue’s rows, newest first, and pages via cursor without repeats', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Holder' });
    const other = await createTestWorkItem(fx, { kind: 'task', title: 'Other' });

    const old = await makeAttachment(fx, { workItemId: issue.id, createdAt: daysAgo(3) });
    const mid = await makeAttachment(fx, { workItemId: issue.id, createdAt: daysAgo(2) });
    const fresh = await makeAttachment(fx, { workItemId: issue.id, createdAt: daysAgo(1) });
    await makeAttachment(fx, { workItemId: other.id }); // foreign issue — never listed

    const page1 = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      attachmentRepository.listByWorkItem(issue.id, { take: 2 }, tx),
    );
    expect(page1.map((a) => a.id)).toEqual([fresh.id, mid.id]);

    const page2 = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      attachmentRepository.listByWorkItem(
        issue.id,
        {
          take: 2,
          cursor: page1[1]!.id,
        },
        tx,
      ),
    );
    expect(page2.map((a) => a.id)).toEqual([old.id]); // cursor row skipped, no repeat

    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        attachmentRepository.countByWorkItem(issue.id, tx),
      ),
    ).toBe(3);
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        attachmentRepository.countByWorkItem(other.id, tx),
      ),
    ).toBe(1);
  });
});

describe('attachmentRepository.findManyByIds', () => {
  it('resolves only OWN-workspace rows — a foreign workspace’s id never resolves', async () => {
    const fx = await makeWorkItemFixture();
    const foreign = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });

    const mine = await makeAttachment(fx, { blobPathname: 'attachments/a/mine.png' });
    const theirs = await makeAttachment(foreign, { blobPathname: 'attachments/a/theirs.png' });

    const found = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      attachmentRepository.findManyByIds(
        fx.workspaceId,
        [
          mine.id,
          theirs.id, // foreign workspace — must not resolve
          'nonexistent000000000000000',
        ],
        tx,
      ),
    );
    expect(found.map((a) => a.id)).toEqual([mine.id]);
  });

  it('empty-input guard: [] short-circuits to [] without a query', async () => {
    const fx = await makeWorkItemFixture();
    await makeAttachment(fx);
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        attachmentRepository.findManyByIds(fx.workspaceId, [], tx),
      ),
    ).toEqual([]);
  });
});

describe('attachmentRepository.linkToWorkItem / unlinkFromWorkItem', () => {
  it('links rows with the given source, unlinks them leaving source intact', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Target' });
    const a = await makeAttachment(fx);
    const b = await makeAttachment(fx, { blobPathname: 'https://blob.example/a/b.png' });

    const linked = await adminDb.$transaction((tx) =>
      attachmentRepository.linkToWorkItem([a.id, b.id], issue.id, 'panel', tx),
    );
    expect(linked).toBe(2);

    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      attachmentRepository.listByWorkItem(issue.id, undefined, tx),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.source === 'panel')).toBe(true);

    const unlinked = await adminDb.$transaction((tx) =>
      attachmentRepository.unlinkFromWorkItem([a.id], tx),
    );
    expect(unlinked).toBe(1);

    const aRow = await adminDb.attachment.findUnique({ where: { id: a.id } });
    expect(aRow!.workItemId).toBeNull();
    expect(aRow!.source).toBe('panel'); // source records how it ENTERED, not link state
    expect(
      await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        attachmentRepository.countByWorkItem(issue.id, tx),
      ),
    ).toBe(1);
  });

  it('empty-input guards: [] is a no-op returning 0 for both link and unlink', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Idle' });
    await adminDb.$transaction(async (tx) => {
      expect(await attachmentRepository.linkToWorkItem([], issue.id, 'editor', tx)).toBe(0);
      expect(await attachmentRepository.unlinkFromWorkItem([], tx)).toBe(0);
    });
  });
});

describe('attachmentRepository.delete', () => {
  it('hard-deletes the row (no tombstone)', async () => {
    const fx = await makeWorkItemFixture();
    const att = await makeAttachment(fx);
    await adminDb.$transaction((tx) => attachmentRepository.delete(att.id, tx));
    const attachmentRow = await adminDb.attachment.findUnique({ where: { id: att.id } });
    expect(attachmentRow).toBeNull();
  });
});

describe('attachmentRepository.listOrphans', () => {
  it('returns only UNLINKED rows older than the window, oldest first, cursor-bounded', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Linked holder' });

    const oldest = await makeAttachment(fx, { createdAt: daysAgo(30) });
    const older = await makeAttachment(fx, { createdAt: daysAgo(10) });
    await makeAttachment(fx, { createdAt: daysAgo(1) }); // unlinked but INSIDE the window
    await makeAttachment(fx, { workItemId: issue.id, createdAt: daysAgo(30) }); // linked — never swept

    const page1 = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      attachmentRepository.listOrphans({ olderThan: daysAgo(7), take: 1 }, tx),
    );
    expect(page1.map((a) => a.id)).toEqual([oldest.id]);

    const page2 = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      attachmentRepository.listOrphans(
        {
          olderThan: daysAgo(7),
          take: 1,
          cursor: page1[0]!.id,
        },
        tx,
      ),
    );
    expect(page2.map((a) => a.id)).toEqual([older.id]);

    const page3 = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      attachmentRepository.listOrphans(
        {
          olderThan: daysAgo(7),
          take: 1,
          cursor: page2[0]!.id,
        },
        tx,
      ),
    );
    expect(page3).toEqual([]); // bounded walk terminates — nothing beyond the window
  });
});

// RLS proof for the 5.2.1 policy swap (attachment_active_workspace →
// attachment_workspace_or_system_admin). The dev/CI DB connects as the
// `prodect` superuser (BYPASSRLS — PRODECT_FINDINGS #5), so each assertion
// runs under `SET LOCAL ROLE motir_app` (NOSUPERUSER NOBYPASSRLS), the
// asAppRole idiom from tests/workspace-rls.test.ts.
async function asAppRole<T>(
  guc: { workspaceId?: string; organizationId?: string; userId?: string; systemAdmin?: boolean },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return adminDb.$transaction(async (tx) => {
    if (guc.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${guc.userId}, true)`;
    }
    if (guc.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${guc.workspaceId}, true)`;
    }
    if (guc.organizationId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${guc.organizationId}, true)`;
    }
    if (guc.systemAdmin) {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

describe('attachment RLS — the 5.2.1 policy swap', () => {
  it('tenant gate is UNCHANGED: no context hides everything; the workspace GUC scopes to own rows only', async () => {
    const fx = await makeWorkItemFixture();
    const foreign = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });
    const mine = await makeAttachment(fx);
    await makeAttachment(foreign, { blobPathname: 'https://blob.example/a/theirs.png' });

    const blind = await asAppRole({}, (tx) => tx.attachment.findMany());
    expect(blind).toEqual([]);

    const scoped = await asAppRole({ workspaceId: fx.workspaceId }, (tx) =>
      tx.attachment.findMany(),
    );
    expect(scoped.map((a) => a.id)).toEqual([mine.id]);
  });

  it('the system_admin hatch admits the context-less GC: listOrphans sees ACROSS workspaces and delete passes', async () => {
    const fx = await makeWorkItemFixture();
    const foreign = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });
    const orphanA = await makeAttachment(fx, { createdAt: daysAgo(30) });
    const orphanB = await makeAttachment(foreign, {
      blobPathname: 'https://blob.example/a/theirs.png',
      createdAt: daysAgo(30),
    });

    // The GC read: no workspace context, system_admin bound — both tenants' orphans visible.
    const swept = await asAppRole({ systemAdmin: true }, (tx) =>
      attachmentRepository.listOrphans({ olderThan: daysAgo(7) }, tx),
    );
    expect(swept.map((a) => a.id).sort()).toEqual([orphanA.id, orphanB.id].sort());

    // The GC write: the hatch's WITH CHECK / USING admits the row delete too.
    await asAppRole({ systemAdmin: true }, (tx) => attachmentRepository.delete(orphanA.id, tx));
    const attachmentRow = await adminDb.attachment.findUnique({ where: { id: orphanA.id } });
    expect(attachmentRow).toBeNull();
  });
});

// ── The ORG-SERVICE read arms (MOTIR-2956) ─────────────────────────────────
//
// `entitlementsService.assertWithinStorageCap` sums an ORG's attachments under
// `withOrgServiceWriteContext`, which binds `app.organization_id` and nothing
// else. Neither arm of the policy proved above reads that GUC, so under the
// non-bypass role the sum answered 0 for every org and the §4.3b storage cap
// never fired — while the call site's comment asserted the opposite.
//
// The two cases that matter are below, and NEITHER is expressible through the
// existing describe: the sum spans an org's WORKSPACES (which is why binding a
// workspace could not have answered it), and it must NOT widen when an acting
// user is present.
//
// ⚠️ THAT SECOND CLAUSE NARROWED IN MOTIR-3512, and the narrowing is the point.
// It used to be stated as "`withOrgContext`'s member-scoped reach is unchanged",
// which conflated two different things: the ATTACHMENT arm withdrawing when a
// user is bound (still true, and what this section exists to pin) with the
// WORKSPACE list staying membership-scoped (a corollary of there being no
// user-bound workspace arm at all). MOTIR-3512 adds one —
// `workspace_org_member_read`, which requires `app.user_id` to be NON-empty and
// admits the bound org's workspaces to a member of that org — because
// `summarizeOrgFootprint` and the cross-workspace roster were both answering
// with the ACTOR's slice while intending the ORG's.
//
// So the property pinned below is now stated precisely: binding a user withdraws
// the SERVICE arms, which is proved by an acting user who is NOT an org member
// seeing nothing at all.
//
// ⚠️ These run under `SET LOCAL ROLE motir_app` rather than relying on the
// suite's default connection, deliberately: until MOTIR-2734 flips the default,
// the same assertions made through `@/lib/db` would pass on the bypass role
// while proving nothing at all about the arms.

/** A SECOND workspace inside an EXISTING org — the shape a per-workspace binding cannot answer. */
async function makeSiblingWorkspace(organizationId: string, slug: string): Promise<Workspace> {
  return adminDb.workspace.create({
    data: { organizationId, name: `Sibling ${slug}`, slug: `sibling-${slug}` },
  });
}

describe('attachment + workspace ORG-SERVICE read arms (MOTIR-2956)', () => {
  it('the org GUC alone sums an org’s attachments ACROSS its workspaces, and excludes another org’s', async () => {
    const fx = await makeWorkItemFixture();
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });
    const orgId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } }))
      .organizationId;
    const sibling = await makeSiblingWorkspace(orgId, 'a');

    await makeAttachment(fx); // 4 bytes, workspace 1
    await adminDb.attachment.create({
      data: {
        workspaceId: sibling.id, // 40 bytes, workspace 2 — SAME org
        uploaderUserId: fx.ownerId,
        blobPathname: 'https://blob.example/a/sibling.png',
        mimeType: 'image/png',
        sizeBytes: 40,
        originalFilename: 'sibling.png',
      },
    });
    await makeAttachment(rival, { blobPathname: 'https://blob.example/a/theirs.png' }); // other org

    // Exactly what `withOrgServiceWriteContext` binds: the org GUC, no user.
    const total = await asAppRole({ organizationId: orgId }, (tx) =>
      attachmentRepository.sumSizeByOrganization(orgId, tx),
    );
    expect(total).toBe(44); // 0 before the arms landed — the cap's whole input
  });

  it('fails CLOSED with no org bound — an unbound caller still sums nothing', async () => {
    const fx = await makeWorkItemFixture();
    const orgId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } }))
      .organizationId;
    await makeAttachment(fx);

    expect(await asAppRole({}, (tx) => attachmentRepository.sumSizeByOrganization(orgId, tx))).toBe(
      0,
    );
  });

  it('an ACTING USER withdraws the SERVICE arm — the attachment sum still reads nothing', async () => {
    // The narrowing, pinned. The ATTACHMENT arm requires `app.user_id` to be
    // EMPTY, so a user-bearing org context (organizationsService's surfaces)
    // still sums no attachments at all — which is the clause this section is
    // about, and it is unaffected by MOTIR-3512.
    const fx = await makeWorkItemFixture();
    const orgId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } }))
      .organizationId;
    await makeSiblingWorkspace(orgId, 'b');
    await makeAttachment(fx);

    const bound = { organizationId: orgId, userId: fx.ownerId };
    expect(
      await asAppRole(bound, (tx) => attachmentRepository.sumSizeByOrganization(orgId, tx)),
    ).toBe(0);
  });

  it('a bound user who is NOT an org member sees nothing — the service arm really did withdraw', async () => {
    // This is what the case above USED to prove with its workspace-list
    // assertion, restated so MOTIR-3512's user-bound workspace arm cannot
    // satisfy it by accident. The stranger binds the org GUC and carries a user,
    // so BOTH arms are out: `workspace_org_service_read` needs an empty user and
    // `workspace_org_member_read` needs an org membership they do not have.
    // Nothing admits them, which is the withdrawal, proved positively.
    const fx = await makeWorkItemFixture();
    const stranger = await makeWorkItemFixture({ name: 'Stranger', identifier: 'STR' });
    const orgId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } }))
      .organizationId;
    await makeSiblingWorkspace(orgId, 'b2');

    const visible = await asAppRole({ organizationId: orgId, userId: stranger.ownerId }, (tx) =>
      tx.workspace.findMany({ where: { organizationId: orgId }, select: { id: true } }),
    );
    expect(visible).toEqual([]);
  });

  it('an ORG MEMBER bound to the org DOES see its workspaces — MOTIR-3512’s arm', async () => {
    // The behaviour that replaced the old membership-scoped assertion, asserted
    // here too so this section records what changed rather than losing it. The
    // owner belongs to ONE of the org's two workspaces and now sees both, which
    // is what `summarizeOrgFootprint` and the roster always meant to return.
    // `tests/workspace-org-member-read-rls.test.ts` is the arm's own suite.
    const fx = await makeWorkItemFixture();
    const orgId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } }))
      .organizationId;
    const sibling = await makeSiblingWorkspace(orgId, 'b3');

    const visible = await asAppRole({ organizationId: orgId, userId: fx.ownerId }, (tx) =>
      tx.workspace.findMany({ where: { organizationId: orgId }, select: { id: true } }),
    );
    expect(visible.map((w) => w.id).sort()).toEqual([fx.workspaceId, sibling.id].sort());
  });

  it('the workspace arm is org-scoped, not global — the userless context sees its org’s workspaces only', async () => {
    const fx = await makeWorkItemFixture();
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RVL' });
    const orgId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: fx.workspaceId } }))
      .organizationId;
    const sibling = await makeSiblingWorkspace(orgId, 'c');

    const visible = await asAppRole({ organizationId: orgId }, (tx) =>
      tx.workspace.findMany({ select: { id: true } }),
    );
    expect(visible.map((w) => w.id).sort()).toEqual([fx.workspaceId, sibling.id].sort());
    expect(visible.map((w) => w.id)).not.toContain(rival.workspaceId);
  });
});

describe('2.3.7 upload path is untouched', () => {
  it('attachmentRepository.create still inserts an unlinked row with the unchanged input shape', async () => {
    const fx = await makeWorkItemFixture();
    const row = await adminDb.$transaction((tx) =>
      attachmentRepository.create(
        {
          workspaceId: fx.workspaceId,
          uploaderUserId: fx.ownerId,
          blobPathname: 'https://blob.example/attachments/x/y.png',
          mimeType: 'image/png',
          sizeBytes: 9,
          originalFilename: 'y.png',
        },
        tx,
      ),
    );
    expect(row.workItemId).toBeNull();
    expect(row.source).toBe('editor');
  });
});
