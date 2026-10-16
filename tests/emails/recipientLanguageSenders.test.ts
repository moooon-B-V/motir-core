import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailSendData } from '@/lib/jobs/types';
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { formatDate } from '@/lib/utils/datetime';
import { encodeFilterParam } from '@/lib/filters/ast';
import { subscriptionOccurrenceKey } from '@/lib/savedFilters/subscriptions';
import { agentInstanceLapseService } from '@/lib/services/agentInstanceLapseService';
import { automationEngineService } from '@/lib/services/automationEngineService';
import { automationRulesService } from '@/lib/services/automationRulesService';
import { commentsService } from '@/lib/services/commentsService';
import { dataExportService } from '@/lib/services/dataExportService';
import { mentionNotificationsService } from '@/lib/services/mentionNotificationsService';
import { organizationDeletionNotifier } from '@/lib/services/organizationDeletionNotifier';
import { organizationsService } from '@/lib/services/organizationsService';
import { publicFollowDigestService } from '@/lib/services/publicFollowDigestService';
import { publicFollowService } from '@/lib/services/publicFollowService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { savedFilterSubscriptionsService } from '@/lib/services/savedFilterSubscriptionsService';
import { twoFactorService } from '@/lib/services/twoFactorService';
import { usersService } from '@/lib/services/usersService';
import { watcherNotificationsService } from '@/lib/services/watcherNotificationsService';
import { watchersService } from '@/lib/services/watchersService';
import { workspaceInvitesService } from '@/lib/services/workspaceInvitesService';
import { workspacesService } from '@/lib/services/workspacesService';
import { __resetSharedRateLimitStoreForTest } from '@/lib/rateLimit/store';
import { savedFilterSubscriptionRepository } from '@/lib/repositories/savedFilterSubscriptionRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns, truncateRateLimitCounters } from '../helpers/db';
import { captureConsoleEmails, captureEmailEvents, runEmailSendJob } from '../helpers/jobs';
import { setProjectAccess } from '../helpers/projectAccess';
import { pinSharedRateLimitStoreDeadline } from '../helpers/rateLimitStore';
import {
  ACTOR_LANGUAGE,
  QUOTED,
  REQUEST_LANGUAGE,
  UNRECOGNISED_LANGUAGE,
} from './fixtures/recipientLanguage';

// Story MOTIR-7732 · MOTIR-8111, PART A — the assembled path, through every
// one of the 18 customer-facing senders: a sender queues `email.send`, and the
// payload carries the RECIPIENT's language. Real Postgres and real services;
// the only seams stubbed are the job queue (captured, never sent) and the
// request-language reader, pinned to a language no recipient has — so a sender
// that still read the request would put it on the payload and fail here.
//
// The triggering person (author, actor, inviter) always has a language that is
// not the recipient's. Each sweep card tests its own senders in depth; this
// file is the one place every sender is seen together.
//
// PART C's retry round trip is here too: a queued payload, serialised as the
// queue would, rendered by the `email.send` job twice.

const requestLanguage = vi.hoisted(() => ({ value: 'es' }));
vi.mock('@/lib/i18n/serverLocale', () => ({
  currentLocale: vi.fn(async () => requestLanguage.value),
}));

const BASE_URL = process.env['BETTER_AUTH_URL'] ?? 'http://localhost:3000';
const DUE = new Date('2026-10-07T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let emails: ReturnType<typeof captureEmailEvents>;

beforeEach(async () => {
  vi.stubEnv('EMAIL_PROVIDER', 'resend');
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-for-unsubscribe-tokens');
  await truncateAuthTables();
  await truncateJobRuns();
  await truncateRateLimitCounters();
  __resetSharedRateLimitStoreForTest();
  pinSharedRateLimitStoreDeadline();
  requestLanguage.value = REQUEST_LANGUAGE;
  emails = captureEmailEvents();
});

afterEach(() => {
  emails.restore();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── helpers ─────────────────────────────────────────────────────────────────

async function userSpeaking(email: string, locale: string | null) {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await adminDb.user.update({ where: { id: user.id }, data: { locale } });
  return user;
}

async function speaks(userId: string, locale: string | null) {
  await adminDb.user.update({ where: { id: userId }, data: { locale } });
}

async function member(fx: WorkItemFixture, email: string, locale: string | null) {
  const user = await userSpeaking(email, locale);
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return user;
}

function sent(template: string): EmailSendData[] {
  return emails.events.map((e) => e.data).filter((d) => d.template === template);
}

function localeOf(d: EmailSendData): unknown {
  return (d.data as { locale?: unknown }).locale;
}

/** `to` → `data.locale`, for one template. */
function localesByAddress(template: string): Record<string, unknown> {
  return Object.fromEntries(sent(template).map((d) => [d.to, localeOf(d)]));
}

/** A fixture whose owner (the usual actor) speaks the actor's language. */
async function actorFixture(opts: { name?: string; identifier?: string } = {}) {
  const fx = await makeWorkItemFixture(opts);
  await speaks(fx.ownerId, ACTOR_LANGUAGE);
  return fx;
}

// ── account and sign-in ─────────────────────────────────────────────────────

describe('password reset', () => {
  async function requestReset(email: string) {
    await auth.api.requestPasswordReset({
      body: { email, redirectTo: `${BASE_URL}/reset-password` },
    });
  }

  it('is in the account’s saved language, not the request’s', async () => {
    await userSpeaking('ja@example.com', 'ja');
    await requestReset('ja@example.com');
    expect(localesByAddress('password-reset')).toEqual({ 'ja@example.com': 'ja' });
  });

  it('is English for no saved language and for an unrecognised one — never the request’s', async () => {
    await userSpeaking('none@example.com', null);
    await userSpeaking('odd@example.com', UNRECOGNISED_LANGUAGE);
    await requestReset('none@example.com');
    await requestReset('odd@example.com');
    expect(localesByAddress('password-reset')).toEqual({
      'none@example.com': 'en',
      'odd@example.com': 'en',
    });
  });
});

describe('email change', () => {
  it('goes to the new address in the requesting user’s saved language', async () => {
    const user = await userSpeaking('old@example.com', 'ko');
    await usersService.requestEmailChange(user.id, 'new@example.com');
    expect(localesByAddress('email-change')).toEqual({ 'new@example.com': 'ko' });
  });
});

describe('two-factor code', () => {
  it('is in the user’s saved language', async () => {
    const user = await userSpeaking('fr@example.com', 'fr');
    await twoFactorService.dispatchOtpEmail({
      userId: user.id,
      email: 'fr@example.com',
      name: 'Fr',
      otp: '314159',
    });
    expect(localesByAddress('two-factor-otp')).toEqual({ 'fr@example.com': 'fr' });
  });
});

describe('workspace invite', () => {
  async function invite(targetEmail: string) {
    const inviter = await userSpeaking(`inviter-${targetEmail}`, 'pl');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: inviter.id,
    });
    await workspaceInvitesService.sendInvite({
      inviterUserId: inviter.id,
      inviterName: 'Inviter',
      workspaceId: workspace.id,
      targetEmail,
    });
  }

  it('to an address with no account: the inviter’s saved language', async () => {
    await invite('stranger@example.com');
    expect(localesByAddress('workspace-invite')).toEqual({ 'stranger@example.com': 'pl' });
  });

  it('to an address whose account saved a language: that language', async () => {
    await userSpeaking('nl@example.com', 'nl');
    await invite('nl@example.com');
    expect(localesByAddress('workspace-invite')).toEqual({ 'nl@example.com': 'nl' });
  });
});

describe('data export ready', () => {
  it('is in the reader’s saved language', async () => {
    const user = await userSpeaking('reader@example.com', 'nl');
    const request = await adminDb.dataExportRequest.create({
      data: { userId: user.id, requestedAt: new Date() },
    });
    await dataExportService.notifyExportReady({ userId: user.id, requestId: request.id });
    expect(localesByAddress('data-export-ready')).toEqual({ 'reader@example.com': 'nl' });
  });
});

// ── notifications ───────────────────────────────────────────────────────────

describe('mention', () => {
  it('each mentioned person in their own language, not the author’s', async () => {
    const fx = await actorFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: QUOTED.workItemTitle });
    const ko = await member(fx, 'ko@example.com', 'ko');
    const plain = await member(fx, 'plain@example.com', null);
    const comment = await commentsService.addComment(issue.id, { bodyMd: QUOTED.excerpt }, fx.ctx);
    emails.events.length = 0;
    await mentionNotificationsService.fanOut({
      workspaceId: fx.workspaceId,
      workItemId: issue.id,
      authorId: fx.ownerId,
      mentionedUserIds: [ko.id, plain.id],
      source: { kind: 'comment', commentId: comment.id },
    });
    expect(localesByAddress('mention-notification')).toEqual({
      'ko@example.com': 'ko',
      'plain@example.com': 'en',
    });
  });
});

describe('watchers', () => {
  async function watched(locales: Array<string | null>) {
    const fx = await actorFixture();
    const issue = await createTestWorkItem(fx, { kind: 'task', title: QUOTED.workItemTitle });
    await adminDb.workItem.update({ where: { id: issue.id }, data: { status: 'todo' } });
    for (const [i, l] of locales.entries()) {
      const user = await member(fx, `${l ?? 'plain'}${i}@example.com`, l);
      await watchersService.watch(issue.id, { userId: user.id, workspaceId: fx.workspaceId });
    }
    return { fx, issue };
  }

  it('a comment by a de author reaches ko and fr watchers in ko and fr, its words unchanged', async () => {
    const { fx, issue } = await watched(['ko', 'fr']);
    const comment = await commentsService.addComment(issue.id, { bodyMd: QUOTED.excerpt }, fx.ctx);
    emails.events.length = 0;
    await watcherNotificationsService.fanOut({
      kind: 'comment',
      workspaceId: fx.workspaceId,
      workItemId: issue.id,
      actorId: fx.ownerId,
      commentId: comment.id,
      mentionedUserIds: [],
    });
    expect(localesByAddress('watcher-comment-notification')).toEqual({
      'ko0@example.com': 'ko',
      'fr1@example.com': 'fr',
    });
    for (const d of sent('watcher-comment-notification')) {
      expect((d.data as { excerpt: string }).excerpt).toBe(QUOTED.excerpt);
    }
  });

  it('a transition reaches a ja watcher in ja', async () => {
    const { fx, issue } = await watched(['ja']);
    emails.events.length = 0;
    await watcherNotificationsService.fanOut({
      kind: 'transition',
      workspaceId: fx.workspaceId,
      workItemId: issue.id,
      actorId: fx.ownerId,
      revisionId: 'rev-story',
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
    });
    expect(localesByAddress('watcher-transition-notification')).toEqual({
      'ja0@example.com': 'ja',
    });
  });
});

describe('filter subscription', () => {
  it('the digest is in the subscriber’s saved language', async () => {
    const fx = await makeWorkItemFixture();
    await speaks(fx.ownerId, 'nl');
    const filter = await savedFiltersService.create(
      fx.projectIdentifier,
      {
        name: QUOTED.filterName,
        visibility: 'project',
        filterParam: encodeFilterParam({
          combinator: 'and',
          conditions: [
            {
              field: 'priority',
              operator: 'is_any_of',
              value: ['high', 'highest', 'medium', 'low', 'lowest'],
            },
          ],
        }),
      },
      fx.ctx,
    );
    await createTestWorkItem(fx, { kind: 'task', title: QUOTED.workItemTitle });
    await savedFilterSubscriptionsService.subscribe(
      fx.projectIdentifier,
      filter.id,
      { schedule: 'daily', hour: 9 },
      fx.ctx,
    );
    const sub = (await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      savedFilterSubscriptionRepository.findByFilterAndUser(filter.id, fx.ownerId, tx),
    ))!;
    emails.events.length = 0;
    await savedFilterSubscriptionsService.deliver({
      workspaceId: fx.workspaceId,
      subscriptionId: sub.id,
      occurrenceKey: subscriptionOccurrenceKey(sub.id, new Date('2026-06-08T09:00:00.000Z')),
    });
    expect(sent('filter-subscription').map(localeOf)).toEqual(['nl']);
  });
});

describe('failed automation rule', () => {
  it('is in the rule owner’s saved language', async () => {
    const fx = await makeWorkItemFixture();
    await speaks(fx.ownerId, 'pl');
    const rule = await automationRulesService.create(
      fx.project.identifier,
      {
        name: QUOTED.ruleName,
        triggerType: 'created',
        triggerConfig: {},
        conditionFilterParam: null,
        actions: [{ type: 'set_field', field: 'priority', value: 'high' }],
      },
      fx.ctx,
    );
    const ruleRow = await adminDb.automationRule.findUniqueOrThrow({
      where: { id: rule.id },
      include: { owner: { select: { id: true, name: true } } },
    });
    await automationEngineService.emailOwnerOnFailure(
      ruleRow,
      {
        trigger: 'created',
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: 'wi',
        eventId: 'e',
      },
      'exec-story',
      QUOTED.errorDetail,
      false,
    );
    expect(sent('automation-rule-failed').map(localeOf)).toEqual(['pl']);
  });
});

// ── organisation and agents ────────────────────────────────────────────────

describe('ownership transferred', () => {
  it('each side in their own saved language', async () => {
    const owner = await userSpeaking('owner@example.com', 'fr');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme ws',
      ownerUserId: owner.id,
    });
    const organizationId = (
      await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
    ).organizationId;
    await adminDb.organization.update({
      where: { id: organizationId },
      data: { name: QUOTED.organizationName },
    });
    const admin = await userSpeaking('admin@example.com', 'pl');
    await organizationsService.addMember({
      organizationId,
      userId: admin.id,
      role: 'admin',
      actorUserId: owner.id,
    });
    await organizationsService.transferOwnership({
      organizationId,
      actorUserId: owner.id,
      toUserId: admin.id,
      confirmName: QUOTED.organizationName,
    });
    expect(localesByAddress('ownership-transferred')).toEqual({
      'owner@example.com': 'fr',
      'admin@example.com': 'pl',
    });
  });
});

describe('organisation deletion — ja, de and no saved language, per member', () => {
  async function closingOrg(slug: string, status: 'scheduled' | 'cancelled' = 'scheduled') {
    const organization = await adminDb.organization.create({
      data: { name: QUOTED.organizationName, slug },
    });
    const owner = await userSpeaking(`owner-${slug}@example.com`, 'ja');
    const admin = await userSpeaking(`admin-${slug}@example.com`, 'de');
    const plain = await userSpeaking(`member-${slug}@example.com`, null);
    for (const [user, role] of [
      [owner, 'owner'],
      [admin, 'admin'],
      [plain, 'member'],
    ] as const) {
      await adminDb.organizationMembership.create({
        data: { organizationId: organization.id, userId: user.id, role },
      });
    }
    const request = await adminDb.organizationDeletionRequest.create({
      data: {
        organizationId: organization.id,
        requestedByUserId: owner.id,
        requestedAt: new Date(DUE.getTime() - 30 * DAY_MS),
        erasureDueAt: DUE,
        status,
        ...(status === 'cancelled' ? { cancelledAt: new Date(), cancelledByUserId: admin.id } : {}),
      },
    });
    return { request, owner, admin, plain };
  }

  it('scheduled: per-member language, and the due date written in it', async () => {
    const { request, owner, admin, plain } = await closingOrg('sched');
    await organizationDeletionNotifier.notifyScheduled(request.id);
    const byTo = Object.fromEntries(sent('organization-deletion-scheduled').map((d) => [d.to, d]));
    expect(byTo[owner.email]!.data).toMatchObject({ locale: 'ja', dueDate: '2026年10月7日' });
    expect(byTo[admin.email]!.data).toMatchObject({ locale: 'de', dueDate: '7. Okt. 2026' });
    expect(byTo[plain.email]!.data).toMatchObject({
      locale: 'en',
      dueDate: formatDate(DUE.toISOString(), 'en'),
    });
  });

  it('cancelled: per-member language', async () => {
    const { request, owner, admin, plain } = await closingOrg('cancel', 'cancelled');
    await organizationDeletionNotifier.notifyCancelled(request.id);
    expect(localesByAddress('organization-deletion-cancelled')).toEqual({
      [owner.email]: 'ja',
      [admin.email]: 'de',
      [plain.email]: 'en',
    });
  });

  it('reminder: the Owner and Admins, each in their language with the date in it', async () => {
    const { owner, admin } = await closingOrg('remind');
    await organizationDeletionNotifier.sendDueReminders(new Date(DUE.getTime() - 3 * DAY_MS));
    const byTo = Object.fromEntries(sent('organization-deletion-reminder').map((d) => [d.to, d]));
    expect(Object.keys(byTo).sort()).toEqual([admin.email, owner.email].sort());
    expect(byTo[owner.email]!.data).toMatchObject({ locale: 'ja', dueDate: '2026年10月7日' });
    expect(byTo[admin.email]!.data).toMatchObject({ locale: 'de', dueDate: '7. Okt. 2026' });
  });

  it('erased: the recipients the sweep captured, each in their language', async () => {
    const { request, owner, admin, plain } = await closingOrg('erased');
    await organizationDeletionNotifier.notifyErased({
      requestId: request.id,
      organizationName: QUOTED.organizationName,
      erasedAt: DUE,
      recipients: [owner, admin, plain].map((u, i) => ({
        userId: u.id,
        name: u.name,
        email: u.email,
        role: (['owner', 'admin', 'member'] as const)[i]!,
      })),
    });
    expect(localesByAddress('organization-erased')).toEqual({
      [owner.email]: 'ja',
      [admin.email]: 'de',
    });
  });
});

describe('agents deletion scheduled', () => {
  it('each owner in their language, with the deletion date written in it', async () => {
    const fx = await makeWorkItemFixture();
    const organizationId = fx.workspace.organizationId;
    const ko = await member(fx, 'ko-owner@example.com', 'ko');
    const plain = await member(fx, 'plain-owner@example.com', null);
    for (const [owner, name] of [
      [ko, QUOTED.agentName],
      [plain, 'builder-02'],
    ] as const) {
      await adminDb.agentInstance.create({
        data: {
          workspaceId: fx.workspaceId,
          organizationId,
          projectId: fx.projectId,
          ownerId: owner.id,
          name,
          profileId: 'claude',
          imageTag: 'test',
          imageDigest: 'sha256:test',
          region: 'ams',
          scheduledDeletionAt: DUE,
        },
      });
    }
    await agentInstanceLapseService.notify(organizationId, QUOTED.organizationName);
    const byTo = Object.fromEntries(sent('agents-deletion-scheduled').map((d) => [d.to, d]));
    expect(byTo['ko-owner@example.com']!.data).toMatchObject({
      locale: 'ko',
      deletionDate: formatDate(DUE.toISOString(), 'ko'),
      agentNames: [QUOTED.agentName],
    });
    expect(byTo['plain-owner@example.com']!.data).toMatchObject({
      locale: 'en',
      deletionDate: formatDate(DUE.toISOString(), 'en'),
    });
  });
});

// ── public follow ──────────────────────────────────────────────────────────

describe('public follow — an address-only recipient', () => {
  const MONDAY = new Date('2026-08-24T09:00:00.000Z');

  async function publicProject() {
    const fx = await makeWorkItemFixture({ name: QUOTED.projectName, identifier: 'ROCK' });
    await setProjectAccess(adminDb, fx.projectId, 'public');
    return fx;
  }

  async function shipSomething(fx: WorkItemFixture) {
    const item = await createTestWorkItem(fx, { kind: 'task', title: QUOTED.workItemTitle });
    await adminDb.workItemRevision.create({
      data: {
        workItemId: item.id,
        changedById: fx.ownerId,
        changedAt: new Date('2026-08-20T10:00:00.000Z'),
        changeKind: 'updated',
        diff: { status: { from: 'in_progress', to: 'done' } },
      },
    });
    await adminDb.workItem.update({ where: { id: item.id }, data: { status: 'done' } });
  }

  async function digestFor(fx: WorkItemFixture) {
    const follow = await adminDb.publicFollow.findFirstOrThrow();
    await adminDb.publicFollow.update({
      where: { id: follow.id },
      data: {
        confirmedAt: new Date('2026-08-01T00:00:00.000Z'),
        lastDigestAt: new Date('2026-08-17T09:00:00.000Z'),
      },
    });
    emails.events.length = 0;
    await publicFollowDigestService.deliverDigest({
      workspaceId: fx.workspaceId,
      followId: follow.id,
      occurrenceKey: `${follow.id}:2026-W35`,
      now: MONDAY,
    });
    return sent('follow-digest').map(localeOf);
  }

  it('followed from an it page: the confirmation and a later digest are in it', async () => {
    const fx = await publicProject();
    await shipSomething(fx);
    await publicFollowService.subscribeByEmail(
      fx.projectIdentifier,
      'reader@example.com',
      null,
      'it',
    );
    expect(sent('follow-confirm').map(localeOf)).toEqual(['it']);
    expect(await digestFor(fx)).toEqual(['it']);
  });

  it('a follow with no recorded language gets English', async () => {
    const fx = await publicProject();
    await shipSomething(fx);
    await publicFollowService.subscribeByEmail(fx.projectIdentifier, 'reader@example.com', null);
    expect(sent('follow-confirm').map(localeOf)).toEqual(['en']);
    expect(await digestFor(fx)).toEqual(['en']);
  });

  it('the address later registered with a saved language: that language wins', async () => {
    const fx = await publicProject();
    await shipSomething(fx);
    await publicFollowService.subscribeByEmail(
      fx.projectIdentifier,
      'reader@example.com',
      null,
      'it',
    );
    await userSpeaking('reader@example.com', 'fr');
    expect(await digestFor(fx)).toEqual(['fr']);
  });
});

// ── PART C: the retry round trip ───────────────────────────────────────────

describe('a queued payload renders the same, in its language, on every attempt', () => {
  it('serialised as the queue would, and run by the email.send job twice', async () => {
    await userSpeaking('ja@example.com', 'ja');
    await auth.api.requestPasswordReset({
      body: { email: 'ja@example.com', redirectTo: `${BASE_URL}/reset-password` },
    });
    const [queued] = sent('password-reset');
    expect(localeOf(queued!)).toBe('ja');
    const payload = JSON.parse(JSON.stringify(queued)) as EmailSendData;
    emails.restore();

    vi.stubEnv('EMAIL_PROVIDER', 'console');
    const consoleEmails = captureConsoleEmails();
    try {
      await runEmailSendJob(payload);
      await runEmailSendJob(payload);
    } finally {
      consoleEmails.restore();
    }
    expect(consoleEmails.lines).toHaveLength(2);
    expect(consoleEmails.lines[0]).toBe(consoleEmails.lines[1]);
    expect(consoleEmails.lines[0]).toContain('Motir のパスワードをリセット');
    expect(consoleEmails.lines[0]).not.toContain('Reset your Motir password');
  });
});
