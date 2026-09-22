import { afterEach, describe, expect, it } from 'vitest';
import {
  boundEvidenceText,
  filterEvidenceTags,
  isUserIdentifyingTagKey,
  MONITOR_USER_IDENTIFYING_TAG_KEYS,
  requestPathOf,
} from '@/lib/monitors/evidence';
import {
  normalizeEventException,
  normalizeEventRequest,
  normalizeIssueContext,
  sentryMonitorProvider,
} from '@/lib/monitors/providers/sentry';
import {
  MONITOR_EVIDENCE_MESSAGE_MAX,
  MONITOR_EVIDENCE_PATH_MAX,
  MONITOR_EVIDENCE_TAG_VALUE_MAX,
  MONITOR_EVIDENCE_TAGS_MAX,
} from '@/lib/monitors/types';

// The latest event's EVIDENCE through the provider seam (Story MOTIR-5975 ·
// Subtask MOTIR-5977): the surfaced exception, the tags with user-identifying
// keys dropped, the request's method and path, and which event it was. Nothing
// here reaches sentry.io — the adapter is driven through a stubbed `fetch`.
//
// The event payloads are SHAPED FROM SENTRY'S DOCUMENTATION ("Event Payloads":
// the Exception, Request and Tags interfaces, read 2026-09-22), not captured.

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const HEADERS = { 'content-type': 'application/json', cookie: 'session=SECRET-COOKIE' };

/** A webhook failure: a Prisma cause, re-thrown as the surfaced error, on a POST
 *  whose URL carries a token and whose entry carries headers, cookies and a body. */
function webhookEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ev-1',
    eventID: '9fac2ceed9344f2bbfdd1fdacb0ed9b1',
    dateCreated: '2026-09-20T18:04:11.000Z',
    tags: [
      { key: 'environment', value: 'production' },
      { key: 'transaction', value: 'POST /api/github/webhook' },
      { key: 'user.email', value: 'someone@example.com' },
      { key: 'user', value: 'id:42' },
      { key: 'ip', value: '203.0.113.9' },
      { key: 'route', value: '/api/github/webhook' },
    ],
    entries: [
      {
        type: 'exception',
        data: {
          values: [
            {
              type: 'PrismaClientKnownRequestError',
              value: 'the CAUSE, never the surfaced message',
              stacktrace: { frames: [{ filename: 'node_modules/prisma.js', inApp: false }] },
            },
            {
              type: 'Error',
              value:
                'Transaction API error: A commit cannot be executed on an expired transaction.',
              stacktrace: {
                frames: [
                  { filename: 'lib/services/githubWebhookService.ts', lineNo: 88, inApp: true },
                ],
              },
            },
          ],
        },
      },
      {
        type: 'request',
        data: {
          method: 'POST',
          url: 'https://app.example/api/github/webhook?token=x#f',
          query: [['token', 'x']],
          headers: [['X-Hub-Signature', 'SECRET-HEADER']],
          cookies: [['session', 'SECRET-COOKIE']],
          data: { secretBody: 'SECRET-BODY' },
          env: { REMOTE_ADDR: '203.0.113.9' },
        },
      },
    ],
    ...overrides,
  };
}

describe('the surfaced EXCEPTION', () => {
  it('is the value the frames come from — the LAST with frames — not the cause', () => {
    expect(normalizeEventException(webhookEvent())).toEqual({
      type: 'Error',
      message: 'Transaction API error: A commit cannot be executed on an expired transaction.',
    });
  });

  it('falls back to the LAST value when no value in the chain carries frames', () => {
    const event = {
      entries: [
        {
          type: 'exception',
          data: {
            values: [
              { type: 'Cause', value: 'first' },
              { type: 'Surfaced', value: 'last' },
            ],
          },
        },
      ],
    };
    expect(normalizeEventException(event)).toEqual({ type: 'Surfaced', message: 'last' });
  });

  it('a message longer than the bound comes back at EXACTLY the bound, ending in …', () => {
    const long = 'x'.repeat(MONITOR_EVIDENCE_MESSAGE_MAX + 250);
    const event = {
      entries: [{ type: 'exception', data: { values: [{ type: 'Error', value: long }] } }],
    };
    const message = normalizeEventException(event)!.message!;
    expect(message).toHaveLength(MONITOR_EVIDENCE_MESSAGE_MAX);
    expect(message.endsWith('…')).toBe(true);
    // A message AT the bound is whole — nothing is cut that did not need to be.
    const exact = 'y'.repeat(MONITOR_EVIDENCE_MESSAGE_MAX);
    expect(
      normalizeEventException({
        entries: [{ type: 'exception', data: { values: [{ type: 'E', value: exact }] } }],
      })!.message,
    ).toBe(exact);
  });

  it('an event with no exception entry is exception null AND frames []', () => {
    const context = normalizeIssueContext({
      entries: [{ type: 'message', data: { formatted: 'Something happened' } }],
    });
    expect(context.exception).toBeNull();
    expect(context.frames).toEqual([]);
  });

  it('malformed values are absence, never a guess', () => {
    expect(normalizeEventException({ entries: 'nope' })).toBeNull();
    expect(
      normalizeEventException({ entries: [{ type: 'exception', data: { values: [null] } }] }),
    ).toBeNull();
    expect(
      normalizeEventException({
        entries: [{ type: 'exception', data: { values: [{ type: 7, value: '' }] } }],
      }),
    ).toBeNull();
    expect(
      normalizeEventException({
        entries: [{ type: 'exception', data: { values: [{ value: 'only a message' }] } }],
      }),
    ).toEqual({ type: null, message: 'only a message' });
  });
});

describe('the TAGS — user-identifying keys never leave the seam', () => {
  it('keeps environment, transaction and route; drops user.email, user and ip', () => {
    const { tags } = normalizeIssueContext(webhookEvent());
    expect(tags).toEqual([
      { key: 'environment', value: 'production' },
      { key: 'transaction', value: 'POST /api/github/webhook' },
      { key: 'route', value: '/api/github/webhook' },
    ]);
  });

  it('drops EVERY key in the denylist and every user.* key', () => {
    const raw = [
      ...MONITOR_USER_IDENTIFYING_TAG_KEYS.map((key) => ({ key, value: 'v' })),
      { key: 'user.id', value: '1' },
      { key: 'user.username', value: 'u' },
      { key: 'users', value: 'kept — not the user namespace' },
    ];
    expect(filterEvidenceTags(raw)).toEqual([
      { key: 'users', value: 'kept — not the user namespace' },
    ]);
    for (const key of MONITOR_USER_IDENTIFYING_TAG_KEYS)
      expect(isUserIdentifyingTagKey(key)).toBe(true);
    expect(isUserIdentifyingTagKey('user.email')).toBe(true);
    expect(isUserIdentifyingTagKey('route')).toBe(false);
  });

  it('more than the bound returns exactly the bound, in the order given', () => {
    const raw = Array.from({ length: MONITOR_EVIDENCE_TAGS_MAX + 12 }, (_, i) => ({
      key: `k${i}`,
      value: `v${i}`,
    }));
    const tags = normalizeIssueContext({ tags: raw }).tags;
    expect(tags).toHaveLength(MONITOR_EVIDENCE_TAGS_MAX);
    expect(tags[0]).toEqual({ key: 'k0', value: 'v0' });
    expect(tags.at(-1)).toEqual({
      key: `k${MONITOR_EVIDENCE_TAGS_MAX - 1}`,
      value: `v${MONITOR_EVIDENCE_TAGS_MAX - 1}`,
    });
  });

  it('a dropped tag does not spend the bound — the cut counts KEPT tags', () => {
    const raw = [
      { key: 'user.email', value: 'a@b.c' },
      ...Array.from({ length: MONITOR_EVIDENCE_TAGS_MAX }, (_, i) => ({
        key: `k${i}`,
        value: 'v',
      })),
    ];
    expect(filterEvidenceTags(raw)).toHaveLength(MONITOR_EVIDENCE_TAGS_MAX);
  });

  it('truncates a long value and drops any entry that is not a string pair', () => {
    const long = 'z'.repeat(MONITOR_EVIDENCE_TAG_VALUE_MAX + 5);
    expect(
      filterEvidenceTags([
        { key: 'long', value: long },
        { key: 'num', value: 7 },
        { key: '', value: 'no key' },
        null,
        'x',
      ]),
    ).toEqual([{ key: 'long', value: boundEvidenceText(long, MONITOR_EVIDENCE_TAG_VALUE_MAX) }]);
    expect(filterEvidenceTags('not an array')).toEqual([]);
  });
});

describe('the REQUEST — method and path, nothing else', () => {
  it('yields { POST, /api/github/webhook } and the serialised context carries no secret', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(webhookEvent()), {
        status: 200,
        headers: HEADERS,
      })) as typeof fetch;
    const context = await sentryMonitorProvider.getIssueContext({
      accessToken: 't',
      orgSlug: 'm',
      externalIssueId: '4501',
    });
    expect(context.request).toEqual({ method: 'POST', path: '/api/github/webhook' });
    const serialised = JSON.stringify(context);
    for (const secret of [
      'token=x',
      'SECRET-HEADER',
      'SECRET-COOKIE',
      'SECRET-BODY',
      '203.0.113.9',
      'someone@example.com',
    ]) {
      expect(serialised).not.toContain(secret);
    }
    // And which event it was.
    expect(context.eventId).toBe('9fac2ceed9344f2bbfdd1fdacb0ed9b1');
    expect(context.eventAt).toEqual(new Date('2026-09-20T18:04:11.000Z'));
  });

  it('an event with no request entry is request null', () => {
    expect(normalizeEventRequest({ entries: [] })).toBeNull();
    expect(normalizeIssueContext({}).request).toBeNull();
  });

  it('an unparsable URL is null; a method-less request keeps its path', () => {
    expect(
      normalizeEventRequest({
        entries: [{ type: 'request', data: { method: 'GET', url: 'http://[' } }],
      }),
    ).toBeNull();
    expect(
      normalizeEventRequest({
        entries: [{ type: 'request', data: { url: '/relative/path?q=1' } }],
      }),
    ).toEqual({ method: null, path: '/relative/path' });
  });

  it('requestPathOf keeps the pathname only, for absolute and relative URLs, bounded', () => {
    expect(requestPathOf('https://host.example:8443/a/b?c=d#e')).toBe('/a/b');
    expect(requestPathOf('/a/b?c=d')).toBe('/a/b');
    expect(requestPathOf('a/b#frag')).toBe('/a/b');
    expect(requestPathOf('https://host.example')).toBe('/');
    expect(requestPathOf('')).toBeNull();
    expect(requestPathOf(42)).toBeNull();
    expect(requestPathOf(null)).toBeNull();
    const path = requestPathOf(`/${'p'.repeat(MONITOR_EVIDENCE_PATH_MAX + 10)}`)!;
    expect(path).toHaveLength(MONITOR_EVIDENCE_PATH_MAX);
    expect(path.endsWith('…')).toBe(true);
  });
});

describe('WHICH event it was', () => {
  it('a malformed dateCreated is eventAt null; a missing eventID is eventId null', () => {
    const context = normalizeIssueContext({ eventID: 7, dateCreated: 'not a date' });
    expect(context.eventId).toBeNull();
    expect(context.eventAt).toBeNull();
  });
});
