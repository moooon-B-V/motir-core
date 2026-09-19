import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';
import { MonitorIssueGoneError } from '@/lib/monitors/errors';
import type { MonitorProvider } from '@/lib/monitors/provider';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
  type FakeMonitorIssue,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import type { MonitorResolveState } from '@/lib/monitors/syncStates';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import {
  MONITOR_LINK_SEARCH_MAX_CONNECTIONS,
  monitorIssueLinkService,
} from '@/lib/services/monitorIssueLinkService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import { monitorIssueService } from '@/lib/services/monitorIssueService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  card,
  memberWithPermissions,
  monitorLinkScenario,
  type MonitorLinkScenario,
} from './_monitorLinkFixtures';

// THE STORY'S VITEST GATE (Story MOTIR-4932 · Subtask MOTIR-5733).
//
// (2) THE SEAMS THE UNITS MOCK — each drives the REAL services end to end on real
//     Postgres through the fake provider: a hand-made link is an ordinary
//     `monitor_issue` row, so the reconciler, the resolve-back and the read must
//     all treat it exactly as they treat a monitor-filed one.
// (3) THE GUARDS COVERAGE CANNOT SEE — the read path's import boundary, the one
//     closed vocabulary, cross-tenant isolation on the read and the three writes,
//     and one gate for link, search and unlink.
// (1) plus the arms the per-card suites left uncovered on the story's surface.

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  fakeMonitorState().issues = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
});

afterEach(() => {
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function issue(
  externalId: string,
  minutesAfterNow: number,
  overrides: Partial<FakeMonitorIssue> = {},
): FakeMonitorIssue {
  return {
    externalId,
    title: `Error ${externalId}`,
    culprit: `lib/${externalId}.ts`,
    level: 'error',
    eventCount: 3,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(Date.now() + minutesAfterNow * 60_000),
    permalink: null,
    assignee: null,
    externalProjectId: 'fake-web',
    ...overrides,
  };
}

const bugCount = (projectId: string) =>
  adminDb.workItem.count({ where: { projectId, kind: 'bug' } });
const rowOf = (externalIssueId: string) =>
  adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId } });

function link(s: MonitorLinkScenario, workItemId: string, externalIssueId: string, move = false) {
  return monitorIssueLinkService.linkIssue(
    workItemId,
    { connectionId: s.webConnectionId, externalIssueId, move },
    s.fx.ctx,
  );
}

// ── (2) THE SEAMS ─────────────────────────────────────────────────────────────

describe('seam — link → poll → read', () => {
  it('a hand-linked card takes the poll’s newer count, environment and release, and NO bug is filed', async () => {
    const s = await monitorLinkScenario('Gate');
    const reported = await card(s.fx, 'Customer: checkout fails');
    fakeMonitorState().issues = [issue('lpr', 5, { eventCount: 3, environment: 'staging' })];
    await link(s, reported.id, 'lpr');
    const bugsBefore = await bugCount(s.fx.projectId);

    fakeMonitorState().issues = [
      issue('lpr', 30, { eventCount: 212, environment: 'production', release: '4.0.1' }),
    ];
    const summary = await monitorIngestionService.pollConnection(s.webConnectionId);

    expect(summary).toMatchObject({ status: 'ok', filed: 0, refiled: 0, updated: 1 });
    expect(await bugCount(s.fx.projectId)).toBe(bugsBefore);
    const [read] = await monitorIssueService.listForWorkItem(reported.id, s.fx.ctx);
    expect(read).toMatchObject({ eventCount: 212, environment: 'production', release: '4.0.1' });
  });
});

describe('seam — link → done → resolve', () => {
  it('a hand-linked card reaching done resolves its issue ONCE, exactly as a monitor-filed bug does', async () => {
    const s = await monitorLinkScenario('Gate');
    const reported = await card(s.fx);
    fakeMonitorState().issues = [issue('ldr', 5)];
    await link(s, reported.id, 'ldr');
    // The ordinary life of a link: the poll has already seen the issue while the
    // card was open (its watermark is past it), THEN the card is completed. An
    // issue first seen AFTER completion would be a recurrence, and the reconciler
    // rightly re-files that — which is not this seam.
    await monitorIngestionService.pollConnection(s.webConnectionId);
    await adminDb.workItem.update({ where: { id: reported.id }, data: { status: 'done' } });

    await monitorIngestionService.pollConnection(s.webConnectionId);
    await monitorIngestionService.pollConnection(s.webConnectionId);

    expect(fakeMonitorState().resolvedIssues).toEqual(['ldr']);
    expect(await rowOf('ldr')).toMatchObject({ resolveState: 'resolved', workItemId: reported.id });
  });
});

describe('seam — move → the loop guard', () => {
  it('an issue Motir resolved, moved to another card, is not re-filed or mutated by the next poll', async () => {
    const s = await monitorLinkScenario('Gate');
    const a = await card(s.fx, 'A');
    const b = await card(s.fx, 'B');
    const seen = issue('mlg', 5);
    fakeMonitorState().issues = [seen];
    await link(s, a.id, 'mlg');
    const resolvedAt = new Date(seen.lastSeenAt.getTime() + 60_000);
    await adminDb.monitorIssue.updateMany({
      where: { externalIssueId: 'mlg' },
      data: {
        resolveState: 'resolved',
        resolveAttemptedAt: resolvedAt,
        resolvedByMotirAt: resolvedAt,
      },
    });

    await link(s, b.id, 'mlg', true);
    const bBefore = await adminDb.workItem.findUniqueOrThrow({ where: { id: b.id } });
    const bugsBefore = await bugCount(s.fx.projectId);
    const summary = await monitorIngestionService.pollConnection(s.webConnectionId);

    expect(summary).toMatchObject({ status: 'ok', filed: 0, refiled: 0 });
    expect(await bugCount(s.fx.projectId)).toBe(bugsBefore);
    const row = await rowOf('mlg');
    expect(row.workItemId).toBe(b.id);
    expect(row.resolvedByMotirAt?.toISOString()).toBe(resolvedAt.toISOString());
    const bAfter = await adminDb.workItem.findUniqueOrThrow({ where: { id: b.id } });
    expect(bAfter.updatedAt.toISOString()).toBe(bBefore.updatedAt.toISOString());
    expect(bAfter.status).toBe(bBefore.status);
  });
});

describe('seam — unlink → recurrence', () => {
  it('after an unlink, a poll that sees the issue again files exactly ONE new bug, and the next files none', async () => {
    const s = await monitorLinkScenario('Gate');
    const reported = await card(s.fx);
    fakeMonitorState().issues = [issue('ulr', 5)];
    await link(s, reported.id, 'ulr');
    const { id } = await rowOf('ulr');
    await monitorIssueLinkService.unlinkIssue(reported.id, id, s.fx.ctx);
    const bugsBefore = await bugCount(s.fx.projectId);

    fakeMonitorState().issues = [issue('ulr', 60)];
    const first = await monitorIngestionService.pollConnection(s.webConnectionId);
    fakeMonitorState().issues = [issue('ulr', 90, { eventCount: 9 })];
    const second = await monitorIngestionService.pollConnection(s.webConnectionId);

    expect(first).toMatchObject({ filed: 1 });
    expect(second).toMatchObject({ filed: 0, updated: 1 });
    expect(await bugCount(s.fx.projectId)).toBe(bugsBefore + 1);
    expect((await rowOf('ulr')).workItemId).not.toBe(reported.id);
  });
});

describe('seam — below the minimum level, linked', () => {
  it('is refreshed and files nothing while linked; once unlinked, the next poll skips it', async () => {
    const s = await monitorLinkScenario('Gate');
    const reported = await card(s.fx);
    fakeMonitorState().issues = [issue('bml', 5, { level: 'warning' })];
    await monitorConnectionService.setMinimumLevel(
      s.fx.projectId,
      s.webConnectionId,
      'error',
      s.fx.ctx,
    );
    await link(s, reported.id, 'bml');
    const bugsBefore = await bugCount(s.fx.projectId);

    fakeMonitorState().issues = [issue('bml', 30, { level: 'warning', eventCount: 55 })];
    const linked = await monitorIngestionService.pollConnection(s.webConnectionId);
    expect(linked).toMatchObject({ refreshed: 1, filed: 0 });
    expect((await rowOf('bml')).eventCount).toBe(55);

    await monitorIssueLinkService.unlinkIssue(reported.id, (await rowOf('bml')).id, s.fx.ctx);
    fakeMonitorState().issues = [issue('bml', 60, { level: 'warning', eventCount: 80 })];
    const unlinked = await monitorIngestionService.pollConnection(s.webConnectionId);

    expect(unlinked).toMatchObject({ refreshed: 0, skipped: 1, filed: 0 });
    expect(await bugCount(s.fx.projectId)).toBe(bugsBefore);
    expect(await adminDb.monitorIssue.count({ where: { externalIssueId: 'bml' } })).toBe(0);
  });
});

// ── (3) THE GUARDS COVERAGE CANNOT SEE ────────────────────────────────────────

describe('guard — the read path cannot reach a provider', () => {
  const FORBIDDEN = /from ['"]@\/lib\/monitors(\/providers\/[^'"]*|\/registry|)['"]/g;
  it.each([
    'lib/services/monitorIssueService.ts',
    'app/(authed)/items/[key]/_components/lateReads.ts',
    'app/(authed)/items/[key]/_components/MonitorErrorsSection.tsx',
    'app/(authed)/items/[key]/_components/MonitorErrorsCard.tsx',
  ])('%s imports nothing from the provider seam, its implementations or the registry', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    expect(source.match(FORBIDDEN) ?? []).toEqual([]);
  });
});

describe('guard — ONE closed resolve vocabulary', () => {
  it('the DTO’s resolve state IS the sync story’s exported union (a second declaration fails tsc)', () => {
    expectTypeOf<
      MonitorIssueLinkDto['resolve']['state']
    >().toEqualTypeOf<MonitorResolveState | null>();
  });
});

describe('guard — cross-tenant isolation on the read and the three writes', () => {
  it('workspace B can neither read, search, link nor unlink workspace A’s card — and the true population is untouched', async () => {
    const a = await monitorLinkScenario('TenantA');
    const b = await monitorLinkScenario('TenantB');
    const target = await card(a.fx);
    fakeMonitorState().issues = [issue('xt', 5)];
    await link(a, target.id, 'xt');
    const { id: rowId } = await rowOf('xt');
    const before = await adminDb.monitorIssue.findMany({ orderBy: { id: 'asc' } });
    expect(before).toHaveLength(1);

    const asB: ServiceContext = b.fx.ctx;
    await expect(monitorIssueService.listForWorkItem(target.id, asB)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
    await expect(
      monitorIssueLinkService.searchCandidates(target.id, '', asB),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(
      monitorIssueLinkService.linkIssue(
        target.id,
        { connectionId: b.webConnectionId, externalIssueId: 'xt', move: true },
        asB,
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(monitorIssueLinkService.unlinkIssue(target.id, rowId, asB)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );

    expect(await adminDb.monitorIssue.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });
});

describe('guard — search, link and unlink share ONE gate', () => {
  const ROLES = [
    ['browse only', ['project:browse'], false],
    ['browse + integration:manage', ['project:browse', 'integration:manage'], false],
    ['browse + work_item:edit', ['project:browse', 'work_item:edit'], true],
  ] as const;

  it.each(ROLES)(
    'a custom role holding %s is admitted by all three or refused by all three',
    async (label, permissions, admitted) => {
      const s = await monitorLinkScenario('Gate');
      const target = await card(s.fx);
      fakeMonitorState().issues = [issue('g1', 5), issue('g2', 6)];
      await link(s, target.id, 'g1');
      const { id: rowId } = await rowOf('g1');
      const actor = await memberWithPermissions(
        s.fx,
        [...permissions],
        `${label.replace(/\W+/g, '-')}@ex.com`,
      );

      const outcomes = await Promise.all([
        monitorIssueLinkService.searchCandidates(target.id, '', actor).then(
          () => 'admitted',
          (e: unknown) => (e instanceof PermissionDeniedError ? 'refused' : String(e)),
        ),
        monitorIssueLinkService
          .linkIssue(
            target.id,
            { connectionId: s.webConnectionId, externalIssueId: 'g2', move: false },
            actor,
          )
          .then(
            () => 'admitted',
            (e: unknown) => (e instanceof PermissionDeniedError ? 'refused' : String(e)),
          ),
      ]);
      const unlinked = await monitorIssueLinkService.unlinkIssue(target.id, rowId, actor).then(
        () => 'admitted',
        (e: unknown) => (e instanceof PermissionDeniedError ? 'refused' : String(e)),
      );

      const expected = admitted ? 'admitted' : 'refused';
      expect([...outcomes, unlinked]).toEqual([expected, expected, expected]);
    },
  );
});

// ── (1) THE ARMS THE PER-CARD SUITES LEFT ─────────────────────────────────────

describe('the link service’s remaining arms', () => {
  it(`searches only the first ${MONITOR_LINK_SEARCH_MAX_CONNECTIONS} connections by creation (ties by id) and says so`, async () => {
    const s = await monitorLinkScenario('Cap');
    const target = await card(s.fx);
    const web = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: s.webConnectionId },
    });
    // Two existing + nine more = eleven, all at ONE instant so the id breaks the tie.
    const at = new Date('2026-09-01T00:00:00.000Z');
    await adminDb.monitorConnection.updateMany({
      where: { projectId: s.fx.projectId },
      data: { createdAt: at },
    });
    for (let i = 0; i < MONITOR_LINK_SEARCH_MAX_CONNECTIONS - 1; i++) {
      await adminDb.monitorConnection.create({
        data: {
          projectId: s.fx.projectId,
          workspaceId: s.fx.workspaceId,
          installationId: web.installationId,
          externalProjectId: `extra-${i}`,
          externalProjectSlug: `extra-${i}`,
          createdAt: at,
        },
      });
    }
    const all = await adminDb.monitorConnection.findMany({
      where: { projectId: s.fx.projectId },
    });
    const expectedSearched = all
      .map((c) => c.externalProjectId)
      .sort((x, y) => {
        const ix = all.find((c) => c.externalProjectId === x)!.id;
        const iy = all.find((c) => c.externalProjectId === y)!.id;
        return ix.localeCompare(iy);
      })
      .slice(0, MONITOR_LINK_SEARCH_MAX_CONNECTIONS)
      .sort();

    const result = await monitorIssueLinkService.searchCandidates(target.id, 'x', s.fx.ctx);

    expect(result.truncated).toBe(true);
    expect(
      fakeMonitorState()
        .searches.map((c) => c.externalProjectId)
        .sort(),
    ).toEqual(expectedSearched);
  });

  it('a grant that recorded NO organisation still searches and links, and says so with a null org', async () => {
    const s = await monitorLinkScenario('NoOrg');
    const target = await card(s.fx);
    const web = await adminDb.monitorConnection.findUniqueOrThrow({
      where: { id: s.webConnectionId },
    });
    await adminDb.monitorInstallation.update({
      where: { id: web.installationId },
      data: { metadata: {} },
    });
    fakeMonitorState().issues = [issue('no', 5)];

    const result = await monitorIssueLinkService.searchCandidates(target.id, '', s.fx.ctx);
    expect(result.candidates.find((c) => c.externalIssueId === 'no')?.orgSlug).toBeNull();
    await expect(link(s, target.id, 'no')).resolves.toMatchObject({ outcome: 'linked' });
  });

  it('a search failure that is not a provider refusal reports its message — a thrown non-Error too', async () => {
    const s = await monitorLinkScenario('Throw');
    const target = await card(s.fx);
    const throwing: MonitorProvider = {
      ...fakeMonitorProvider,
      async searchIssues(input) {
        if (input.externalProjectId === 'fake-web') throw new Error('socket hang up');
        throw 'weird';
      },
    };
    registerMonitorProvider(throwing, 'sentry');

    const result = await monitorIssueLinkService.searchCandidates(target.id, 'x', s.fx.ctx);

    expect(result.failures.map((f) => [f.projectSlug, f.reason]).sort()).toEqual([
      ['web', 'socket hang up'],
      ['worker', 'weird'],
    ]);
  });

  it('a context read answering GONE after the issue read succeeded refuses the link and writes nothing', async () => {
    const s = await monitorLinkScenario('Gone');
    const target = await card(s.fx);
    fakeMonitorState().issues = [issue('race', 5)];
    registerMonitorProvider(
      {
        ...fakeMonitorProvider,
        async getIssueContext({ externalIssueId }) {
          throw new MonitorIssueGoneError('getIssueContext', externalIssueId, 'gone');
        },
      },
      'sentry',
    );

    await expect(link(s, target.id, 'race')).rejects.toBeInstanceOf(MonitorIssueGoneError);
    expect(await adminDb.monitorIssue.count()).toBe(0);
  });

  it('the fake names a failure with no stated reason by its status', async () => {
    fakeMonitorState().failSearchForProject.set('fake-web', { status: 503 });
    await expect(
      fakeMonitorProvider.searchIssues({
        accessToken: 't',
        orgSlug: 'o',
        externalProjectId: 'fake-web',
        query: '',
        limit: 5,
      }),
    ).rejects.toMatchObject({ status: 503, providerReason: 'The provider answered 503.' });
  });
});
