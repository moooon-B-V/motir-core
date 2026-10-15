import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { runAsCloudBuild } from '../../helpers/cloudBuild';
import { truncateAuthTables } from '../../helpers/db';
import { setProjectAccess } from '@/tests/helpers/projectAccess';

// Story MOTIR-7732 · MOTIR-8105 — `POST /api/public/p/{identifier}/subscribe`
// records the language of the page the visitor subscribed from: the body's
// `locale` when it is one of the eleven, else the request's own language. The
// answer stays the same 202 with no body whatever happened (the enumeration
// rule). Real Postgres through the real service; the mocks are the session (no
// cookies here), the job dispatcher, the rate limiter, and the request-language
// reader the fallback consults.

runAsCloudBuild();

vi.mock('@/lib/auth', () => ({ getSession: vi.fn(async () => null) }));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/rateLimit/publicFollowGuard', () => ({
  enforcePublicFollowRateLimit: vi.fn(async () => null),
}));
const requestLocale = vi.hoisted(() => ({ value: 'ko' }));
vi.mock('@/lib/i18n/serverLocale', () => ({
  currentLocale: vi.fn(async () => requestLocale.value),
}));

const { POST } = await import('@/app/api/public/p/[identifier]/subscribe/route');

let fx: WorkItemFixture;

beforeEach(async () => {
  vi.stubEnv('EMAIL_PROVIDER', 'resend');
  requestLocale.value = 'ko';
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
  await setProjectAccess(adminDb, fx.projectId, 'public');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await adminDb.$disconnect();
});

function subscribe(body: unknown): Promise<Response> {
  return POST(
    new Request(`https://app.motir.co/api/public/p/${fx.projectIdentifier}/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ identifier: fx.projectIdentifier }) },
  );
}

async function expectEmpty202(res: Response): Promise<void> {
  expect(res.status).toBe(202);
  expect(await res.text()).toBe('');
}

describe('the subscribe route records the page language', () => {
  it('stores the language the body names', async () => {
    await expectEmpty202(await subscribe({ email: 'reader@example.com', locale: 'ja' }));
    expect((await adminDb.publicFollow.findFirstOrThrow()).locale).toBe('ja');
  });

  it('stores the request’s language when the body names none', async () => {
    await expectEmpty202(await subscribe({ email: 'reader@example.com' }));
    expect((await adminDb.publicFollow.findFirstOrThrow()).locale).toBe('ko');
  });

  it('stores the request’s language when the body names one that is not of the eleven', async () => {
    await expectEmpty202(await subscribe({ email: 'reader@example.com', locale: 'xx' }));
    expect((await adminDb.publicFollow.findFirstOrThrow()).locale).toBe('ko');
  });

  it('answers an already-subscribed address exactly as a new one', async () => {
    const first = await subscribe({ email: 'reader@example.com', locale: 'ja' });
    const again = await subscribe({ email: 'reader@example.com', locale: 'de' });
    await expectEmpty202(first);
    await expectEmpty202(again);
  });
});
