import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import {
  normalizeEventFrames,
  normalizeIssueContext,
  sentryMonitorProvider,
} from '@/lib/monitors/providers/sentry';
import { seedFakeMonitor } from '@/lib/monitors/e2eSeed';
import { MONITOR_ISSUE_FRAMES_MAX } from '@/lib/monitors/types';
import { SENTRY_LATEST_EVENT, sentryEventWithFrames } from '../fixtures/monitors/sentryLatestEvent';

// The latest event's STACK FRAMES through the provider seam (Story MOTIR-4930 ·
// Subtask MOTIR-5846). Nothing here reaches sentry.io: the adapter is driven
// through a stubbed `fetch`, and the fake calls none.

const realFetch = globalThis.fetch;

function stubFetchOnce(body: unknown): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return urls;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('Sentry adapter — frames on getIssueContext', () => {
  it('returns every usable frame of the surfaced exception, each with its file, function, line and in-app verdict', async () => {
    const urls = stubFetchOnce(SENTRY_LATEST_EVENT);
    const context = await sentryMonitorProvider.getIssueContext({
      accessToken: 't',
      orgSlug: 'm',
      externalIssueId: '4501',
    });
    // ONE request — the frames ride the read that already fetched the event.
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]!).pathname).toBe('/api/0/organizations/m/issues/4501/events/latest/');

    // The surfaced exception is the LAST value; the cause's Prisma frame is not
    // read while it carries frames of its own. The frame naming no file is
    // dropped: 7 usable frames of 8.
    expect(context.frames).toHaveLength(7);
    expect(context.frames.map((frame) => frame.filePath)).not.toContain(
      'node_modules/@prisma/client/runtime/library.js',
    );
    for (const frame of context.frames) expect(frame.filePath).toEqual(expect.any(String));

    expect(context.frames).toContainEqual({
      filePath: 'app/api/v1/work-items/[key]/route.ts',
      function: 'GET',
      lineNumber: 42,
      inApp: true,
    });
    // A frame the event states no line or function for carries null, not a guess.
    expect(context.frames).toContainEqual({
      filePath: 'lib/workItems/present.ts',
      function: null,
      lineNumber: null,
      inApp: true,
    });
    // `filename` absent ⇒ `absPath`.
    expect(context.frames).toContainEqual({
      filePath: '/app/lib/repositories/workItemRepository.ts',
      function: 'findByKey',
      lineNumber: 77,
      inApp: true,
    });
  });

  it('orders in-app frames first, then most-recent call first, over input in neither order', () => {
    const frames = normalizeEventFrames(SENTRY_LATEST_EVENT);
    expect(frames.map((frame) => [frame.filePath, frame.inApp])).toEqual([
      // In-app, most recent call first (the input's LAST in-app frame first).
      ['/app/lib/repositories/workItemRepository.ts', true],
      ['lib/workItems/present.ts', true],
      ['lib/services/workItemsService.ts', true],
      ['app/api/v1/work-items/[key]/route.ts', true],
      // Then everything else, most recent call first.
      ['node_modules/next/dist/server/lib/trace/tracer.js', false],
      ['node_modules/next/dist/server/base-server.js', false],
      ['node:internal/process/task_queues', false],
    ]);
  });

  it('cuts at MONITOR_ISSUE_FRAMES_MAX, keeping the in-app frame an unordered cut would drop', () => {
    const frames = normalizeEventFrames(sentryEventWithFrames(MONITOR_ISSUE_FRAMES_MAX + 7));
    expect(frames).toHaveLength(MONITOR_ISSUE_FRAMES_MAX);
    expect(frames[0]).toEqual({
      filePath: 'lib/boot.ts',
      function: 'boot',
      lineNumber: 1,
      inApp: true,
    });
    // Below the bound nothing is cut.
    expect(normalizeEventFrames(sentryEventWithFrames(3))).toHaveLength(4);
  });

  it('an event with no exception entry answers frames: [] — not an error, not null', async () => {
    stubFetchOnce({
      id: 'e2',
      tags: [{ key: 'environment', value: 'staging' }],
      release: { version: '1.0.0' },
      entries: [{ type: 'message', data: { formatted: 'Something happened' } }],
    });
    await expect(
      sentryMonitorProvider.getIssueContext({
        accessToken: 't',
        orgSlug: 'm',
        externalIssueId: '2',
      }),
    ).resolves.toEqual({ environment: 'staging', release: '1.0.0', frames: [] });
  });

  it('malformed exception shapes are absence, never a guess', () => {
    for (const event of [
      {},
      { entries: 'x' },
      { entries: [null, { type: 'exception' }] },
      { entries: [{ type: 'exception', data: { values: 'x' } }] },
      { entries: [{ type: 'exception', data: { values: [null, { stacktrace: null }] } }] },
      { entries: [{ type: 'exception', data: { values: [{ stacktrace: { frames: [{}, 7] } }] } }] },
    ]) {
      expect(normalizeEventFrames(event as Record<string, unknown>)).toEqual([]);
    }
    // A non-integer or non-positive line and a non-boolean in-app are null.
    expect(
      normalizeEventFrames({
        entries: [
          {
            type: 'exception',
            data: {
              values: [
                {
                  stacktrace: {
                    frames: [{ filename: 'a.ts', function: '', lineNo: 0, inApp: 'yes' }],
                  },
                },
              ],
            },
          },
        ],
      }),
    ).toEqual([{ filePath: 'a.ts', function: null, lineNumber: null, inApp: null }]);
  });

  it('falls back to an earlier chain value only when the surfaced one has no frames', () => {
    const frames = normalizeEventFrames({
      entries: [
        {
          type: 'exception',
          data: {
            values: [
              { stacktrace: { frames: [{ filename: 'lib/cause.ts', lineNo: 3, inApp: true }] } },
              { type: 'Error', stacktrace: { frames: [] } },
            ],
          },
        },
      ],
    });
    expect(frames.map((frame) => frame.filePath)).toEqual(['lib/cause.ts']);
  });

  it('environment and release are unchanged beside the frames', () => {
    const context = normalizeIssueContext(SENTRY_LATEST_EVENT);
    expect(context.environment).toBe('production');
    expect(context.release).toBe('motir-core@5dd0999');
  });
});

describe('fake provider — frames', () => {
  beforeEach(() => resetFakeMonitorProvider());

  it('returns the frames its seed declares, and [] by default', async () => {
    const declared = [
      {
        filePath: 'lib/services/workItemsService.ts',
        function: 'getByKey',
        lineNumber: 318,
        inApp: true,
      },
      {
        filePath: 'node_modules/next/dist/server/base-server.js',
        function: null,
        lineNumber: null,
        inApp: false,
      },
    ];
    seedFakeMonitor({
      issues: [
        {
          externalId: 'with',
          title: 'TypeError',
          firstSeenAt: '2026-09-20T00:00:00.000Z',
          lastSeenAt: '2026-09-20T00:00:00.000Z',
          frames: declared,
        },
        {
          externalId: 'without',
          title: 'Other',
          firstSeenAt: '2026-09-20T00:00:00.000Z',
          lastSeenAt: '2026-09-20T00:00:00.000Z',
        },
      ],
    });
    const read = (externalIssueId: string) =>
      fakeMonitorProvider.getIssueContext({ accessToken: 'x', orgSlug: 'y', externalIssueId });

    const withFrames = await read('with');
    expect(withFrames.frames).toEqual(declared);
    // A copy, so a consumer cannot mutate the fake's seed through the answer.
    withFrames.frames[0]!.lineNumber = 1;
    expect((await read('with')).frames[0]!.lineNumber).toBe(318);

    expect(await read('without')).toEqual({ environment: null, release: null, frames: [] });
    // Frames are a CONTEXT fact only: the issue shape the poll reads never carries them.
    const page = await fakeMonitorProvider.listIssuesSince({
      accessToken: 'x',
      orgSlug: 'y',
      externalProjectId: 'p',
      lastSeenAfter: null,
      cursor: null,
    });
    for (const issue of page.issues) expect(Object.keys(issue)).not.toContain('frames');
    expect(fakeMonitorState().contextReads).toEqual(['with', 'with', 'without']);
  });
});
