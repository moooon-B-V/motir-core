import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { truncateRateLimitCounters } from '@/tests/helpers/db';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { pinSharedRateLimitStoreDeadline } from '@/tests/helpers/rateLimitStore';
import { waitForWindowHeadroom } from '@/tests/helpers/rateLimitWindow';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { consentedVisitor } from './_consentedVisitor';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { VISITOR_ADDRESS_HEADER } from '@/lib/visitor/address';

// MOTIR-6890 — the Plans list's LOAD-MORE for a Visitor. `/p/<identifier>/plans`
// renders the shared list, whose later pages stream through
// `loadMoreSessionsAction`. The action used to read the reader's OWN active
// project, so a signed-in stranger who has a project of their own scrolled the
// public project's list into their own rows (or an empty page). Driven here as the
// browser drives it: the Visitor tab's `x-motir-visitor` address (MOTIR-6892), the
// reader's session, an active project that is NOT the public one, and the real
// resolver and datastore.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };
const incoming = { current: new Headers() };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
vi.mock('next/headers', () => ({
  headers: async () => incoming.current,
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  getFormatter: async () => ({ relativeTime: (d: Date) => d.toISOString() }),
  getLocale: async () => 'en',
}));

const { loadMoreSessionsAction } = await import('@/app/(authed)/plans/_actions');

// A cursor positioned before every row — the shape `encodeCursor` mints, so the
// action is asked for "the page after this one" exactly as the sentinel asks.
const CURSOR = Buffer.from('2999-01-01T00:00:00.000Z|zzzzzzzz', 'utf8').toString('base64url');

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
  activeCtx.current = null;
  incoming.current = new Headers();
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

/** A session whose one plan touches `workItemId` (or nothing). */
async function sessionIn(
  fx: { workspaceId: string; projectId: string },
  title: string,
  workItemId?: string,
) {
  const base = { workspaceId: fx.workspaceId, projectId: fx.projectId };
  const s = await adminDb.planChangeSession.create({ data: { ...base, targetKeys: [] } });
  const p = await adminDb.plan.create({
    data: { ...base, sessionId: s.id, status: 'planned', title },
  });
  if (workItemId) {
    await adminDb.planItem.create({
      data: { workspaceId: fx.workspaceId, planId: p.id, op: 'modify', workItemId },
    });
  }
  return s.id;
}

/**
 * A public project with a visible session and one touching a private epic's
 * descendant; and a signed-in, consented Visitor of it whose ACTIVE project is a
 * project of their own, holding a session of its own.
 */
async function scene() {
  const identifier = `PL${seq++}`;
  const pub = await makeWorkItemFixture({ name: `Public ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: pub.projectId },
    data: projectAccessData('public'),
  });
  const E = await createTestWorkItem(pub, { kind: 'epic', title: 'Private epic' });
  const C = await createTestWorkItem(pub, { kind: 'story', title: 'Hidden C', parentId: E.id });
  const V = await createTestWorkItem(pub, { kind: 'story', title: 'Visible V' });
  await adminDb.workItem.update({ where: { id: E.id }, data: { publicChildrenHidden: true } });
  const visible = await sessionIn(pub, 'Public plan on V', V.id);
  const hidden = await sessionIn(pub, 'Public plan on hidden C', C.id);

  const visitor = await consentedVisitor(identifier);
  const own = await makeWorkItemFixture({ name: `Own ${identifier}`, identifier: `OW${seq++}` });
  await adminDb.workspaceMembership.create({
    data: {
      userId: visitor.actorUserId,
      workspaceId: own.workspaceId,
      workspaceRole: 'member',
      accessScope: 'full',
    },
  });
  const ownSession = await sessionIn(own, 'My own plan');

  session.current = { user: { id: visitor.actorUserId, email: 'stranger@example.com', name: 'S' } };
  incoming.current = new Headers({ [VISITOR_ADDRESS_HEADER]: identifier });
  activeCtx.current = {
    userId: visitor.actorUserId,
    workspaceId: own.workspaceId,
    projectId: own.projectId,
    project: own.project as unknown as ProjectContext['project'],
  };
  return { visible, hidden, ownSession };
}

describe('a Visitor’s Plans load-more streams the public project it is viewing', () => {
  it('serves the viewed project’s rows, never the reader’s own active project', async () => {
    const s = await scene();

    const out = await loadMoreSessionsAction(CURSOR, null, 'project');

    expect('error' in out).toBe(false);
    if ('error' in out) return;
    const ids = out.views.map((v) => v.id);
    expect(ids).toContain(s.visible);
    expect(ids).not.toContain(s.ownSession);
    // A plan touching a private epic's descendant is withheld, as on page one.
    expect(ids).not.toContain(s.hidden);
    expect(out.nextCursor).toBeNull();
    // Names only (MOTIR-6646): nothing on a streamed row carries an address.
    expect(JSON.stringify(out.views)).not.toContain('@');
  });

  it('serves the Project view even when asked for Mine — a Visitor has no Mine tab', async () => {
    const s = await scene();

    const out = await loadMoreSessionsAction(CURSOR, null, 'mine');

    expect('error' in out ? [] : out.views.map((v) => v.id)).toEqual([s.visible]);
  });

  it('a Visitor past the read budget gets the rate-limited answer, not an empty page', async () => {
    process.env['MOTIR_PUBLIC_READ_RATE_LIMIT'] = '1';
    process.env['MOTIR_PUBLIC_READ_RATE_LIMIT_WINDOW_MS'] = String(READ_WINDOW_MS);
    await scene();
    await waitForWindowHeadroom(READ_WINDOW_MS, READ_HEADROOM_MS);

    const first = await loadMoreSessionsAction(CURSOR, null, 'project');
    expect('error' in first).toBe(false);
    expect(await loadMoreSessionsAction(CURSOR, null, 'project')).toEqual({
      ok: false,
      error: 'rate_limited',
    });
  });

  it('without the address the same reader is served their own active project, as today', async () => {
    const s = await scene();
    incoming.current = new Headers();

    const out = await loadMoreSessionsAction(CURSOR, null, 'project');

    expect('error' in out ? [] : out.views.map((v) => v.id)).toEqual([s.ownSession]);
  });
});
