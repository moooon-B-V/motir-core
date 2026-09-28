import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The Visitor's consent screen, end to end through the real resolver and
// datastore (Story MOTIR-6170 · MOTIR-6669): each verdict's branch on the page,
// and the Continue action — one record, never for Go back (which writes nothing
// and has no server path), refused for a member.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const { getSession, redirect, notFound, headerStore } = vi.hoisted(() => ({
  getSession: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
  headerStore: { referer: null as string | null },
}));
vi.mock('@/lib/auth', () => ({ getSession }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  redirect,
  notFound,
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers(headerStore.referer ? { referer: headerStore.referer } : {}),
}));

let previousCloud: string | undefined;
beforeEach(async () => {
  await truncateAuthTables();
  previousCloud = process.env['MOTIR_CLOUD'];
  process.env['MOTIR_CLOUD'] = 'true';
  getSession.mockReset();
  redirect.mockClear();
  notFound.mockClear();
  headerStore.referer = null;
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function publicProject(mode: 'public' | 'members' = 'public') {
  const identifier = `CS${seq++}`;
  const fx = await makeWorkItemFixture({ name: `CS ${identifier}`, identifier });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { accessMode: mode, accessLevel: mode === 'public' ? 'public' : 'private' },
  });
  return { fx, identifier };
}
async function stranger(name = 'Riya Sen') {
  const n = seq++;
  return adminDb.user.create({
    data: { email: `riya-${n}@example.com`, name, emailVerified: true },
  });
}
const sessionOf = (u: { id: string; name: string; email: string }) => ({
  user: { id: u.id, name: u.name, email: u.email },
});

async function renderPage(identifier: string, next?: string) {
  const { default: Page } = await import('@/app/(auth)/p/[identifier]/consent/page');
  return Page({
    params: Promise.resolve({ identifier }),
    searchParams: Promise.resolve(next === undefined ? {} : { next }),
  });
}

describe('the page, verdict by verdict', () => {
  it('not_found — a private project is a 404 whether or not the reader is signed in', async () => {
    const { identifier } = await publicProject('members');
    getSession.mockResolvedValue(null);
    await expect(renderPage(identifier)).rejects.toThrow('NEXT_NOT_FOUND');
    const u = await stranger();
    getSession.mockResolvedValue(sessionOf(u));
    await expect(renderPage(identifier)).rejects.toThrow('NEXT_NOT_FOUND');
    await expect(renderPage('NOPE404')).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('sign_in — sends a signed-out reader to sign in, carrying the consent screen and its view', async () => {
    const { identifier } = await publicProject();
    getSession.mockResolvedValue(null);
    const next = `/p/${identifier}/roadmap`;
    await expect(renderPage(identifier, next)).rejects.toThrow(
      `NEXT_REDIRECT:/sign-in?next=${encodeURIComponent(
        `/p/${identifier}/consent?next=${encodeURIComponent(next)}`,
      )}`,
    );
  });

  it('enter — a member is sent straight on to the view and never asked', async () => {
    const { fx, identifier } = await publicProject();
    const owner = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
    getSession.mockResolvedValue(sessionOf(owner));
    await expect(renderPage(identifier, `/p/${identifier}/board`)).rejects.toThrow(
      `NEXT_REDIRECT:/p/${identifier}/board`,
    );
  });

  it('consent — renders the card with the subject, the reader’s own identity and a validated destination', async () => {
    const { fx, identifier } = await publicProject();
    const u = await stranger();
    getSession.mockResolvedValue(sessionOf(u));
    const element = (await renderPage(identifier, 'https://evil.example')) as {
      props: Record<string, unknown>;
    };
    expect(element.props).toMatchObject({
      identifier,
      projectName: fx.project.name,
      workspaceName: fx.workspace.name,
      reader: { name: 'Riya Sen', email: u.email },
      destination: `/p/${identifier}/board`,
      goBackHref: '/',
    });
  });

  it('visitor — a reader who already agreed is sent on without being asked again', async () => {
    const { identifier } = await publicProject();
    const u = await stranger();
    getSession.mockResolvedValue(sessionOf(u));
    const { recordVisitorConsentAction } =
      await import('@/app/(auth)/p/[identifier]/consent/_actions');
    expect(await recordVisitorConsentAction(identifier)).toEqual({ ok: true });
    await expect(renderPage(identifier, `/p/${identifier}/plans`)).rejects.toThrow(
      `NEXT_REDIRECT:/p/${identifier}/plans`,
    );
  });
});

describe('Continue', () => {
  async function action() {
    return (await import('@/app/(auth)/p/[identifier]/consent/_actions'))
      .recordVisitorConsentAction;
  }

  it('writes ONE record however often it is pressed, for the session’s own user', async () => {
    const { fx, identifier } = await publicProject();
    const u = await stranger();
    getSession.mockResolvedValue(sessionOf(u));
    const record = await action();
    expect(await record(identifier)).toEqual({ ok: true });
    expect(await record(identifier)).toEqual({ ok: true });
    const rows = await adminDb.projectVisitor.findMany({ where: { projectId: fx.projectId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(u.id);
  });

  it('is refused for a member, with nothing written', async () => {
    const { fx, identifier } = await publicProject();
    const owner = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
    getSession.mockResolvedValue(sessionOf(owner));
    expect(await (await action())(identifier)).toEqual({ ok: false, reason: 'member' });
    expect(await adminDb.projectVisitor.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('answers not_found for a project that is no longer public, with nothing written', async () => {
    const { fx, identifier } = await publicProject('members');
    const u = await stranger();
    getSession.mockResolvedValue(sessionOf(u));
    expect(await (await action())(identifier)).toEqual({ ok: false, reason: 'not_found' });
    expect(await adminDb.projectVisitor.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('refuses a signed-out caller', async () => {
    const { identifier } = await publicProject();
    getSession.mockResolvedValue(null);
    await expect((await action())(identifier)).rejects.toThrow('UNAUTHENTICATED');
  });

  it('Go back writes nothing — a reader who only opened the screen has no record', async () => {
    const { fx, identifier } = await publicProject();
    const u = await stranger();
    getSession.mockResolvedValue(sessionOf(u));
    await renderPage(identifier);
    expect(await adminDb.projectVisitor.count({ where: { projectId: fx.projectId } })).toBe(0);
  });
});
