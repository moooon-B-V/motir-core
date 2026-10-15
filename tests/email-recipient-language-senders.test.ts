import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { usersService } from '@/lib/services/usersService';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';
import { workspacesService } from '@/lib/services/workspacesService';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables, truncateRateLimitCounters } from './helpers/db';
import { captureEmailEvents } from './helpers/jobs';
import { pinSharedRateLimitStoreDeadline } from './helpers/rateLimitStore';

// Story MOTIR-7732 · MOTIR-8106 — the account and sign-in emails (password
// reset, email change, two-factor code, workspace invite) are queued in the
// RECIPIENT's saved language, never the language of the request that caused
// them. The request language is pinned to something else below, so a sender
// that still read it would put that value on the payload and fail here.

const requestLanguage = vi.hoisted(() => ({ value: 'es' }));
vi.mock('@/lib/i18n/serverLocale', () => ({
  currentLocale: vi.fn(async () => requestLanguage.value),
}));

const BASE_URL = process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3000';

let emails: ReturnType<typeof captureEmailEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  requestLanguage.value = 'es';
  emails = captureEmailEvents();
});

afterEach(() => {
  emails.restore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function userWithLocale(email: string, locale: string | null) {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await adminDb.user.update({ where: { id: user.id }, data: { locale } });
  return user;
}

function onlyLocale(): unknown {
  expect(emails.events).toHaveLength(1);
  return (emails.events[0]!.data.data as { locale?: unknown }).locale;
}

describe('password reset', () => {
  async function requestReset(email: string) {
    await auth.api.requestPasswordReset({
      body: { email, redirectTo: `${BASE_URL}/reset-password` },
    });
  }

  it('is written in the account’s saved language, not the request’s', async () => {
    await userWithLocale('ja@example.com', 'ja');
    await requestReset('ja@example.com');
    expect(onlyLocale()).toBe('ja');
  });

  it('is English for an account with no saved language', async () => {
    await userWithLocale('plain@example.com', null);
    await requestReset('plain@example.com');
    expect(onlyLocale()).toBe('en');
  });
});

describe('email change', () => {
  it('goes to the NEW address in the requesting user’s saved language', async () => {
    requestLanguage.value = 'de';
    const user = await userWithLocale('old@example.com', 'ko');
    await usersService.requestEmailChange(user.id, 'new@example.com');
    expect(emails.events[0]!.data.to).toBe('new@example.com');
    expect(onlyLocale()).toBe('ko');
  });

  it('is English for a user with no saved language', async () => {
    const user = await userWithLocale('old@example.com', null);
    await usersService.requestEmailChange(user.id, 'new@example.com');
    expect(onlyLocale()).toBe('en');
  });
});

describe('two-factor code', () => {
  it('is written in the user’s saved language', async () => {
    requestLanguage.value = 'en';
    const user = await userWithLocale('fr@example.com', 'fr');
    await twoFactorService.dispatchOtpEmail({
      userId: user.id,
      email: 'fr@example.com',
      name: 'Fr',
      otp: '314159',
    });
    expect(onlyLocale()).toBe('fr');
  });

  it('is English for a user with no saved language', async () => {
    const user = await userWithLocale('plain@example.com', null);
    await twoFactorService.dispatchOtpEmail({
      userId: user.id,
      email: 'plain@example.com',
      name: 'Plain',
      otp: '314159',
    });
    expect(onlyLocale()).toBe('en');
  });
});

describe('workspace invite', () => {
  async function invite(inviterLocale: string | null, targetEmail: string) {
    const inviter = await userWithLocale('inviter@example.com', inviterLocale);
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme Co.',
      ownerUserId: inviter.id,
    });
    await workspaceInvitesService.sendInvite({
      inviterUserId: inviter.id,
      inviterName: 'Inviter',
      workspaceId: workspace.id,
      targetEmail,
    });
  }

  it('follows the saved language of the account that holds the address', async () => {
    await userWithLocale('nl@example.com', 'nl');
    await invite('pl', 'nl@example.com');
    expect(onlyLocale()).toBe('nl');
  });

  it('follows the inviter’s saved language when the address has no account', async () => {
    await invite('pl', 'stranger@example.com');
    expect(onlyLocale()).toBe('pl');
  });

  it('is English when neither the address’s account nor the inviter saved one', async () => {
    await invite(null, 'stranger@example.com');
    expect(onlyLocale()).toBe('en');
  });
});
