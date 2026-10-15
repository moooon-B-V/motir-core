import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { mentionNotificationsService } from '@/lib/services/mentionNotificationsService';
import { watcherNotificationsService } from '@/lib/services/watcherNotificationsService';
import { commentsService } from '@/lib/services/commentsService';
import { usersService } from '@/lib/services/usersService';
import { watchersService } from '@/lib/services/watchersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { notificationPreferenceRepository } from '@/lib/repositories/notificationPreferenceRepository';
import { NOTIFICATION_EVENT_TYPE } from '@/lib/notifications/preferences';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { countDelegateCalls } from '../helpers/countDelegateCalls';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { captureEmailEvents } from '../helpers/jobs';

// Story MOTIR-7732 · MOTIR-8107 — a mention or watcher email is written in each
// RECIPIENT's saved language (English when none is saved), never the language
// of the person who wrote the comment or moved the status. The languages are
// read in one batch per fan-out (per page, for the watcher walk), so the number
// of user reads does not grow with the number of recipients.

let emails: ReturnType<typeof captureEmailEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  emails = captureEmailEvents();
});

afterEach(() => {
  emails.restore();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Member {
  user: User;
  ctx: ServiceContext;
}

async function member(fx: WorkItemFixture, email: string, locale: string | null): Promise<Member> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await adminDb.user.update({ where: { id: user.id }, data: { locale } });
  return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

async function scenario() {
  const fx = await makeWorkItemFixture();
  // The actor (the fixture's owner) writes in German.
  await adminDb.user.update({ where: { id: fx.ownerId }, data: { locale: 'de' } });
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Übersetze die Notiz' });
  await adminDb.workItem.update({ where: { id: issue.id }, data: { status: 'todo' } });
  return { fx, issue };
}

/** `to` → `data.locale` of every captured email. */
function localesByAddress(): Record<string, unknown> {
  return Object.fromEntries(
    emails.events.map((e) => [e.data.to, (e.data.data as { locale?: unknown }).locale]),
  );
}

const mentionToken = (u: User) => `[@${u.name}](mention:${u.id})`;

describe('mention emails', () => {
  async function mentionFanOut(fx: WorkItemFixture, issueId: string, mentioned: User[]) {
    const comment = await commentsService.addComment(
      issueId,
      { bodyMd: `Bitte ansehen ${mentioned.map(mentionToken).join(' ')}` },
      fx.ctx,
    );
    emails.events.length = 0;
    return countDelegateCalls('user', 'findMany', () =>
      mentionNotificationsService.fanOut({
        workspaceId: fx.workspaceId,
        workItemId: issueId,
        authorId: fx.ownerId,
        mentionedUserIds: mentioned.map((u) => u.id),
        source: { kind: 'comment', commentId: comment.id },
      }),
    );
  }

  it('are written in each recipient’s language, not the author’s', async () => {
    const { fx, issue } = await scenario();
    const ko = await member(fx, 'ko@example.com', 'ko');
    const fr = await member(fx, 'fr@example.com', 'fr');
    const plain = await member(fx, 'plain@example.com', null);

    await mentionFanOut(fx, issue.id, [ko.user, fr.user, plain.user]);

    expect(localesByAddress()).toEqual({
      'ko@example.com': 'ko',
      'fr@example.com': 'fr',
      'plain@example.com': 'en',
    });
    for (const e of emails.events) {
      const data = e.data.data as { workItemTitle: string };
      expect(data.workItemTitle).toBe('Übersetze die Notiz');
      expect(e.data.idempotencyKey).toMatch(/^mention:/);
    }
  });

  it('read the recipients’ languages without a read per recipient', async () => {
    const one = await scenario();
    const a = await member(one.fx, 'a@example.com', 'ko');
    const single = await mentionFanOut(one.fx, one.issue.id, [a.user]);

    await truncateAuthTables();
    const five = await scenario();
    const many: User[] = [];
    for (const l of ['ko', 'fr', 'ja', 'es', 'it']) {
      many.push((await member(five.fx, `${l}@example.com`, l)).user);
    }
    const all = await mentionFanOut(five.fx, five.issue.id, many);

    expect(all.result.notifiedUserIds).toHaveLength(5);
    expect(all.queries).toBe(single.queries);
  });
});

describe('watcher emails', () => {
  async function watchedBy(locales: Array<string | null>) {
    const { fx, issue } = await scenario();
    const watchers: Member[] = [];
    for (const [i, l] of locales.entries()) {
      const m = await member(fx, `${l ?? 'plain'}${i}@example.com`, l);
      await watchersService.watch(issue.id, m.ctx);
      watchers.push(m);
    }
    return { fx, issue, watchers };
  }

  async function commentFanOut(fx: WorkItemFixture, issueId: string, pageSize?: number) {
    const comment = await commentsService.addComment(issueId, { bodyMd: 'Erledigt.' }, fx.ctx);
    emails.events.length = 0;
    return countDelegateCalls('user', 'findMany', () =>
      watcherNotificationsService.fanOut(
        {
          kind: 'comment',
          workspaceId: fx.workspaceId,
          workItemId: issueId,
          actorId: fx.ownerId,
          commentId: comment.id,
          mentionedUserIds: [],
        },
        pageSize ? { pageSize } : undefined,
      ),
    );
  }

  it('on a comment are written in each watcher’s language, not the commenter’s', async () => {
    const { fx, issue } = await watchedBy(['ko', 'fr']);
    await commentFanOut(fx, issue.id);
    expect(localesByAddress()).toEqual({ 'ko0@example.com': 'ko', 'fr1@example.com': 'fr' });
    for (const e of emails.events) {
      expect((e.data.data as { excerpt: string }).excerpt).toBe('Erledigt.');
    }
  });

  it('on a transition are written in each watcher’s language; a watcher who opted out gets none', async () => {
    const { fx, issue, watchers } = await watchedBy(['ko', 'fr', 'ja']);
    await adminDb.$transaction((tx) =>
      notificationPreferenceRepository.upsert(
        {
          userId: watchers[2]!.user.id,
          eventType: NOTIFICATION_EVENT_TYPE.transitioned,
          channel: 'email',
          enabled: false,
        },
        tx,
      ),
    );
    emails.events.length = 0;

    await watcherNotificationsService.fanOut({
      kind: 'transition',
      workspaceId: fx.workspaceId,
      workItemId: issue.id,
      actorId: fx.ownerId,
      revisionId: 'rev-lang',
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
    });

    expect(localesByAddress()).toEqual({ 'ko0@example.com': 'ko', 'fr1@example.com': 'fr' });
    for (const e of emails.events) {
      expect(e.data.template).toBe('watcher-transition-notification');
      expect(e.data.idempotencyKey).toMatch(/^watcher-transition:rev-lang:/);
    }
  });

  it('read one page’s languages without a read per watcher', async () => {
    const one = await watchedBy(['ko']);
    const single = await commentFanOut(one.fx, one.issue.id, 50);

    await truncateAuthTables();
    const five = await watchedBy(['ko', 'fr', 'ja', 'es', null]);
    const all = await commentFanOut(five.fx, five.issue.id, 50);

    expect(all.result.notifiedUserIds).toHaveLength(5);
    expect(all.queries).toBe(single.queries);
  });
});
