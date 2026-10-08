// @vitest-environment happy-dom
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFormatter, createTranslator } from 'next-intl';
import type { EnterpriseRequestStatus } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import en from '@/messages/en.json';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { platformEnterpriseRequestService } from '@/lib/services/platformEnterpriseRequestService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { renderToHtml } from '../helpers/serverPageHarness';

// THE CONSOLE'S ENTERPRISE REQUESTS PAGES (Story MOTIR-7602 · MOTIR-7609) — the
// list and the detail, rendered over the REAL store through the REAL server
// actions and service, with the REAL `en` catalogue: the session is the one
// thing mocked (CLAUDE.md's single allowance), so the page gate, the service's
// role checks, the audit rows and the reads all run for real.
//
// Pinned: the default Open filter newest first, a state filter from the URL,
// cursor paging with its range, the never-any empty state, a bad cursor as the
// error card, the detail with its org link and its History from the audit rows,
// the operator's legal moves vs. support's read-only line, a move re-read, and
// the 404s (an unknown id, a non-staff viewer).

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

let currentSession: { user: { id: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  notFound: () => {
    throw new NotFoundSentinel();
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: en, namespace: namespace as 'platformAdmin' }),
  getFormatter: async () => createFormatter({ locale: 'en', timeZone: 'UTC' }),
}));

const { default: ListPage } = await import('@/app/(admin)/admin/enterprise-requests/page');
const { default: DetailPage } = await import('@/app/(admin)/admin/enterprise-requests/[id]/page');

let seq = 0;

beforeEach(async () => {
  currentSession = null;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

afterAll(async () => {
  await truncateAuthTables();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function signInAs(role: 'support' | 'operator' | 'superadmin'): Promise<PlatformPrincipal> {
  const user = await createTestUser({ email: `ops+er-page-${role}-${++seq}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  currentSession = { user: { id: user.id } };
  return { userId: user.id, email: user.email, role };
}

async function seedRequest(
  name: string,
  status: EnterpriseRequestStatus = 'new',
  createdAt = new Date(),
) {
  const owner = await createTestUser({ email: `owner-er-page-${++seq}@example.com` });
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  return adminDb.enterpriseRequest.create({
    data: {
      organizationId: workspace.organizationId,
      requestedById: owner.id,
      status,
      contact: `buyer@${name.toLowerCase()}.example`,
      note: `${name} would like a call.`,
      cardsPerDay: 40,
      parallelAgents: 8,
      agentPath: 'both',
      tierKeyAtRequest: 'team',
      createdAt,
      closedAt: status === 'won' || status === 'lost' ? createdAt : null,
    },
  });
}

function decode(html: string): string {
  return html
    .replace(/<!-- -->/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The rendered text, tags dropped — for copy that interpolates a `<b>`. */
function text(html: string): string {
  // Repeated until stable, so a tag split by another tag cannot survive a pass.
  let out = html;
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/<[^>]*>/g, '');
  }
  return out;
}

async function list(params: Record<string, string> = {}): Promise<string> {
  return decode(await renderToHtml(await ListPage({ searchParams: Promise.resolve(params) })));
}

async function detail(id: string): Promise<string> {
  return decode(await renderToHtml(await DetailPage({ params: Promise.resolve({ id }) })));
}

describe('the list', () => {
  it('shows the open requests newest first, with the count and the segment counts', async () => {
    await seedRequest('Initech', 'contacted', new Date('2026-09-28T10:00:00Z'));
    await seedRequest('Acme', 'new', new Date('2026-10-05T10:00:00Z'));
    await seedRequest('Hooli', 'lost', new Date('2026-08-30T10:00:00Z'));
    await signInAs('support');

    const html = await list();
    expect(text(html)).toContain('Newest first. 2 open — new, contacted or offer sent.');
    expect(html.indexOf('Acme')).toBeLessThan(html.indexOf('Initech'));
    expect(html).not.toContain('Hooli');
    expect(html).toContain('on Team when sent');
    expect(html).toContain('1–2 of 2');
    // The lost request is counted on its segment even though it is not listed.
    expect(html).toMatch(/Lost<span[^>]*>1<\/span>/);
  });

  it('filters by the state in the URL, and an unknown state is the default view', async () => {
    await seedRequest('Acme', 'new');
    await seedRequest('Hooli', 'lost');
    await signInAs('operator');

    const lost = await list({ state: 'lost' });
    expect(text(lost)).toContain('Newest first. 1 lost.');
    expect(lost).toContain('Hooli');
    expect(lost).not.toContain('>Acme<');

    const won = await list({ state: 'won' });
    expect(won).toContain('No won requests');
    expect(won).toContain('Show open requests');

    expect(text(await list({ state: 'bogus' }))).toContain('Newest first. 1 open');
  });

  it('pages by cursor, 50 a page: Older carries the cursor and the next page counts on', async () => {
    const base = Date.parse('2026-10-01T00:00:00Z');
    for (let i = 0; i < 51; i++) {
      await seedRequest(`Org${String(i).padStart(2, '0')}`, 'new', new Date(base + i * 60_000));
    }
    await signInAs('support');

    const first = await list();
    expect(first).toContain('1–50 of 51');
    const cursor = /\/admin\/enterprise-requests\?c=([a-z0-9]+)/i.exec(first)?.[1];
    expect(cursor).toBeTruthy();
    expect(first).not.toContain('>Org00<');

    const second = await list({ c: cursor! });
    expect(second).toContain('51–51 of 51');
    expect(second).toContain('>Org00<');
    expect(second).toContain('href="/admin/enterprise-requests"');
  });

  it('nothing ever sent is the never-any state, without a filter', async () => {
    await signInAs('support');
    const html = await list();
    expect(html).toContain('No enterprise requests yet');
    // The loading frame (which paints the filter) precedes the resolved body in
    // the complete document; the body itself is the bare empty state.
    expect(html).toContain('data-testid="enterprise-requests-empty"');
    expect(html).not.toContain('data-testid="enterprise-requests-no-match"');
    expect(html).not.toContain('data-testid="enterprise-requests-table"');
  });

  it('a cursor the service did not issue is the error card with Retry', async () => {
    await seedRequest('Acme');
    await signInAs('support');
    const html = await list({ c: 'cmnotarealrequestid000' });
    expect(html).toContain('Couldn’t load the requests');
    expect(html).toContain('Retry');
  });
});

describe('the detail', () => {
  it('an operator: the request, the org link, History from the audit rows, the legal moves', async () => {
    const row = await seedRequest('Acme', 'new');
    const operator = await signInAs('operator');
    await platformEnterpriseRequestService.transition(operator, row.id, {
      organizationId: row.organizationId,
      from: 'new',
      to: 'contacted',
    });

    const html = await detail(row.id);
    expect(html).toContain('Acme would like a call.');
    expect(html).toContain(`href="/admin/tenants/${row.organizationId}"`);
    expect(html).toContain('Open Acme in Tenants');
    expect(html).toContain('Sent as');
    expect(html).toContain(operator.email);
    expect(html).toContain('Mark offer sent');
    expect(html).toContain('Mark lost');
    expect(html).not.toContain('Mark contacted');
    expect(html).not.toContain('Read-only for support.');
  });

  it('a support viewer reads everything and moves nothing', async () => {
    const row = await seedRequest('Acme', 'contacted');
    await signInAs('support');
    const html = await detail(row.id);
    expect(html).toContain('Read-only for support.');
    expect(html).not.toContain('Mark offer sent');
    expect(html).not.toContain('Mark lost');
  });

  it('a closed request offers no move to an operator', async () => {
    const row = await seedRequest('Acme', 'won');
    await signInAs('superadmin');
    const html = await detail(row.id);
    expect(html).toContain('Closed as Won on');
    expect(html).not.toContain('Mark lost');
  });

  it('an unknown id is the app 404', async () => {
    await signInAs('operator');
    await expect(detail('cmnosuchrequest00000000')).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  it('a non-staff viewer gets the 404 on both routes', async () => {
    const row = await seedRequest('Acme');
    const user = await createTestUser({ email: `not-staff-${++seq}@example.com` });
    currentSession = { user: { id: user.id } };
    await expect(list()).rejects.toBeInstanceOf(NotFoundSentinel);
    await expect(detail(row.id)).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  // MOTIR-7610 (the story's integration gate): the detail's other two outcomes
  // of a read that did not succeed. A store fault is the error card, never a
  // thrown digest; a principal the service refuses after the page gate let the
  // session through is the same 404 as a non-staff viewer.
  it('a read that fails is the error card; one the service refuses is the 404', async () => {
    const row = await seedRequest('Acme');
    await signInAs('operator');
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const get = vi.spyOn(platformEnterpriseRequestService, 'get');
    get.mockRejectedValueOnce(new Error('db down'));
    const html = await detail(row.id);
    expect(html).toContain('Couldn’t load the requests');
    expect(html).not.toContain('Acme would like a call.');

    const { NotPlatformStaffError } = await import('@/lib/platform/errors');
    get.mockRejectedValueOnce(new NotPlatformStaffError());
    await expect(detail(row.id)).rejects.toBeInstanceOf(NotFoundSentinel);
    get.mockRestore();
    quiet.mockRestore();
  });
});
