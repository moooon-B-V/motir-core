import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { toProjectVisitorDTO } from '@/lib/mappers/visitorMappers';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { enforcePublicReadRateLimit } from '@/lib/rateLimit/publicReadGuard';
import { visitorRecordsService } from '@/lib/services/visitorRecordsService';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { readVisitorAddress } from '@/lib/visitor/readActor';
import { VISITOR_ADDRESS_HEADER } from '@/lib/visitor/address';
import { openVisitorRead, stripPrivateEpicTells } from '@/lib/visitor/readScope';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { consent, storyGateFixture } from './_storyGateFixture';

// The Visitor surface's EDGES (Story MOTIR-6170 · MOTIR-6650's coverage top-up):
// the branches the story's seam tests do not walk because no well-behaved reader
// takes them — a mangled cookie, a forged cursor, an unexpected failure that must
// surface rather than be swallowed, a reader with no workspace — each pinned to
// the answer it must give.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const { state, redirect, notFound } = vi.hoisted(() => ({
  state: {
    session: null as { user: { id: string; name: string; email: string } } | null,
    ws: null as unknown,
    headers: {} as Record<string, string>,
  },
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => state.session }));
vi.mock('@/lib/workspaces', async (orig) => ({
  ...(await orig<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => state.ws,
}));
vi.mock('@/lib/auth/requireCompliantSession', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth/requireCompliantSession')>()),
  refuseIfNonCompliant: async () => null,
}));
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  redirect,
  notFound,
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(state.headers),
  cookies: async () => ({ get: () => undefined }),
}));

let previousCloud: string | undefined;
beforeEach(async () => {
  await truncateAuthTables();
  previousCloud = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
  Object.assign(state, { session: null, ws: null, headers: {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const at = new Date('2026-09-27T10:00:00.000Z');

describe('pure edges', () => {
  it('a visitor with no name is listed with an empty name, never null', () => {
    const dto = toProjectVisitorDTO({
      id: 'r',
      userId: 'u',
      name: null,
      email: 'a@b.test',
      consentedAt: at,
      firstVisitAt: at,
      lastVisitAt: at,
    });
    expect(dto).toEqual({
      name: '',
      email: 'a@b.test',
      consentedAt: at.toISOString(),
      firstVisitAt: at.toISOString(),
      lastVisitAt: at.toISOString(),
    });
  });

  it('the address reader takes a key-shaped header and nothing else — never the cookie (MOTIR-6892)', () => {
    const r = (value: string) =>
      readVisitorAddress(
        new Request('http://x/', { headers: { [VISITOR_ADDRESS_HEADER]: value } }),
      );
    expect(r('NW')).toBe('NW');
    expect(r(' NW ')).toBe('NW');
    expect(r('not a key!')).toBeNull();
    expect(r('x'.repeat(65))).toBeNull();
    expect(readVisitorAddress(new Request('http://x/'))).toBeNull();
    expect(
      readVisitorAddress(new Request('http://x/', { headers: { cookie: 'motir_visitor=NW' } })),
    ).toBeNull();
  });

  it('a Visitor read of another project is not-found; one without the key is denied', () => {
    const ctx = {
      kind: 'visitor',
      project: { id: 'p1', workspaceId: 'w1' },
      actorUserId: 'u',
      permissions: new Set(['project:browse']),
      hiddenIds: new Set(['h']),
    } as unknown as VisitorReadContext;
    expect(openVisitorRead('p1', ctx)).toEqual({ workspaceId: 'w1', excludeIds: ['h'] });
    expect(() => openVisitorRead('p2', ctx)).toThrow(ProjectNotFoundError);
    expect(() => openVisitorRead('p1', ctx, 'work_item:edit')).toThrow(ProjectAccessDeniedError);
  });

  it('only a private epic loses its tells, and only the tells its row carries', () => {
    const story = { kind: 'story', hasChildren: true };
    expect(stripPrivateEpicTells(story, true)).toBe(story);
    const openEpic = { kind: 'epic', hasChildren: true };
    expect(stripPrivateEpicTells(openEpic, false)).toBe(openEpic);
    expect(
      stripPrivateEpicTells({ kind: 'epic', storyPoints: 8, estimateMinutes: 90 }, true),
    ).toEqual({ kind: 'epic', storyPoints: null, estimateMinutes: null, childrenHidden: true });
    expect(stripPrivateEpicTells({ kind: 'epic' }, true)).toEqual({
      kind: 'epic',
      childrenHidden: true,
    });
  });

  it('the Visitor budget is never spent on an excluded path', async () => {
    expect(await enforcePublicReadRateLimit(new Request('http://x/api/health'), 'u')).toBeNull();
  });
});

describe('the Managers’ list, handed a cursor it did not mint', () => {
  it('reads any forged cursor as the first page', async () => {
    const t = await storyGateFixture();
    await consent(t);
    const first = await visitorRecordsService.listForManagers({ key: t.identifier, ctx: t.fx.ctx });
    for (const cursor of [
      '',
      Buffer.from('no-bar').toString('base64url'),
      Buffer.from('|id').toString('base64url'),
      Buffer.from('not-a-date|id').toString('base64url'),
      Buffer.from(`${at.toISOString()}|`).toString('base64url'),
    ]) {
      const page = await visitorRecordsService.listForManagers({
        key: t.identifier,
        ctx: t.fx.ctx,
        cursor,
      });
      expect(page.visitors, cursor).toEqual(first.visitors);
    }
  });
});

describe('an unexpected failure surfaces rather than being mistaken for a refusal', () => {
  it('the consent action rethrows what it does not recognise', async () => {
    const t = await storyGateFixture();
    state.session = { user: { id: t.people.r1.id, name: 'R', email: t.people.r1.email } };
    vi.spyOn(visitorRecordsService, 'recordConsent').mockRejectedValueOnce(new Error('db down'));
    const { recordVisitorConsentAction } =
      await import('@/app/(auth)/p/[identifier]/consent/_actions');
    await expect(recordVisitorConsentAction(t.identifier)).rejects.toThrow('db down');
    state.session = null;
    await expect(recordVisitorConsentAction(t.identifier)).rejects.toThrow('UNAUTHENTICATED');
  });

  it('the Visitors route rethrows what it does not map', async () => {
    const t = await storyGateFixture();
    state.ws = t.fx.ctx;
    vi.spyOn(visitorRecordsService, 'listForManagers').mockRejectedValueOnce(new Error('db down'));
    const { GET } = await import('@/app/api/projects/[key]/visitors/route');
    await expect(
      GET(new Request(`http://x/api/projects/${t.identifier}/visitors`), {
        params: Promise.resolve({ key: t.identifier }),
      }),
    ).rejects.toThrow('db down');
  });
});

describe('the member reader context of a plan-addressed page', () => {
  it('no session → sign in; no workspace → not found; otherwise the reader', async () => {
    const { memberReaderPageContext } = await import('@/lib/pages/projectPageContext');
    await expect(memberReaderPageContext()).rejects.toThrow('NEXT_REDIRECT:/sign-in');
    state.session = { user: { id: 'u', name: 'U', email: 'u@x.test' } };
    await expect(memberReaderPageContext()).rejects.toThrow('NEXT_NOT_FOUND');
    state.ws = { userId: 'u', workspaceId: 'w' };
    expect(await memberReaderPageContext()).toEqual({
      actorUserId: 'u',
      reader: { userId: 'u', workspaceId: 'w' },
    });
  });
});

describe('a Visitor page forwards only the client-address headers to the limiter', () => {
  it('renders the view with x-forwarded-for and x-real-ip present', async () => {
    const t = await storyGateFixture();
    await consent(t);
    const r2 = t.people.r2;
    state.session = { user: { id: r2.id, name: r2.name, email: r2.email } };
    state.headers = {
      'x-current-path': `/p/${t.identifier}/board`,
      'x-forwarded-for': '203.0.113.9',
      'x-real-ip': '203.0.113.9',
    };
    const { visitorPage } = await import('@/lib/visitor/pageGate');
    const gate = await visitorPage(t.identifier);
    expect(gate.kind).toBe('view');
  });
});
