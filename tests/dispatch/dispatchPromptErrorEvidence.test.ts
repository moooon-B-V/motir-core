import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { monitorIssueLinkService } from '@/lib/services/monitorIssueLinkService';
import { monitorIssueService } from '@/lib/services/monitorIssueService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { card, monitorLinkScenario } from '../integration/monitors/_monitorLinkFixtures';

// The dispatch prompt carries the ERROR EVIDENCE of a work item's monitor links
// (Story MOTIR-5975 · Subtask MOTIR-5982) — read through the SAME
// `monitorIssueService.listForWorkItem` the page and `get_work_item` use, with
// no provider call. On real Postgres against the fake provider.

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

describe('getDispatchPrompt — error evidence', () => {
  it('a linked work item’s prompt carries its evidence, read with NO provider call', async () => {
    const s = await monitorLinkScenario('Prompt evidence');
    const item = await card(s.fx, 'A monitor bug');
    fakeMonitorState().issues = [
      {
        externalId: 'p1',
        title: 'PrismaClientKnownRequestError: expired transaction',
        culprit: null,
        level: 'error',
        eventCount: 7,
        firstSeenAt: new Date('2026-09-19T00:00:00.000Z'),
        lastSeenAt: new Date('2026-09-20T18:04:11.000Z'),
        permalink: null,
        assignee: null,
        externalProjectId: 'fake-web',
        frames: [
          {
            filePath: 'lib/services/githubWebhookService.ts',
            function: 'handle',
            lineNumber: 88,
            inApp: true,
          },
        ],
        exception: { type: 'PrismaClientKnownRequestError', message: 'expired transaction' },
        rawTags: [{ key: 'user.email', value: 'someone@example.com' }],
        requestMethod: 'POST',
        requestUrl: '/api/github/webhook?x=1',
        eventId: 'ev-1',
        eventAt: new Date('2026-09-20T18:04:11.000Z'),
      },
    ];
    await monitorIssueLinkService.linkIssue(
      item.id,
      { connectionId: s.webConnectionId, externalIssueId: 'p1', move: false },
      s.fx.ctx,
    );
    const read = vi.spyOn(monitorIssueService, 'listForWorkItem');
    const spies = (Object.keys(fakeMonitorProvider) as (keyof typeof fakeMonitorProvider)[])
      .filter((key) => typeof fakeMonitorProvider[key] === 'function')
      .map((key) => vi.spyOn(fakeMonitorProvider, key as never));

    const dto = await dispatchPromptService.getDispatchPrompt(
      s.fx.projectId,
      item.identifier,
      s.fx.ctx,
    );

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(item.id, s.fx.ctx);
    expect(dto.prompt).toContain('ERROR EVIDENCE');
    expect(dto.prompt).toContain('Exception: PrismaClientKnownRequestError');
    expect(dto.prompt).toContain('[app] lib/services/githubWebhookService.ts:88 handle');
    expect(dto.prompt).toContain('Request: POST /api/github/webhook');
    expect(dto.prompt).not.toContain('someone@example.com');
    expect(dto.prompt).not.toContain('x=1');
  });

  it('a work item with no link gets no ERROR EVIDENCE section', async () => {
    const s = await monitorLinkScenario('Prompt no evidence');
    const item = await card(s.fx, 'An ordinary bug');

    const dto = await dispatchPromptService.getDispatchPrompt(
      s.fx.projectId,
      item.identifier,
      s.fx.ctx,
    );

    expect(dto.prompt).not.toContain('ERROR EVIDENCE');
  });
});
