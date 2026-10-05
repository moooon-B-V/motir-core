import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `lib/platform/pageGate.ts` — the staff gate as a rendered `(admin)` route
// answers it (MOTIR-7613).
//
// The defect: Next renders the `(admin)` layout and its page CONCURRENTLY, so an
// anonymous `GET /admin/ai-planning` got the layout's 404 while the page's own
// `requirePlatformStaff` threw `NotPlatformStaffError` with nothing to catch it
// — an unhandled error in production's monitor for every probe. A page's gate
// must answer `notFound()` itself, and this suite pins that for the gate, for
// the route the monitor reported, and for every page and layout in the group.

class NotFoundSentinel extends Error {
  constructor() {
    super('NEXT_NOT_FOUND');
  }
}

let currentSession: { user: { id: string } } | null = null;

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  notFound: vi.fn(() => {
    throw new NotFoundSentinel();
  }),
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  getTranslations: vi.fn(async () => (key: string) => key),
}));

beforeEach(async () => {
  vi.resetModules();
  currentSession = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function staffUser(role: 'support' | 'operator' | 'superadmin') {
  const user = await createTestUser({ email: `${role}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return user;
}

describe('requirePlatformStaffPage', () => {
  it('answers notFound() for an anonymous request — never NotPlatformStaffError', async () => {
    const { requirePlatformStaffPage } = await import('@/lib/platform/pageGate');
    await expect(requirePlatformStaffPage()).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  it('answers notFound() for a signed-in user with no platform role', async () => {
    const user = await createTestUser({ email: 'owner@customer.test' });
    currentSession = { user: { id: user.id } };
    const { requirePlatformStaffPage } = await import('@/lib/platform/pageGate');
    await expect(requirePlatformStaffPage()).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  it('answers notFound() for staff below the minimum', async () => {
    currentSession = { user: { id: (await staffUser('support')).id } };
    const { requirePlatformStaffPage } = await import('@/lib/platform/pageGate');
    await expect(requirePlatformStaffPage('superadmin')).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  it('returns the principal for staff at or above the minimum', async () => {
    const staff = await staffUser('operator');
    currentSession = { user: { id: staff.id } };
    const { requirePlatformStaffPage } = await import('@/lib/platform/pageGate');
    await expect(requirePlatformStaffPage('support')).resolves.toEqual({
      userId: staff.id,
      email: 'operator@moooon.net',
      role: 'operator',
    });
  });
});

describe('the route the monitor reported', () => {
  it('GET /admin/ai-planning, anonymous — the page answers 404 on its own', async () => {
    const page = await import('@/app/(admin)/admin/ai-planning/page');
    await expect(page.default()).rejects.toBeInstanceOf(NotFoundSentinel);
  }, 180_000);
});

describe('every gated page and layout under app/(admin)', () => {
  it('gates through requirePlatformStaffPage, never the throwing gate', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry === 'page.tsx' || entry === 'layout.tsx') files.push(full);
      }
    };
    walk('app/(admin)');

    // Executable text only — a comment naming `requirePlatformStaff('operator')`
    // as what a server action enforces is not a call.
    const code = (file: string) =>
      readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    const gated = files.filter((f) => code(f).includes('requirePlatformStaffPage('));
    // The layout and the console's pages — a floor, so the scan cannot pass by
    // finding nothing.
    expect(gated.length).toBeGreaterThan(10);
    expect(gated).toContain(join('app/(admin)', 'layout.tsx'));

    for (const file of files) {
      expect(code(file), `${file} calls the throwing gate`).not.toMatch(/\brequirePlatformStaff\(/);
    }
  });
});
