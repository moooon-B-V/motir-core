import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { InvalidRoadmapCursorError } from '@/lib/publicProjects/roadmapCursor';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { publicRequestsService } from '@/lib/services/publicRequestsService';
import {
  VisitorConsentRequiredError,
  VisitorEntersProjectError,
  VisitorSignInRequiredError,
} from '@/lib/visitor/errors';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import { waitForWindowHeadroom } from '@/tests/helpers/rateLimitWindow';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateRateLimitCounters } from '../helpers/db';
import { consentedVisitor } from './_consentedVisitor';

// A public project's PENDING requests, as its Visitor reads them in Requested
// features (Story MOTIR-6171 · MOTIR-6768; `public-request-board-retired.md`
// Decision 2). The set is the retired motir.co board's "Submitted" column —
// in triage, attributed, not archived, not done, not snoozed — ordered by votes;
// the reader is settled by `resolveVisitor`; people are named, never emailed.
// Real datastore throughout; the only stub is the session.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));

const { GET } = await import('@/app/api/p/[identifier]/requests/route');

let previousCloud: string | undefined;
const READ_WINDOW_MS = 20_000;
const READ_HEADROOM_MS = 10_000;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  previousCloud = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'];
  session.current = null;
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'];
  delete process.env['MOTIR_PUBLIC_READ_RATE_LIMIT_WINDOW_MS'];
  __resetSharedRateLimitStoreForTest();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function person(name: string) {
  seq += 1;
  return adminDb.user.create({
    data: { email: `pr-${Date.now()}-${seq}@example.com`, name, emailVerified: true },
  });
}

/** A PUBLIC project (the precondition every read here is about). */
async function publicProject() {
  const identifier = `VPR${seq++}`;
  const fx = await makeWorkItemFixture({ name: `VPR ${identifier}`, identifier });
  await adminDb.project.update({ where: { id: fx.projectId }, data: projectAccessData('public') });
  return { fx, identifier };
}

type Fx = Awaited<ReturnType<typeof publicProject>>['fx'];

/** A request filed by `submitterId`, in triage, at a live status, `minutesAgo` old. */
async function request(
  fx: Fx,
  title: string,
  submitterId: string | null,
  patch: Record<string, unknown> = {},
  minutesAgo = 0,
) {
  const item = await createTestWorkItem(fx, { kind: 'task', title });
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      triagedAt: at,
      submittedByUserId: submitterId,
      status: 'todo',
      ...patch,
    },
  });
  return item;
}

async function vote(workItemId: string, userIds: string[]) {
  for (const userId of userIds) {
    await adminDb.publicRequestVote.create({ data: { workItemId, userId } });
  }
}

const req = (identifier: string, cursor?: string) =>
  new Request(
    `http://localhost:3000/api/p/${identifier}/requests${cursor ? `?cursor=${cursor}` : ''}`,
  );
const params = (identifier: string) => ({ params: Promise.resolve({ identifier }) });

function signIn(user: { id: string }) {
  session.current = { user: { id: user.id, email: 'reader@example.com', name: 'Reader' } };
}

describe('listPendingForVisitor — the set, the order and the reader’s own vote', () => {
  it('returns only the active, attributed triage items, by votes then recency', async () => {
    const { fx, identifier } = await publicProject();
    const ann = await person('Ann Submitter');
    const nameless = await person('   ');
    const [v1, v2, v3] = [await person('V1'), await person('V2'), await person('V3')];

    const top = await request(fx, 'Two votes', ann.id, {}, 30);
    const newer = await request(fx, 'One vote, newer', nameless.id, {}, 5);
    const older = await request(fx, 'One vote, older', ann.id, {}, 20);
    const none = await request(fx, 'No votes', ann.id, {}, 1);
    await request(fx, 'Snoozed', ann.id, { snoozedUntil: new Date(Date.now() + 3_600_000) });
    await request(fx, 'Declined', ann.id, { status: 'done' });
    await request(fx, 'Archived', ann.id, { archivedAt: new Date() });
    await request(fx, 'Unattributed', null);
    const promoted = await createTestWorkItem(fx, { kind: 'task', title: 'Promoted' });
    await adminDb.workItem.update({
      where: { id: promoted.id },
      data: { submittedByUserId: ann.id, status: 'todo' },
    });
    await vote(top.id, [v1.id, v2.id]);
    await vote(newer.id, [v3.id]);
    await vote(older.id, [v1.id]);

    const ctx = await consentedVisitor(identifier);
    await vote(older.id, [ctx.actorUserId]);

    const page = await publicRequestsService.listPendingForVisitorContext(ctx);
    // The reader's own vote lifts `older` to 2, tying `top`; the tie goes to the
    // more recently triaged (20 min ago beats 30), then `newer` at 1, then 0.
    expect(page.items.map((r) => r.title)).toEqual([
      'One vote, older',
      'Two votes',
      'One vote, newer',
      'No votes',
    ]);
    expect(page.total).toBe(4);
    expect(page.nextCursor).toBeNull();
    expect(page.items.find((r) => r.id === older.id)).toMatchObject({ voteCount: 2, voted: true });
    expect(page.items.find((r) => r.id === top.id)).toMatchObject({ voteCount: 2, voted: false });
    expect(page.items.find((r) => r.id === none.id)).toMatchObject({ voteCount: 0, voted: false });
    // Name only: the display name, or the neutral label — never an address.
    expect(page.items.find((r) => r.id === top.id)!.submitterName).toBe('Ann Submitter');
    expect(page.items.find((r) => r.id === newer.id)!.submitterName).toBe('Project member');
    expect(JSON.stringify(page)).not.toContain('@');
    expect(page.items[1]!.identifier).toBe(`${identifier}-${top.key}`);
  });

  it('pages twenty at a time by an opaque cursor, and refuses a malformed one', async () => {
    const { fx, identifier } = await publicProject();
    const ann = await person('Ann');
    for (let i = 0; i < 22; i += 1) await request(fx, `R${i}`, ann.id, {}, i);
    const ctx = await consentedVisitor(identifier);

    const first = await publicRequestsService.listPendingForVisitorContext(ctx);
    expect(first.items).toHaveLength(20);
    expect(first.total).toBe(22);
    expect(first.nextCursor).not.toBeNull();
    const second = await publicRequestsService.listPendingForVisitorContext(ctx, first.nextCursor!);
    expect(second.items.map((r) => r.title)).toEqual(['R20', 'R21']);
    expect(second.nextCursor).toBeNull();
    const seen = new Set([...first.items, ...second.items].map((r) => r.id));
    expect(seen.size).toBe(22);

    await expect(
      publicRequestsService.listPendingForVisitorContext(ctx, 'not-a-cursor'),
    ).rejects.toBeInstanceOf(InvalidRoadmapCursorError);
    const badInstant = Buffer.from(JSON.stringify([1, 'not-a-date', 'x'])).toString('base64url');
    await expect(
      publicRequestsService.listPendingForVisitorContext(ctx, badInstant),
    ).rejects.toBeInstanceOf(InvalidRoadmapCursorError);
  });
});

describe('listPendingForVisitor — only a consented Visitor is served', () => {
  it('serves the Visitor, and names every other verdict', async () => {
    const { fx, identifier } = await publicProject();
    const ann = await person('Ann');
    await request(fx, 'Pending', ann.id);

    const ctx = await consentedVisitor(identifier);
    const served = await publicRequestsService.listPendingForVisitor(identifier, {
      user: { id: ctx.actorUserId },
    });
    expect(served.items.map((r) => r.title)).toEqual(['Pending']);

    await expect(
      publicRequestsService.listPendingForVisitor(identifier, null),
    ).rejects.toBeInstanceOf(VisitorSignInRequiredError);
    const stranger = await person('Not yet consented');
    await expect(
      publicRequestsService.listPendingForVisitor(identifier, { user: { id: stranger.id } }),
    ).rejects.toBeInstanceOf(VisitorConsentRequiredError);
    await expect(
      publicRequestsService.listPendingForVisitor(identifier, { user: { id: fx.ownerId } }),
    ).rejects.toBeInstanceOf(VisitorEntersProjectError);
    await expect(
      publicRequestsService.listPendingForVisitor('NOPE-XYZ', { user: { id: stranger.id } }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('a project that is not public is not found, whoever asks', async () => {
    const identifier = `VPRP${seq++}`;
    await makeWorkItemFixture({ name: 'Private', identifier });
    const stranger = await person('Stranger');
    await expect(
      publicRequestsService.listPendingForVisitor(identifier, { user: { id: stranger.id } }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('GET /api/p/[identifier]/requests — the "Load more" door', () => {
  it('serves a consented Visitor the page, with no email anywhere', async () => {
    const { fx, identifier } = await publicProject();
    const ann = await person('Ann');
    await request(fx, 'Pending', ann.id);
    const ctx = await consentedVisitor(identifier);
    signIn({ id: ctx.actorUserId });

    const res = await GET(req(identifier), params(identifier));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((r: { title: string }) => r.title)).toEqual(['Pending']);
    expect(body.total).toBe(1);
    expect(JSON.stringify(body)).not.toContain('@');
  });

  it('answers each refusal by name, in the resolver’s order', async () => {
    const { fx, identifier } = await publicProject();
    const privateId = `VPRQ${seq++}`;
    await makeWorkItemFixture({ name: 'Private', identifier: privateId });

    // No session: a public project asks to sign in; a private one is not found.
    expect((await GET(req(identifier), params(identifier))).status).toBe(401);
    const hidden = await GET(req(privateId), params(privateId));
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ code: 'PROJECT_NOT_FOUND' });

    // Signed in, not consented.
    signIn(await person('Not yet'));
    const consent = await GET(req(identifier), params(identifier));
    expect(consent.status).toBe(403);
    expect(await consent.json()).toEqual({ code: 'VISITOR_CONSENT_REQUIRED' });

    // A member: pointed at their own inbox.
    signIn({ id: fx.ownerId });
    const member = await GET(req(identifier), params(identifier));
    expect(member.status).toBe(409);
    expect(await member.json()).toEqual({
      code: 'VISITOR_ENTERS_PROJECT',
      href: '/requested-features',
    });

    // Cloud off: not found, even for a consented Visitor.
    const ctx = await consentedVisitor(identifier);
    signIn({ id: ctx.actorUserId });
    process.env['MOTIR_CLOUD'] = 'false';
    expect((await GET(req(identifier), params(identifier))).status).toBe(404);
    process.env['MOTIR_CLOUD'] = 'true';

    // A malformed cursor is a 400, not the first page.
    const bad = await GET(req(identifier, 'garbage'), params(identifier));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ code: 'INVALID_ROADMAP_CURSOR' });
  });

  it('answers 429 once the Visitor has spent their read budget', async () => {
    process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'] = '2';
    process.env['MOTIR_PUBLIC_READ_RATE_LIMIT_WINDOW_MS'] = String(READ_WINDOW_MS);
    const { identifier } = await publicProject();
    const ctx = await consentedVisitor(identifier);
    signIn({ id: ctx.actorUserId });
    await waitForWindowHeadroom(READ_WINDOW_MS, READ_HEADROOM_MS);
    expect((await GET(req(identifier), params(identifier))).status).toBe(200);
    expect((await GET(req(identifier), params(identifier))).status).toBe(200);
    const refused = await GET(req(identifier), params(identifier));
    expect(refused.status).toBe(429);
    expect(refused.headers.get('Retry-After')).toBeTruthy();
  });
});
