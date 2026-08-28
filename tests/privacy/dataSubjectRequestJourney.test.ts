import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// THE DATA-SUBJECT-REQUEST JOURNEY (Story 8.4 · Subtask MOTIR-3706) — the
// STORY-LEVEL suite over the feature MOTIR-3698…MOTIR-3704 built, against the
// real Postgres.
//
// ── WHAT THIS FILE IS FOR, AND WHAT IT DELIBERATELY DOES NOT ASSERT ─────────
//
// Every slice of this feature already ships its own units, and re-deriving them
// here would buy nothing and double the maintenance. What is owed at this
// altitude is the ASSEMBLED journey — the places where a correct slice plus a
// correct slice still produce a wrong product. So, per journey, the thing this
// file asserts that no sibling does:
//
//   JOURNEY 1 · export → download.
//     `tests/export/dataExportService.test.ts` asserts the SCOPE RULE at the
//     service ("omits another member's rows from a workspace the reader IS in")
//     and `tests/export/dataExportDownload.test.ts` asserts the ROUTE's four
//     answers (302 / 404 / 409 / 410) against rows it writes by hand. Neither
//     one composes them: nobody drives the reader's own Server Action, lets the
//     event it emits pick its handler out of the job REGISTRY, and then opens
//     the bytes the DOWNLOAD ROUTE actually hands over. A scope rule that holds
//     in the service and leaks through the route passes both suites.
//
//   JOURNEY 2 · the blocked path never writes.
//     `tests/account-erasure-preview.test.ts` asserts the block verdict from
//     real rows; `tests/settings/accountDataPane.test.tsx` asserts the control
//     renders disabled — from a STUBBED preview; `tests/account-deletion-
//     schedule.test.ts` asserts the service refuses. The composition nobody
//     runs is the three together: that the REAL database state yields the
//     disabled control AND that the write door refuses AND that the whole
//     journey leaves ZERO rows behind. Each card can be right while the
//     composition still lets a request through.
//
//   JOURNEY 3 · schedule → due → erased, three groups in ONE fixture.
//     `tests/account-erasure-sweep.test.ts` asserts each group in a fixture of
//     its own — a sole-membership workspace here, a shared project's comments
//     there, the billing rows in a third. This asserts them on ONE account, in
//     ONE sweep, because that is the only shape in which a delete can reach
//     across into what an anonymise was supposed to keep. A sweep that deletes
//     a shared project instead of anonymising it destroys a third party's work;
//     one that anonymises nothing leaves personal data standing under a
//     published promise that it is gone.
//
// The E2E half — the type-to-confirm modal, the app-wide banner on a route
// outside account settings, and the cancel that clears it — is
// `tests/e2e/data-subject-request-journey.spec.ts`. The split is deliberate:
// Playwright drives what is genuinely an interactive flow, and the sweep is
// never driven through a browser.

// ── the seams the environment cannot provide ────────────────────────────────
// The presigner needs S3 config to sign with. Nothing here reaches the network:
// `getSignedUrl` is local crypto, which is why the download URL below is minted
// FOR REAL rather than stubbed (`tests/export/dataExportDownload.test.ts` makes
// the same call and says why at more length).
const S3_ENV = {
  MOTIR_S3_ENDPOINT: 'https://s3.test.invalid',
  MOTIR_S3_REGION: 'auto',
  MOTIR_S3_ACCESS_KEY_ID: 'test-access-key',
  MOTIR_S3_SECRET_ACCESS_KEY: 'test-secret-key',
  MOTIR_S3_PRIVATE_BUCKET: 'motir-private',
  MOTIR_S3_PUBLIC_BUCKET: 'motir-public',
  MOTIR_S3_PUBLIC_BASE_URL: 'https://s3.test.invalid/motir-public',
} as const;
Object.assign(process.env, S3_ENV);

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'localhost:3000', 'x-forwarded-proto': 'http' }),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

// The Server Actions call `revalidatePath`, which needs a request store no test
// process has. Transport only — what the action DID is asserted from the rows.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

// CLAUDE.md's single sanctioned mock: there are no cookies here to carry a
// session. Everything below the session is real.
vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: vi.fn() };
});

// next-intl's SERVER entry, echoing keys — the harness's own shim. The pane's
// copy is not this file's subject; the `disabled` the preview yields is.
vi.mock('next-intl/server', async () => {
  const harness = await import('../helpers/serverPageHarness');
  return { getTranslations: harness.serverTranslations, getLocale: async () => 'en' };
});

// ── the blob store, in memory ───────────────────────────────────────────────
// `lib/blob/uploader` is the network seam. Only the OBJECT operations are
// replaced; `signedDownloadUrl` stays REAL, because the whole point of journey
// 1 is that the bytes are the ones the route's own URL addresses.
const blobs = vi.hoisted(() => new Map<string, Buffer>());

vi.mock('@/lib/blob/uploader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blob/uploader')>();
  return {
    ...actual,
    putPrivateAttachment: vi.fn(async (pathname: string, body: Buffer) => {
      blobs.set(pathname, Buffer.from(body));
      return { pathname };
    }),
    getPrivateBlobBytes: vi.fn(async (pathname: string) => blobs.get(pathname) ?? null),
    headPrivateBlob: vi.fn(async (pathname: string) => {
      const hit = blobs.get(pathname);
      return hit ? { size: hit.byteLength, contentType: 'application/zip' } : null;
    }),
    deleteAttachmentBlob: vi.fn(async (pathname: string) => {
      blobs.delete(pathname);
    }),
  };
});

// The emit seam, captured rather than enqueued — the shape
// `tests/export/dataExportService.test.ts` uses. Journey 1 then resolves the
// captured NAME against the job registry, which is the assertion: an action
// that emits an event nothing handles builds no archive, and every unit passes.
const emitted = vi.hoisted(() => [] as Array<{ name: string; data: Record<string, unknown> }>);
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, data: Record<string, unknown>) => {
    emitted.push({ name, data });
  },
}));

const { db } = await import('@/lib/db');
const { getSession } = await import('@/lib/auth');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables, truncateJobRuns, truncateRateLimitCounters } =
  await import('../helpers/db');
const { JobTestEngine } = await import('../helpers/jobs');
const { jobDefinitions } = await import('@/lib/jobs/registry');
const { findFirst } = await import('../helpers/serverPageHarness');

const { accountErasureService } = await import('@/lib/services/accountErasureService');
const { accountErasureSweepService } = await import('@/lib/services/accountErasureSweepService');
const { dataExportService } = await import('@/lib/services/dataExportService');
const { commentsService } = await import('@/lib/services/commentsService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { ERASED_USER_NAME } = await import('@/lib/users/accountErasure');
const { erasureDueAt } = await import('@/lib/users/dataSubjectRequests');

const { requestDataExportAction } = await import('@/app/(authed)/settings/account/data/actions');
const { scheduleAccountDeletionAction, cancelAccountDeletionAction } =
  await import('@/app/(authed)/_account-deletion-actions');
const { GET: downloadRoute } = await import('@/app/api/account/data-export/[id]/download/route');
const { DeleteAccountCard } =
  await import('@/app/(authed)/settings/account/_components/DeleteAccountCard');
const { DeleteAccountTrigger } =
  await import('@/app/(authed)/settings/account/_components/DeleteAccountTrigger');

const { createTestProject, createTestUser, createTestWorkItem } = await import('../fixtures');
type WorkItemFixture = import('../fixtures/workItemFixtures').WorkItemFixture;

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  await truncateRateLimitCounters();
  blobs.clear();
  emitted.length = 0;
  vi.mocked(getSession).mockResolvedValue(null);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── fixtures ────────────────────────────────────────────────────────────────

/** Sign the process in as `userId`, the way a request would arrive. */
function signInAs(userId: string, email: string): void {
  vi.mocked(getSession).mockResolvedValue({
    user: { id: userId, email },
  } as unknown as Awaited<ReturnType<typeof getSession>>);
}

/**
 * A `WorkItemFixture` over an EXISTING workspace, acting as `userId` — so the
 * rows it creates are that person's. Lifted from the sibling erasure suite,
 * which needs the same thing for the same reason.
 */
async function fixtureFor(
  userId: string,
  workspaceId: string,
  identifier: string,
): Promise<WorkItemFixture> {
  const project = await createTestProject({ workspaceId, actorUserId: userId, identifier });
  return {
    owner: await adminDb.user.findUniqueOrThrow({ where: { id: userId } }),
    workspace: await adminDb.workspace.findUniqueOrThrow({ where: { id: workspaceId } }),
    project,
    ownerId: userId,
    workspaceId,
    projectId: project.id,
    projectIdentifier: project.identifier,
    ctx: { userId, workspaceId },
  };
}

async function orgIdOfWorkspace(workspaceId: string): Promise<string> {
  const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return ws.organizationId;
}

/** Back-date an open request so its deadline has passed, the way the sibling
 *  suite does — thirty days is not a thing a test can wait for, and moving the
 *  clock would move the whole fixture's timestamps with it. */
async function ageUntilDue(requestId: string, daysOverdue = 1): Promise<void> {
  const requestedAt = new Date(Date.now() - (30 + daysOverdue) * DAY_MS);
  await adminDb.accountDeletionRequest.update({
    where: { id: requestId },
    data: { requestedAt, erasureDueAt: erasureDueAt(requestedAt) },
  });
}

/** Open the archive the build uploaded, addressed by the pathname the DOWNLOAD
 *  ROUTE's own presigned URL names — never by the row's column. */
function openArchiveAt(pathname: string): Record<string, Uint8Array> {
  const stored = blobs.get(pathname);
  expect(stored, `no object at ${pathname}`).toBeDefined();
  // The zip magic, before any reader is trusted.
  expect(Array.from(stored!.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
  return unzipSync(stored!);
}

function readJson(
  entries: Record<string, Uint8Array>,
  name: string,
): { table: string; rows: Array<Record<string, unknown>> } {
  expect(Object.keys(entries), `${name} missing from archive`).toContain(name);
  return JSON.parse(strFromU8(entries[name]!));
}

/**
 * The object key a presigned GET addresses.
 *
 * The client is configured `forcePathStyle` (`lib/blob/s3.ts` says why), so the
 * URL is `<endpoint>/<bucket>/<key>?X-Amz-…` and the key is everything after
 * the bucket segment. Parsed from the URL rather than read off the row, because
 * the question this journey asks is which object the ROUTE hands over.
 */
function keyFromSignedUrl(signed: string): string {
  const { pathname } = new URL(signed);
  const prefix = `/${S3_ENV.MOTIR_S3_PRIVATE_BUCKET}/`;
  expect(pathname.startsWith(prefix), `unexpected download URL: ${signed}`).toBe(true);
  return decodeURIComponent(pathname.slice(prefix.length));
}

// ─────────────────────────────────────────────────────────────────────────────
// JOURNEY 1 — request → build → ready → download, and the scope rule SURVIVES
//             the route
// ─────────────────────────────────────────────────────────────────────────────

describe('JOURNEY 1 — export → download', () => {
  it('hands the reader an archive of their own rows and NONE of a co-member’s, through the real download route', async () => {
    // ── a workspace two people share ────────────────────────────────────────
    // The co-member's rows are the interesting half: RLS admits them (the
    // exporter is a member of this workspace), so they are excluded only
    // because they are not this person's data. A build that leaked them would
    // still pass any test that only checked a workspace the exporter cannot
    // read at all.
    const exporter = await createTestUser({ name: 'Exporting Erin' });
    const coMember = await createTestUser({ name: 'Co-member Casey' });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Shared',
      ownerUserId: exporter.id,
    });
    await workspacesService.addMember({ userId: coMember.id, workspaceId: workspace.id });

    const exporterFx = await fixtureFor(exporter.id, workspace.id, 'SHR');
    const coMemberFx: WorkItemFixture = {
      ...exporterFx,
      ownerId: coMember.id,
      ctx: { userId: coMember.id, workspaceId: workspace.id },
    };
    const item = await createTestWorkItem(exporterFx, { kind: 'task', title: 'Shared task' });
    await commentsService.addComment(item.id, { bodyMd: 'MINE-erin' }, exporterFx.ctx);
    await commentsService.addComment(item.id, { bodyMd: 'THEIRS-casey' }, coMemberFx.ctx);

    // ── the reader presses "Request export" ─────────────────────────────────
    // Cleared HERE rather than in `beforeEach`: seeding a workspace, a project,
    // a work item and two comments emits events of its own, so the list is
    // scoped to what the ACTION emitted and `toHaveLength(1)` below says what
    // it means.
    emitted.length = 0;
    signInAs(exporter.id, exporter.email);
    const requested = await requestDataExportAction();
    expect(requested).toEqual({ ok: true, started: true });

    // ── the event the action emitted picks its own handler out of the REGISTRY
    // This is the seam: the action names an event, the registry answers it, and
    // nothing else in the suite puts those two facts against each other. An
    // action emitting an event no job is mounted for builds no archive, and
    // every unit on either side still passes.
    expect(emitted).toHaveLength(1);
    const event = emitted[0]!;
    const handler = jobDefinitions.find((definition) => definition.id === event.name);
    expect(handler, `no job is mounted for '${event.name}'`).toBeDefined();

    await new JobTestEngine({ function: handler!, events: [event] }).execute();

    // ── the PANE's read is what tells the reader it is ready ────────────────
    const pane = await dataExportService.getLatestExportForUser(exporter.id);
    expect(pane).toMatchObject({ status: 'ready' });

    // ── Download, through the route the pane's control addresses ────────────
    const response = await downloadRoute(
      new Request(`http://localhost:3000/api/account/data-export/${pane!.id}/download`),
      { params: Promise.resolve({ id: pane!.id }) },
    );
    expect(response.status).toBe(302);

    const entries = openArchiveAt(keyFromSignedUrl(response.headers.get('location')!));
    const bodies = readJson(entries, 'comment.json').rows.map((row) => row['bodyMd']);

    // The composition, in two lines: the reader's own row arrived through the
    // route, and the co-member's — readable to the exporter, and theirs — did
    // not.
    expect(bodies).toContain('MINE-erin');
    expect(bodies).not.toContain('THEIRS-casey');
    expect(JSON.stringify(entries['user.json'])).not.toContain(coMember.email);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JOURNEY 2 — the blocked path, asserted over the whole flow rather than at one
//             tier of it
// ─────────────────────────────────────────────────────────────────────────────

describe('JOURNEY 2 — a sole organization owner is refused, and NOTHING is written', () => {
  it('yields a DISABLED control from the real preview, refuses the write, and leaves zero AccountDeletionRequest rows', async () => {
    const owner = await createTestUser({ name: 'Only Owner' });
    const colleague = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const organizationId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId,
      userId: colleague.id,
      role: 'member',
      actorUserId: owner.id,
    });

    // 1. The verdict the pane reads, computed from those rows and nothing else.
    const preview = await accountErasureService.previewAccountErasure(owner.id);
    expect(preview.blocked).toBe(true);

    // 2. The CONTROL that verdict yields. The sibling unit renders this card
    //    from a hand-written preview, which can only ever prove the card obeys
    //    a boolean; here the boolean came out of Postgres.
    const card = await DeleteAccountCard({
      preview,
      email: owner.email,
      projectedErasureDueAt: erasureDueAt(new Date()).toISOString(),
    });
    const trigger = findFirst<{ disabled: boolean }>(card, DeleteAccountTrigger);
    expect(trigger, 'the delete card renders no trigger at all').toBeDefined();
    expect(trigger!.props.disabled).toBe(true);

    // 3. And the door behind it refuses, so a reader who reaches it anyway —
    //    a stale page, a hand-driven POST — writes nothing either.
    signInAs(owner.id, owner.email);
    await expect(scheduleAccountDeletionAction()).resolves.toEqual({
      ok: false,
      code: 'BLOCKED',
    });

    // 4. The assertion that only exists at this altitude: ZERO rows, over the
    //    whole journey. Each step above can be individually right while the
    //    composition still lets a request through, and a request row is what
    //    the erasure sweep acts on thirty days later.
    expect(await adminDb.accountDeletionRequest.count()).toBe(0);

    // The cancel door agrees rather than inventing one to cancel.
    await expect(cancelAccountDeletionAction()).resolves.toEqual({
      ok: false,
      code: 'NONE_OPEN',
    });
    expect(await adminDb.accountDeletionRequest.count()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JOURNEY 3 — schedule → the deadline passes → erased. THREE groups, ONE
//             account, ONE sweep.
// ─────────────────────────────────────────────────────────────────────────────

describe('JOURNEY 3 — the erasure lands all three groups on one account', () => {
  it('DELETES the sole-membership workspace, KEEPS the shared-project comment with the attribution removed, and leaves the billing row UNTOUCHED', async () => {
    const colleague = await createTestUser({ name: 'Remaining Robin' });
    const leaver = await createTestUser({ name: 'Departing Dana' });

    // (a) DELETED — a workspace nobody else is in, with a project in it.
    const { workspace: solo } = await workspacesService.createWorkspace({
      name: 'Personal',
      ownerUserId: leaver.id,
    });
    const soloProject = await createTestProject({
      workspaceId: solo.id,
      actorUserId: leaver.id,
      identifier: 'SOLO',
    });

    // (b) ANONYMISED — a comment in somebody else's project.
    const { workspace: shared } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: colleague.id,
    });
    await workspacesService.addMember({ userId: leaver.id, workspaceId: shared.id });
    const colleagueFx = await fixtureFor(colleague.id, shared.id, 'SHR');
    const leaverFx: WorkItemFixture = {
      ...colleagueFx,
      ownerId: leaver.id,
      ctx: { userId: leaver.id, workspaceId: shared.id },
    };
    const sharedItem = await createTestWorkItem(colleagueFx, {
      kind: 'task',
      title: 'Colleague’s task',
    });
    const comment = await commentsService.addComment(
      sharedItem.id,
      { bodyMd: 'A third party’s project keeps this' },
      leaverFx.ctx,
    );

    // (c) KEPT — the shared organization's billing rows.
    const organizationId = await orgIdOfWorkspace(shared.id);
    await adminDb.organization.update({
      where: { id: organizationId },
      data: { scaledTrackerSubscription: { status: 'active', seats: 2 } },
    });
    const charge = await adminDb.ciPeriodCharge.create({
      data: { organizationId, periodStart: new Date('2026-08-01'), chargedCredits: 1200 },
    });

    // ── the reader schedules it, and the deadline passes ────────────────────
    signInAs(leaver.id, leaver.email);
    const scheduled = await scheduleAccountDeletionAction();
    expect(scheduled.ok).toBe(true);
    await ageUntilDue(scheduled.ok ? scheduled.request.id : '');

    const summary = await accountErasureSweepService.sweep();
    expect(summary).toMatchObject({ scanned: 1, erased: 1, failed: 0 });

    // ── (a) DELETED ─────────────────────────────────────────────────────────
    expect(await adminDb.workspace.count({ where: { id: solo.id } })).toBe(0);
    expect(await adminDb.project.count({ where: { id: soloProject.id } })).toBe(0);

    // ── (b) ANONYMISED — and this is the assertion the separate fixtures
    //        cannot make. The delete above ran in the same sweep, over the same
    //        account, and a delete that reached one row too far would take a
    //        third party's comment with it and leave every single-group suite
    //        green.
    const kept = await adminDb.comment.findUnique({
      where: { id: comment.id },
      include: { author: true },
    });
    expect(kept, 'the shared project’s comment was deleted, not anonymised').not.toBeNull();
    expect(kept!.bodyMd).toBe('A third party’s project keeps this');
    expect(kept!.author.name).toBe(ERASED_USER_NAME);
    expect(await adminDb.workspace.count({ where: { id: shared.id } })).toBe(1);
    expect(await adminDb.workItem.count({ where: { id: sharedItem.id } })).toBe(1);

    // ── (c) KEPT ────────────────────────────────────────────────────────────
    const organization = await adminDb.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    expect(organization.scaledTrackerSubscription).toEqual({ status: 'active', seats: 2 });
    expect(
      (await adminDb.ciPeriodCharge.findUniqueOrThrow({ where: { id: charge.id } })).chargedCredits,
    ).toBe(1200);

    // And the request itself is closed out, so a second sweep has nothing to do.
    expect(
      await adminDb.accountDeletionRequest.count({
        where: { userId: leaver.id, status: 'completed' },
      }),
    ).toBe(1);
  });
});
