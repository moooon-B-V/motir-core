import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { toMonitorIssueLinkDto } from '@/lib/mappers/monitorIssueLinkMappers';
import type { MonitorProvider } from '@/lib/monitors/provider';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { MONITOR_RESOLVE_STATES } from '@/lib/monitors/syncStates';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import type { MonitorIssueWithConnection } from '@/lib/repositories/monitorIssueRepository';
import { monitorIssueService } from '@/lib/services/monitorIssueService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  card,
  memberWithPermissions,
  monitorLinkScenario,
  plantLink,
} from './_monitorLinkFixtures';

// THE CARD'S ERROR LINKS READ (Story MOTIR-4932 · Subtask MOTIR-5730) — every
// `monitor_issue` link pointing at a work item, with its stored facts and its
// connection's labels, gated like the CARD and making NO provider call.
//
// Real Postgres; the provider is the fake, armed to throw on every method so a
// call anywhere on the read path would fail the test rather than pass quietly.

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
});

afterEach(() => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Every provider method throws AND counts — the read must reach none of them. */
function armEverythingToThrow(): { calls: string[] } {
  const calls: string[] = [];
  const throwing = Object.fromEntries(
    Object.keys(fakeMonitorProvider)
      .filter((key) => key !== 'id')
      .map((key) => [
        key,
        async () => {
          calls.push(key);
          throw new Error(`the read called the provider (${key})`);
        },
      ]),
  ) as unknown as MonitorProvider;
  registerMonitorProvider({ ...throwing, id: 'fake' }, 'sentry');
  return { calls };
}

describe('listForWorkItem', () => {
  it('returns one DTO per link — three links, two connections — most recently seen first', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    await plantLink(s, {
      connectionId: s.webConnectionId,
      externalIssueId: 'old',
      workItemId: item.id,
      lastSeenAt: new Date('2026-09-10T00:00:00.000Z'),
      eventCount: 4,
    });
    await plantLink(s, {
      connectionId: s.workerConnectionId,
      externalIssueId: 'new',
      workItemId: item.id,
      lastSeenAt: new Date('2026-09-18T00:00:00.000Z'),
      eventCount: 40_000,
      extra: { environment: 'production', release: '1.4.2' },
    });
    await plantLink(s, {
      connectionId: s.webConnectionId,
      externalIssueId: 'mid',
      workItemId: item.id,
      lastSeenAt: new Date('2026-09-15T00:00:00.000Z'),
    });
    // Another card's link is not this card's.
    const other = await card(s.fx, 'Other');
    await plantLink(s, {
      connectionId: s.webConnectionId,
      externalIssueId: 'elsewhere',
      workItemId: other.id,
      lastSeenAt: new Date('2026-09-19T00:00:00.000Z'),
    });

    const links = await monitorIssueService.listForWorkItem(item.id, s.fx.ctx);

    expect(links.map((l) => l.title)).toEqual(['Error new', 'Error mid', 'Error old']);
    expect(links[0]).toMatchObject({
      eventCount: 40_000,
      environment: 'production',
      release: '1.4.2',
      connection: { id: s.workerConnectionId, orgSlug: 'fake-org', projectSlug: 'worker' },
      resolve: { state: null, attemptedAt: null, resolvedAt: null, error: null },
      assigneeNote: null,
    });
    expect(links[1]!.connection).toEqual({
      id: s.webConnectionId,
      orgSlug: 'fake-org',
      projectSlug: 'web',
    });
    expect(links[2]).toMatchObject({ environment: null, release: null, eventCount: 4 });
    // The DTO carries no credential and no raw row.
    expect(JSON.stringify(links)).not.toMatch(/token|metadata|workspaceId/i);
  });

  it('breaks a last-seen tie by the provider’s issue id, so the order is stable', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    const at = new Date('2026-09-18T00:00:00.000Z');
    for (const id of ['b', 'c', 'a']) {
      await plantLink(s, {
        connectionId: s.webConnectionId,
        externalIssueId: id,
        workItemId: item.id,
        lastSeenAt: at,
      });
    }
    const links = await monitorIssueService.listForWorkItem(item.id, s.fx.ctx);
    expect(links.map((l) => l.title)).toEqual(['Error a', 'Error b', 'Error c']);
  });

  it('returns [] for a work item with no link', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    await expect(monitorIssueService.listForWorkItem(item.id, s.fx.ctx)).resolves.toEqual([]);
  });

  it('makes NO provider call — the fake armed to throw on every method records zero calls', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    await plantLink(s, {
      connectionId: s.webConnectionId,
      externalIssueId: 'x',
      workItemId: item.id,
      lastSeenAt: new Date(),
    });
    const { calls } = armEverythingToThrow();

    const links = await monitorIssueService.listForWorkItem(item.id, s.fx.ctx);

    expect(links).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(fakeMonitorState().searches).toEqual([]);
    expect(fakeMonitorState().contextReads).toEqual([]);
  });
});

describe('the gate is the CARD’s, not the monitor’s', () => {
  it('another workspace’s item is item-not-found, with no rows — the actor’s view and the true population differ', async () => {
    const a = await monitorLinkScenario('A');
    const b = await monitorLinkScenario('B');
    const item = await card(a.fx);
    await plantLink(a, {
      connectionId: a.webConnectionId,
      externalIssueId: 'secret',
      workItemId: item.id,
      lastSeenAt: new Date(),
    });
    // The true population holds the row; workspace B must not see it.
    expect(await adminDb.monitorIssue.count({ where: { workItemId: item.id } })).toBe(1);

    await expect(monitorIssueService.listForWorkItem(item.id, b.fx.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });

  it('a reader holding ONLY the item-read permission still gets the rows', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    await plantLink(s, {
      connectionId: s.webConnectionId,
      externalIssueId: 'r',
      workItemId: item.id,
      lastSeenAt: new Date(),
    });
    // A CUSTOM role with neither `integration:manage` nor `work_item:edit`.
    const reader = await memberWithPermissions(s.fx, ['project:browse'], 'reader@ex.com');

    const links = await monitorIssueService.listForWorkItem(item.id, reader);

    expect(links.map((l) => l.title)).toEqual(['Error r']);
  });

  it('a workspace member who cannot browse the project is refused as hidden', async () => {
    const s = await monitorLinkScenario();
    const item = await card(s.fx);
    const outsider = await memberWithPermissions(s.fx, [], 'outsider@ex.com');
    await expect(monitorIssueService.listForWorkItem(item.id, outsider)).rejects.toBeInstanceOf(
      ProjectAccessDeniedError,
    );
  });
});

describe('the mapper', () => {
  const base = (overrides: Partial<MonitorIssueWithConnection>): MonitorIssueWithConnection =>
    ({
      id: 'mi',
      connectionId: 'c',
      projectId: 'p',
      workspaceId: 'w',
      externalIssueId: 'e',
      title: 'T',
      culprit: null,
      level: 'fatalish',
      permalink: null,
      eventCount: 1,
      firstSeenAt: new Date('2026-09-01T00:00:00.000Z'),
      lastSeenAt: new Date('2026-09-02T00:00:00.000Z'),
      environment: null,
      release: null,
      // The evidence columns (MOTIR-5979): never read.
      exceptionType: null,
      exceptionMessage: null,
      frames: null,
      tags: null,
      requestMethod: null,
      requestPath: null,
      eventId: null,
      eventAt: null,
      evidenceReadAt: null,
      evidenceCheckedAt: null,
      workItemId: 'wi',
      filedWorkItemIdentifier: null,
      resolveState: null,
      resolveAttemptedAt: null,
      resolvedByMotirAt: null,
      resolveError: null,
      syncedAssigneeExternalId: null,
      assigneeSyncNote: null,
      assigneeCheckedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      connection: { id: 'c', externalProjectSlug: 'web', installation: { metadata: null } },
      ...overrides,
    }) as MonitorIssueWithConnection;

  it.each([...MONITOR_RESOLVE_STATES, null])(
    'maps resolve state %s through the closed union',
    (state) => {
      const at = new Date('2026-09-03T00:00:00.000Z');
      const dto = toMonitorIssueLinkDto(
        base({
          resolveState: state,
          resolveAttemptedAt: state ? at : null,
          resolvedByMotirAt: state === 'resolved' ? at : null,
          resolveError: state === 'failed' ? 'Sentry said no' : null,
        }),
      );
      expect(dto.resolve).toEqual({
        state,
        attemptedAt: state ? at.toISOString() : null,
        resolvedAt: state === 'resolved' ? at.toISOString() : null,
        error: state === 'failed' ? 'Sentry said no' : null,
      });
    },
  );

  it('reads an unknown stored state and note as absent, and passes an unknown LEVEL verbatim', () => {
    const dto = toMonitorIssueLinkDto(base({ resolveState: 'weird', assigneeSyncNote: 'huh' }));
    expect(dto.resolve.state).toBeNull();
    expect(dto.assigneeNote).toBeNull();
    expect(dto.level).toBe('fatalish');
    expect(dto.connection.orgSlug).toBeNull();
  });

  it.each(['team_assignee', 'no_matching_member'] as const)('passes the %s note', (note) => {
    expect(toMonitorIssueLinkDto(base({ assigneeSyncNote: note })).assigneeNote).toBe(note);
  });

  it('passes environment and release through, null included', () => {
    expect(toMonitorIssueLinkDto(base({ environment: 'staging', release: '0.9.0' }))).toMatchObject(
      { environment: 'staging', release: '0.9.0' },
    );
    expect(toMonitorIssueLinkDto(base({}))).toMatchObject({ environment: null, release: null });
  });
});
