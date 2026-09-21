import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
  type FakeMonitorIssue,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import {
  monitorIssueRepository,
  type MonitorIssueEvidence,
} from '@/lib/repositories/monitorIssueRepository';
import {
  monitorIngestionService,
  type MonitorReconcileConnection,
} from '@/lib/services/monitorIngestionService';
import { monitorIssueLinkService } from '@/lib/services/monitorIssueLinkService';
import { monitorIssueService } from '@/lib/services/monitorIssueService';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { card, monitorLinkScenario, type MonitorLinkScenario } from './_monitorLinkFixtures';

// THE LINK KEEPS THE EVIDENCE (Story MOTIR-5975 · Subtask MOTIR-5979) — every
// SUCCESSFUL latest-event read stores the evidence on `monitor_issue`, a FAILED
// one moves only `evidence_checked_at`, a SKIPPED one moves nothing; the same
// for the hand-made link; a late read of an OLDER event never overwrites a
// newer one, under a real two-transaction race; and the card's error read
// returns it with no provider call.
//
// Against the FAKE provider registered under `sentry`, on real Postgres.

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

const EVENT_AT = new Date('2026-09-20T18:04:11.000Z');

function issue(externalId: string, overrides: Partial<FakeMonitorIssue> = {}): FakeMonitorIssue {
  return {
    externalId,
    title: `Error ${externalId}`,
    culprit: `lib/${externalId}.ts`,
    level: 'error',
    eventCount: 3,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(Date.now() + 5 * 60_000),
    permalink: null,
    assignee: null,
    externalProjectId: 'fake-web',
    environment: 'production',
    release: '1.4.2',
    frames: [
      {
        filePath: 'lib/services/githubWebhookService.ts',
        function: 'handle',
        lineNumber: 88,
        inApp: true,
      },
      { filePath: 'node_modules/next/server.js', function: null, lineNumber: 12, inApp: false },
    ],
    exception: { type: 'PrismaClientKnownRequestError', message: 'expired transaction' },
    rawTags: [
      { key: 'environment', value: 'production' },
      { key: 'user.email', value: 'someone@example.com' },
      { key: 'route', value: '/api/github/webhook' },
    ],
    requestMethod: 'POST',
    requestUrl: 'https://app.example/api/github/webhook?x=1',
    eventId: 'ev-1',
    eventAt: EVENT_AT,
    ...overrides,
  };
}

function target(s: MonitorLinkScenario): MonitorReconcileConnection {
  return {
    id: s.webConnectionId,
    projectId: s.fx.projectId,
    workspaceId: s.fx.workspaceId,
    boundByUserId: s.fx.ctx.userId,
    externalProjectSlug: 'web',
  };
}

const rowOf = (externalIssueId: string) =>
  adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId } });

/** The ten evidence columns, and only those — what "byte-identical" compares. */
async function evidenceColumns(externalIssueId: string) {
  const row = await rowOf(externalIssueId);
  return {
    exceptionType: row.exceptionType,
    exceptionMessage: row.exceptionMessage,
    frames: row.frames,
    tags: row.tags,
    requestMethod: row.requestMethod,
    requestPath: row.requestPath,
    eventId: row.eventId,
    eventAt: row.eventAt,
    evidenceReadAt: row.evidenceReadAt,
    evidenceCheckedAt: row.evidenceCheckedAt,
  };
}

describe('a reconcile visit', () => {
  it('whose read SUCCEEDS writes the evidence, evidence_read_at and evidence_checked_at', async () => {
    const s = await monitorLinkScenario('Evidence read');
    fakeMonitorState().issues = [issue('ok')];

    const summary = await monitorIngestionService.pollConnection(s.webConnectionId);

    expect(summary).toMatchObject({ status: 'ok', filed: 1 });
    const row = await rowOf('ok');
    expect(row).toMatchObject({
      exceptionType: 'PrismaClientKnownRequestError',
      exceptionMessage: 'expired transaction',
      requestMethod: 'POST',
      requestPath: '/api/github/webhook',
      eventId: 'ev-1',
      eventAt: EVENT_AT,
    });
    expect(row.frames).toEqual(issue('ok').frames);
    // The user-identifying tag was dropped at the seam and never reaches the row.
    expect(row.tags).toEqual([
      { key: 'environment', value: 'production' },
      { key: 'route', value: '/api/github/webhook' },
    ]);
    expect(JSON.stringify(row)).not.toContain('someone@example.com');
    expect(JSON.stringify(row)).not.toContain('x=1');
    expect(row.evidenceReadAt).not.toBeNull();
    expect(row.evidenceCheckedAt).toEqual(row.evidenceReadAt);
  });

  it('whose read FAILS changes only evidence_checked_at — the rest is byte-identical', async () => {
    const s = await monitorLinkScenario('Evidence failed');
    fakeMonitorState().issues = [issue('f')];
    await monitorIngestionService.pollConnection(s.webConnectionId);
    const before = await evidenceColumns('f');

    fakeMonitorState().issues = [
      issue('f', { eventCount: 9, lastSeenAt: new Date(Date.now() + 10 * 60_000) }),
    ];
    fakeMonitorState().failNextStatus.set('getIssueContext', { status: 500 });
    const summary = await monitorIngestionService.pollConnection(s.webConnectionId);

    expect(summary).toMatchObject({ status: 'ok', updated: 1 });
    const after = await evidenceColumns('f');
    expect({ ...after, evidenceCheckedAt: null }).toEqual({ ...before, evidenceCheckedAt: null });
    expect(after.evidenceCheckedAt!.getTime()).toBeGreaterThan(before.evidenceCheckedAt!.getTime());
    // The recurrence itself still landed — only the enrichment failed.
    expect((await rowOf('f')).eventCount).toBe(9);
  });

  it('SKIPPED by the read budget changes none of the evidence columns', async () => {
    const s = await monitorLinkScenario('Evidence skipped');
    fakeMonitorState().issues = [issue('sk')];
    await monitorIngestionService.pollConnection(s.webConnectionId);
    const before = await evidenceColumns('sk');

    await monitorIngestionService.reconcileIssue(target(s), issue('sk', { eventCount: 40 }), {
      outcome: 'skipped',
    });

    expect(await evidenceColumns('sk')).toEqual(before);
    expect((await rowOf('sk')).eventCount).toBe(40);
  });

  it('a read of an OLDER event than the stored one leaves the stored evidence', async () => {
    const s = await monitorLinkScenario('Evidence older');
    fakeMonitorState().issues = [issue('old')];
    await monitorIngestionService.pollConnection(s.webConnectionId);
    const before = await evidenceColumns('old');

    const older = new Date(EVENT_AT.getTime() - 60_000);
    await monitorIngestionService.reconcileIssue(target(s), issue('old'), {
      outcome: 'read',
      at: new Date(),
      context: {
        environment: 'production',
        release: '1.4.2',
        frames: [],
        exception: { type: 'Older', message: 'stale event' },
        tags: [],
        request: null,
        eventId: 'ev-0',
        eventAt: older,
      },
    });

    expect(await evidenceColumns('old')).toEqual(before);
  });
});

describe('the hand-made link', () => {
  it('writes the evidence on a successful read', async () => {
    const s = await monitorLinkScenario('Evidence link');
    const item = await card(s.fx);
    fakeMonitorState().issues = [issue('h')];

    await monitorIssueLinkService.linkIssue(
      item.id,
      { connectionId: s.webConnectionId, externalIssueId: 'h', move: false },
      s.fx.ctx,
    );

    const row = await rowOf('h');
    expect(row).toMatchObject({ exceptionType: 'PrismaClientKnownRequestError', eventId: 'ev-1' });
    expect(row.evidenceReadAt).not.toBeNull();
  });

  it('a FAILED read links with no evidence and stamps only the check', async () => {
    const s = await monitorLinkScenario('Evidence link failed');
    const item = await card(s.fx);
    fakeMonitorState().issues = [issue('hf')];
    fakeMonitorState().failNextStatus.set('getIssueContext', { status: 500 });

    await monitorIssueLinkService.linkIssue(
      item.id,
      { connectionId: s.webConnectionId, externalIssueId: 'hf', move: false },
      s.fx.ctx,
    );

    const columns = await evidenceColumns('hf');
    expect(columns.evidenceCheckedAt).not.toBeNull();
    expect({ ...columns, evidenceCheckedAt: null }).toEqual({
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
    });
  });

  it('a MOVE whose read fails keeps the evidence the first link stored', async () => {
    const s = await monitorLinkScenario('Evidence move');
    const first = await card(s.fx, 'First');
    const second = await card(s.fx, 'Second');
    fakeMonitorState().issues = [issue('m')];
    await monitorIssueLinkService.linkIssue(
      first.id,
      { connectionId: s.webConnectionId, externalIssueId: 'm', move: false },
      s.fx.ctx,
    );
    const before = await evidenceColumns('m');

    fakeMonitorState().failNextStatus.set('getIssueContext', { status: 503 });
    await monitorIssueLinkService.linkIssue(
      second.id,
      { connectionId: s.webConnectionId, externalIssueId: 'm', move: true },
      s.fx.ctx,
    );

    const after = await evidenceColumns('m');
    expect((await rowOf('m')).workItemId).toBe(second.id);
    expect({ ...after, evidenceCheckedAt: null }).toEqual({ ...before, evidenceCheckedAt: null });
    expect(after.evidenceCheckedAt!.getTime()).toBeGreaterThan(before.evidenceCheckedAt!.getTime());
  });
});

describe('two writers RACE on one link (real Postgres, two transactions at once)', () => {
  function evidenceAt(eventAt: Date, eventId: string): MonitorIssueEvidence {
    return {
      exceptionType: 'Error',
      exceptionMessage: eventId,
      frames: [],
      tags: [],
      requestMethod: null,
      requestPath: null,
      eventId,
      eventAt,
      readAt: new Date(),
    };
  }

  /** Run `first` in a transaction that holds its write until `second` has been
   *  issued and is blocked behind it, then commit — so `second` commits LAST. */
  async function race(rowId: string, first: MonitorIssueEvidence, second: MonitorIssueEvidence) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstWrote = false;
    const one = adminDb.$transaction(
      async (tx) => {
        firstWrote = await monitorIssueRepository.updateEvidenceIfNotOlder(rowId, first, tx);
        await held;
      },
      { timeout: 20_000 },
    );
    // Wait until the first transaction holds the row, then start the second,
    // which blocks on that row lock until the first commits.
    await vi.waitFor(() => expect(firstWrote).toBe(true));
    const two = adminDb.$transaction(
      (tx) => monitorIssueRepository.updateEvidenceIfNotOlder(rowId, second, tx),
      { timeout: 20_000 },
    );
    setTimeout(release, 300);
    const [, secondWrote] = await Promise.all([one, two]);
    return secondWrote;
  }

  const T1 = new Date('2026-09-20T10:00:00.000Z');
  const T2 = new Date('2026-09-20T11:00:00.000Z');

  it('the NEWER event committing last wins — the row holds T2', async () => {
    const s = await monitorLinkScenario('Race newer last');
    fakeMonitorState().issues = [issue('r1', { eventAt: null })];
    await monitorIngestionService.pollConnection(s.webConnectionId);
    const { id } = await rowOf('r1');

    const secondWrote = await race(id, evidenceAt(T1, 't1'), evidenceAt(T2, 't2'));

    expect(secondWrote).toBe(true);
    expect(await rowOf('r1')).toMatchObject({ eventAt: T2, eventId: 't2', exceptionMessage: 't2' });
  });

  it('the OLDER event committing last is a no-op — the row still holds T2, and nothing errors', async () => {
    const s = await monitorLinkScenario('Race older last');
    fakeMonitorState().issues = [issue('r2', { eventAt: null })];
    await monitorIngestionService.pollConnection(s.webConnectionId);
    const { id } = await rowOf('r2');

    const secondWrote = await race(id, evidenceAt(T2, 't2'), evidenceAt(T1, 't1'));

    expect(secondWrote).toBe(false);
    expect(await rowOf('r2')).toMatchObject({ eventAt: T2, eventId: 't2', exceptionMessage: 't2' });
  });
});

describe('the card’s error read', () => {
  it('returns the evidence and its state with NO provider call', async () => {
    const s = await monitorLinkScenario('Evidence read path');
    const item = await card(s.fx);
    fakeMonitorState().issues = [issue('rd')];
    await monitorIssueLinkService.linkIssue(
      item.id,
      { connectionId: s.webConnectionId, externalIssueId: 'rd', move: false },
      s.fx.ctx,
    );
    resetFakeMonitorProvider();
    const spies = (Object.keys(fakeMonitorProvider) as (keyof typeof fakeMonitorProvider)[])
      .filter((key) => typeof fakeMonitorProvider[key] === 'function')
      .map((key) => vi.spyOn(fakeMonitorProvider, key as never));

    const links = await monitorIssueService.listForWorkItem(item.id, s.fx.ctx);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(links).toHaveLength(1);
    expect(links[0]!.evidence).toMatchObject({
      state: 'present',
      stale: false,
      exception: { type: 'PrismaClientKnownRequestError', message: 'expired transaction' },
      request: { method: 'POST', path: '/api/github/webhook' },
      eventId: 'ev-1',
      eventAt: EVENT_AT.toISOString(),
      lastFailedAt: null,
    });
    expect(links[0]!.evidence.frames[0]).toMatchObject({ lineNumber: 88, inApp: true });
  });
});
