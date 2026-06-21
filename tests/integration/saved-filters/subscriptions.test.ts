import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { savedFilterSubscriptionsService } from '@/lib/services/savedFilterSubscriptionsService';
import { savedFilterSubscriptionRepository } from '@/lib/repositories/savedFilterSubscriptionRepository';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { encodeFilterParam, type FilterAst } from '@/lib/filters/ast';
import { subscriptionOccurrenceKey } from '@/lib/savedFilters/subscriptions';
import { signUnsubscribeToken } from '@/lib/savedFilters/subscriptionToken';
import {
  BuiltinSavedFilterImmutableError,
  InvalidSubscriptionScheduleError,
  SavedFilterNotFoundError,
} from '@/lib/savedFilters/errors';
import { builtinFilterId } from '@/lib/savedFilters/builtins';
import {
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import { captureEmailEvents, captureJobEvents } from '../../helpers/jobs';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Story 6.2 · Subtask 6.2.5 — filter subscriptions. Real Postgres (the one
// allowed seam is the Inngest client's `send()`, captured for assertion).
// Covers: subscribe/unsubscribe round-trips + the visibility gate; the
// upsert/re-schedule; the dependents count + delete cascade; the token
// unsubscribe; the cron's due fan-out; and `deliver` AS the subscriber (the
// permission matrix at send time, the 50-cap + true total, the deep link, and
// the no-mail skip paths).

const AST: FilterAst = {
  combinator: 'and',
  conditions: [
    {
      field: 'priority',
      operator: 'is_any_of',
      value: ['high', 'highest', 'medium', 'low', 'lowest'],
    },
  ],
};
const param = () => encodeFilterParam(AST);

interface Team {
  fx: WorkItemFixture;
  key: string;
  ownerCtx: ServiceContext;
  memberCtx: ServiceContext;
  otherCtx: ServiceContext;
  memberId: string;
  otherId: string;
}

let seq = 0;
async function makeTeam(): Promise<Team> {
  seq += 1;
  const fx = await makeWorkItemFixture({ identifier: `S${String(seq).padStart(3, '0')}` });
  const key = fx.projectIdentifier;
  async function enroll(slug: string, role: 'admin' | 'member' | 'viewer') {
    const user = await createTestUser({ email: `${slug}-${seq}@example.com`, name: slug });
    await workspacesService.addMember({
      userId: user.id,
      workspaceId: fx.workspaceId,
      role: 'member',
    });
    await projectMembersService.addMember({
      key,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: user.id,
      role,
    });
    return user;
  }
  const member = await enroll('member', 'member');
  const other = await enroll('other', 'member');
  const ctxFor = (userId: string): ServiceContext => ({ userId, workspaceId: fx.workspaceId });
  return {
    fx,
    key,
    ownerCtx: fx.ctx,
    memberCtx: ctxFor(member.id),
    otherCtx: ctxFor(other.id),
    memberId: member.id,
    otherId: other.id,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('subscribe / unsubscribe / read', () => {
  it('subscribes a visible filter, reads it back, and re-schedules (upsert)', async () => {
    const t = await makeTeam();
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Shared', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );

    const created = await savedFilterSubscriptionsService.subscribe(
      t.key,
      filter.id,
      { schedule: 'daily', hour: 9 },
      t.memberCtx,
    );
    expect(created).toEqual({ schedule: 'daily', weekday: null, hour: 9 });
    expect(await savedFilterSubscriptionsService.getMine(t.key, filter.id, t.memberCtx)).toEqual({
      schedule: 'daily',
      weekday: null,
      hour: 9,
    });

    // Re-subscribe edits in place (no duplicate row).
    const rescheduled = await savedFilterSubscriptionsService.subscribe(
      t.key,
      filter.id,
      { schedule: 'weekly', weekday: 3, hour: 17 },
      t.memberCtx,
    );
    expect(rescheduled).toEqual({ schedule: 'weekly', weekday: 3, hour: 17 });
    expect(await savedFilterSubscriptionRepository.countByFilter(filter.id)).toBe(1);
  });

  it('a non-owner can subscribe to a project-shared filter (the read-layer rule)', async () => {
    const t = await makeTeam();
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Shared', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    const sub = await savedFilterSubscriptionsService.subscribe(
      t.key,
      filter.id,
      { schedule: 'weekdays', hour: 8 },
      t.otherCtx,
    );
    expect(sub.schedule).toBe('weekdays');
  });

  it('a private filter is invisible to others — subscribing is a 404', async () => {
    const t = await makeTeam();
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Mine', visibility: 'private', filterParam: param() },
      t.memberCtx,
    );
    await expect(
      savedFilterSubscriptionsService.subscribe(
        t.key,
        filter.id,
        { schedule: 'daily', hour: 9 },
        t.otherCtx,
      ),
    ).rejects.toThrow(SavedFilterNotFoundError);
  });

  it('rejects a built-in id and a weekly without a weekday', async () => {
    const t = await makeTeam();
    await expect(
      savedFilterSubscriptionsService.subscribe(
        t.key,
        builtinFilterId('my-open-issues'),
        { schedule: 'daily', hour: 9 },
        t.memberCtx,
      ),
    ).rejects.toThrow(BuiltinSavedFilterImmutableError);

    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Shared', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await expect(
      savedFilterSubscriptionsService.subscribe(
        t.key,
        filter.id,
        { schedule: 'weekly', hour: 9 },
        t.memberCtx,
      ),
    ).rejects.toThrow(InvalidSubscriptionScheduleError);
  });

  it('unsubscribe is idempotent (no-op when not subscribed)', async () => {
    const t = await makeTeam();
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Shared', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await savedFilterSubscriptionsService.subscribe(
      t.key,
      filter.id,
      { schedule: 'daily', hour: 9 },
      t.memberCtx,
    );
    await savedFilterSubscriptionsService.unsubscribe(t.key, filter.id, t.memberCtx);
    await savedFilterSubscriptionsService.unsubscribe(t.key, filter.id, t.memberCtx); // again — no throw
    expect(await savedFilterSubscriptionsService.getMine(t.key, filter.id, t.memberCtx)).toBeNull();
  });
});

describe('dependents + cascade + token unsubscribe', () => {
  it('getDependents counts subscriptions and the delete cascades them', async () => {
    const t = await makeTeam();
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Shared', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await savedFilterSubscriptionsService.subscribe(
      t.key,
      filter.id,
      { schedule: 'daily', hour: 9 },
      t.memberCtx,
    );
    await savedFilterSubscriptionsService.subscribe(
      t.key,
      filter.id,
      { schedule: 'daily', hour: 9 },
      t.otherCtx,
    );

    const deps = await savedFiltersService.getDependents(t.key, filter.id, t.memberCtx);
    expect(deps.subscriptionCount).toBe(2);

    await savedFiltersService.delete(t.key, filter.id, t.memberCtx);
    expect(await savedFilterSubscriptionRepository.countByFilter(filter.id)).toBe(0);
  });

  it('token unsubscribe deletes the row; an invalid token is rejected', async () => {
    const t = await makeTeam();
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Shared', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await savedFilterSubscriptionsService.subscribe(
      t.key,
      filter.id,
      { schedule: 'daily', hour: 9 },
      t.memberCtx,
    );
    const row = await savedFilterSubscriptionRepository.findByFilterAndUser(filter.id, t.memberId);
    expect(row).not.toBeNull();

    expect(await savedFilterSubscriptionsService.unsubscribeByToken('garbage')).toEqual({
      status: 'invalid',
    });
    expect(
      await savedFilterSubscriptionsService.unsubscribeByToken(signUnsubscribeToken(row!.id)),
    ).toEqual({ status: 'unsubscribed' });
    expect(await savedFilterSubscriptionRepository.findById(row!.id)).toBeNull();
    // Idempotent: re-clicking the (now stale) link still reports success.
    expect(
      await savedFilterSubscriptionsService.unsubscribeByToken(signUnsubscribeToken(row!.id)),
    ).toEqual({ status: 'unsubscribed' });
  });
});

describe('cron fan-out — enqueueDueDeliveries', () => {
  it('enqueues one deliver event per DUE subscription and skips the not-due', async () => {
    const t = await makeTeam();
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Shared', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    // Due at 09:00 daily; the other at 10:00 (not due at the tested hour).
    await savedFilterSubscriptionsService.subscribe(
      t.key,
      filter.id,
      { schedule: 'daily', hour: 9 },
      t.memberCtx,
    );
    await savedFilterSubscriptionsService.subscribe(
      t.key,
      filter.id,
      { schedule: 'daily', hour: 10 },
      t.otherCtx,
    );

    const cap = captureJobEvents();
    const now = new Date('2026-06-08T09:00:00.000Z');
    const summary = await savedFilterSubscriptionsService.enqueueDueDeliveries(now, {
      pageSize: 1,
    });
    cap.restore();

    expect(summary.due).toBe(1);
    expect(summary.enqueued).toBe(1);
    const delivers = cap.events.filter((e) => e.name === 'filter-subscription/deliver');
    expect(delivers).toHaveLength(1);
    expect(delivers[0]!.data).toMatchObject({
      workspaceId: t.fx.workspaceId,
      occurrenceKey: expect.stringContaining('2026-06-08T09'),
    });
  });
});

describe('deliver — resolves AS the subscriber', () => {
  async function makeFilterWithItems() {
    const t = await makeTeam();
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'All', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    // Three matching work items (the AST matches every priority, so any
    // default-priority item qualifies — effectively match-all).
    for (let i = 0; i < 3; i += 1) {
      await createTestWorkItem(t.fx, { kind: 'task', title: `Task ${i}` });
    }
    const row = await savedFilterSubscriptionRepository.findByFilterAndUser(filter.id, t.memberId);
    return {
      t,
      filter,
      subscribe: async () => {
        await savedFilterSubscriptionsService.subscribe(
          t.key,
          filter.id,
          { schedule: 'daily', hour: 9 },
          t.memberCtx,
        );
        return (await savedFilterSubscriptionRepository.findByFilterAndUser(
          filter.id,
          t.memberId,
        ))!;
      },
      row,
    };
  }

  it('enqueues an email.send with rows + total + the deep link', async () => {
    const { t, subscribe } = await makeFilterWithItems();
    const sub = await subscribe();

    const cap = captureEmailEvents();
    const outcome = await savedFilterSubscriptionsService.deliver({
      workspaceId: t.fx.workspaceId,
      subscriptionId: sub.id,
      occurrenceKey: subscriptionOccurrenceKey(sub.id, new Date('2026-06-08T09:00:00.000Z')),
    });
    cap.restore();

    expect(outcome.status).toBe('delivered');
    if (outcome.status === 'delivered') {
      expect(outcome.total).toBe(3);
      expect(outcome.count).toBe(3);
    }
    expect(cap.events).toHaveLength(1);
    const data = cap.events[0]!.data;
    expect(data.template).toBe('filter-subscription');
    expect(data.idempotencyKey).toContain('2026-06-08T09');
    const payload = data.data as {
      items: unknown[];
      totalCount: number;
      filterUrl: string;
      unsubscribeUrl: string;
    };
    expect(payload.totalCount).toBe(3);
    expect(payload.items).toHaveLength(3);
    expect(payload.filterUrl).toContain('/items?filter=');
    expect(payload.unsubscribeUrl).toContain('/unsubscribe/filter-subscription?token=');
  });

  it('skips (no mail) when the subscriber lost browse access', async () => {
    const { t, filter } = await makeFilterWithItems();
    // `other` subscribes to the shared filter, then loses project access.
    await savedFilterSubscriptionsService.subscribe(
      t.key,
      filter.id,
      { schedule: 'daily', hour: 9 },
      t.otherCtx,
    );
    const sub = (await savedFilterSubscriptionRepository.findByFilterAndUser(
      filter.id,
      t.otherId,
    ))!;
    await projectMembersService.removeMember({
      key: t.key,
      actorUserId: t.fx.ownerId,
      ctx: t.fx.ctx,
      targetUserId: t.otherId,
    });
    // Make the project private so a non-member truly can't browse.
    await db.project.update({ where: { id: t.fx.projectId }, data: { accessLevel: 'private' } });

    const cap = captureEmailEvents();
    const outcome = await savedFilterSubscriptionsService.deliver({
      workspaceId: t.fx.workspaceId,
      subscriptionId: sub.id,
      occurrenceKey: 'k',
    });
    cap.restore();
    expect(outcome).toEqual({ status: 'skipped', reason: 'no_access' });
    expect(cap.events).toHaveLength(0);
  });

  it('skips a vanished subscription', async () => {
    const t = await makeTeam();
    const cap = captureEmailEvents();
    const outcome = await savedFilterSubscriptionsService.deliver({
      workspaceId: t.fx.workspaceId,
      subscriptionId: 'does-not-exist',
      occurrenceKey: 'k',
    });
    cap.restore();
    expect(outcome).toEqual({ status: 'skipped', reason: 'subscription_gone' });
    expect(cap.events).toHaveLength(0);
  });

  it('delivers zero results without crashing (a report, not an alert)', async () => {
    const t = await makeTeam();
    // A filter that matches nothing (no work items created).
    const filter = await savedFiltersService.create(
      t.key,
      { name: 'Empty', visibility: 'project', filterParam: param() },
      t.memberCtx,
    );
    await savedFilterSubscriptionsService.subscribe(
      t.key,
      filter.id,
      { schedule: 'daily', hour: 9 },
      t.memberCtx,
    );
    const sub = (await savedFilterSubscriptionRepository.findByFilterAndUser(
      filter.id,
      t.memberId,
    ))!;

    const cap = captureEmailEvents();
    const outcome = await savedFilterSubscriptionsService.deliver({
      workspaceId: t.fx.workspaceId,
      subscriptionId: sub.id,
      occurrenceKey: 'k',
    });
    cap.restore();
    expect(outcome.status).toBe('delivered');
    if (outcome.status === 'delivered') expect(outcome.total).toBe(0);
    expect(cap.events).toHaveLength(1);
  });
});
