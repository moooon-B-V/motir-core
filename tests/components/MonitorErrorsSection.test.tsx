// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';
import { MONITOR_RESOLVE_STATES } from '@/lib/monitors/syncStates';

// THE ERRORS SECTION'S ROWS (Story MOTIR-4932 · Subtask MOTIR-5732), one test per
// state `design/monitoring/design-notes.md` §14 draws — panels 1–4, 8, 9 and 10.
// The linking doors are MOTIR-5744's and are not here.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const {
  ErrorRow,
  MonitorErrorsList,
  MonitorErrorsLoadFailed,
  canWriteErrors,
  errorMetaLine,
  errorsSectionState,
  levelPillProps,
} = await import('@/app/(authed)/items/[key]/_components/MonitorErrorsSection');
const { evidenceView } =
  await import('@/app/(authed)/items/[key]/_components/MonitorErrorEvidence');

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

const NOW = new Date('2026-09-19T12:00:00.000Z');
const m = en.monitorErrors;

function link(overrides: Partial<MonitorIssueLinkDto> = {}): MonitorIssueLinkDto {
  return {
    id: 'mi-1',
    title: 'Payment provider returned 502 Bad Gateway',
    level: 'error',
    culprit: 'lib/pay.ts',
    permalink: 'https://acme.sentry.io/issues/1/',
    eventCount: 40_112,
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-19T11:57:00.000Z',
    environment: 'production',
    release: '2026.09.18-1',
    connection: { id: 'c1', orgSlug: 'acme', projectSlug: 'checkout-api' },
    resolve: { state: null, attemptedAt: null, resolvedAt: null, error: null },
    assigneeNote: null,
    evidence: {
      state: 'never_read',
      stale: false,
      exception: null,
      frames: [],
      tags: [],
      request: null,
      eventId: null,
      eventAt: null,
      readAt: null,
      lastFailedAt: null,
    },
    ...overrides,
  };
}

function renderRow(l: MonitorIssueLinkDto) {
  return render(
    <ul>
      <ErrorRow link={l} />
    </ul>,
    { now: NOW },
  );
}

describe('panel 1 — one link', () => {
  it('renders title → permalink, meta line, level pill, grouped count, relative last seen and the out-link', () => {
    renderRow(link());
    const row = screen.getByTestId('error-row');
    const title = within(row).getByRole('link', {
      name: 'Payment provider returned 502 Bad Gateway',
    });
    expect(title.getAttribute('href')).toBe('https://acme.sentry.io/issues/1/');
    expect(title.getAttribute('target')).toBe('_blank');
    expect(title.getAttribute('rel')).toBe('noopener noreferrer');
    expect(row.textContent).toContain('acme / checkout-api · production · 2026.09.18-1');
    expect(within(row).getByTestId('error-level').textContent).toBe('error');
    // Decision 2: full precision, grouped, never compacted to "40k".
    expect(within(row).getByTestId('error-count').textContent).toBe('40,112');
    expect(row.textContent).toContain('Seen 40,112 times');
    expect(row.textContent).toContain('last seen 3 minutes ago');
    expect(within(row).getByRole('link', { name: m.openInSentry })).toBeTruthy();
  });

  it('says "time" for a count of one', () => {
    renderRow(link({ eventCount: 1 }));
    expect(screen.getByTestId('error-row').textContent).toContain('Seen 1 time');
  });

  it('shows the absolute last-seen time on hover', () => {
    renderRow(link());
    const lastSeen = screen.getByText('last seen 3 minutes ago');
    expect(lastSeen.getAttribute('title')).toMatch(/Sep 19, 2026/);
  });
});

describe('the identifier line omits what is absent — never "unknown"', () => {
  it.each([
    [{ environment: null, release: null }, 'acme / checkout-api'],
    [{ environment: 'staging', release: null }, 'acme / checkout-api · staging'],
    [{ environment: null, release: '1.4.2' }, 'acme / checkout-api · 1.4.2'],
    [
      { connection: { id: 'c1', orgSlug: null, projectSlug: 'checkout-api' } },
      'checkout-api · production · 2026.09.18-1',
    ],
  ] as const)('%o → %s', (overrides, expected) => {
    expect(errorMetaLine(link(overrides as Partial<MonitorIssueLinkDto>))).toBe(expected);
  });

  it('renders the absent case with no placeholder word', () => {
    renderRow(link({ environment: null, release: null }));
    const row = screen.getByTestId('error-row');
    expect(row.textContent).not.toMatch(/unknown/i);
    expect(row.textContent).toContain('acme / checkout-api');
  });
});

describe('Decision 3 — the level pill', () => {
  it.each([
    ['fatal', { severity: 'danger' }],
    ['error', { severity: 'danger' }],
    ['warning', { severity: 'warning' }],
    ['info', { severity: 'info' }],
    ['debug', { tone: 'neutral' }],
    ['fatalish', { tone: 'neutral' }],
    [null, null],
  ] as const)('%s → %o', (level, props) => {
    expect(levelPillProps(level)).toEqual(props);
  });

  it('an unrecognised level renders VERBATIM in a neutral pill, and a null level renders no pill', () => {
    renderRow(link({ level: 'fatalish' }));
    expect(screen.getByTestId('error-level').textContent).toBe('fatalish');
    cleanup();
    renderRow(link({ level: null }));
    expect(screen.queryByTestId('error-level')).toBeNull();
  });
});

describe('panel 3 — one resolve line per resolve.state value', () => {
  it('covers every member of the closed union plus null', () => {
    // A new member added to the vocabulary must be given a line here too.
    expect([...MONITOR_RESOLVE_STATES].sort()).toEqual(['failed', 'gone', 'pending', 'resolved']);
  });

  it('null draws nothing', () => {
    renderRow(link());
    expect(screen.getByTestId('error-row').querySelector('[data-note^="resolve"]')).toBeNull();
  });

  it('pending: "Resolving in Sentry…"', () => {
    renderRow(
      link({
        resolve: {
          state: 'pending',
          attemptedAt: NOW.toISOString(),
          resolvedAt: null,
          error: null,
        },
      }),
    );
    expect(document.querySelector('[data-note="resolve-pending"]')?.textContent).toBe(
      m.resolve.pending,
    );
  });

  it('resolved: names Motir and WHEN, relative with the absolute on hover', () => {
    renderRow(
      link({
        resolve: {
          state: 'resolved',
          attemptedAt: '2026-09-19T11:55:00.000Z',
          resolvedAt: '2026-09-19T11:56:00.000Z',
          error: null,
        },
      }),
    );
    const note = document.querySelector('[data-note="resolve-resolved"]')!;
    expect(note.textContent).toBe('Resolved in Sentry by Motir 4 minutes ago');
    expect(
      within(note as HTMLElement)
        .getByText('4 minutes ago')
        .getAttribute('title'),
    ).toMatch(/2026/);
  });

  it('failed: the provider reason VERBATIM and "Tried <when>" from attemptedAt, on the warning surface', () => {
    renderRow(
      link({
        resolve: {
          state: 'failed',
          attemptedAt: '2026-09-19T11:51:00.000Z',
          resolvedAt: null,
          error: '403 You do not have permission to perform this action.',
        },
      }),
    );
    const note = document.querySelector('[data-note="resolve-failed"]')!;
    expect(note.textContent).toBe(
      "Couldn't resolve this in Sentry: 403 You do not have permission to perform this action. Tried 9 minutes ago — Motir tries again at the next check.",
    );
    expect(note.className).toContain('bg-(--el-warning-surface)');
  });

  it('gone: stays listed, muted, NOT a link, no out-link, and says so', () => {
    renderRow(
      link({ resolve: { state: 'gone', attemptedAt: null, resolvedAt: null, error: null } }),
    );
    const row = screen.getByTestId('error-row');
    expect(row.className).toContain('bg-(--el-surface-soft)');
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).getByText('Payment provider returned 502 Bad Gateway').className).toContain(
      'text-(--el-text-secondary)',
    );
    expect(document.querySelector('[data-note="resolve-gone"]')?.textContent).toBe(
      'Sentry no longer has this error. Its facts are as they were last seen.',
    );
  });
});

describe('panel 4 — the assignee note', () => {
  it.each([
    ['team_assignee', m.assignee.teamAssignee],
    ['no_matching_member', m.assignee.noMatch],
  ] as const)('%s renders its quiet line', (note, copy) => {
    renderRow(link({ assigneeNote: note }));
    expect(document.querySelector(`[data-note="assignee-${note}"]`)?.textContent).toBe(copy);
  });

  it('with both, the resolve line comes first and the note second', () => {
    renderRow(
      link({
        assigneeNote: 'team_assignee',
        resolve: {
          state: 'pending',
          attemptedAt: NOW.toISOString(),
          resolvedAt: null,
          error: null,
        },
      }),
    );
    const notes = [...document.querySelectorAll('[data-note]')].map((n) =>
      n.getAttribute('data-note'),
    );
    expect(notes).toEqual(['resolve-pending', 'assignee-team_assignee']);
  });
});

describe('Decision 5 — who sees the write controls', () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])('canEdit=%s, hasConnection=%s → %s', (canEdit, hasConnection, expected) => {
    expect(canWriteErrors(canEdit, hasConnection)).toBe(expected);
  });

  it.each([true, false])(
    'the × follows canWrite=%s, and the rows render either way',
    (canWrite) => {
      render(
        <MonitorErrorsList
          links={[link()]}
          canWrite={canWrite}
          unlinkAction={vi.fn()}
          workItemId="wi"
          identifier="ACME-1"
        />,
        { now: NOW },
      );
      expect(screen.getAllByTestId('error-row')).toHaveLength(1);
      const x = screen.queryByRole('button', {
        name: m.unlink.aria.replace('{title}', 'Payment provider returned 502 Bad Gateway'),
      });
      expect(x !== null).toBe(canWrite);
    },
  );
});

describe('the section’s own state — panels 5a and 10', () => {
  it.each([
    [null, true, 'failed'],
    [null, false, 'hidden'],
    [[], true, 'hidden'],
    [[], false, 'hidden'],
  ] as const)('links=%o, hasConnection=%s → %s', (links, hasConnection, expected) => {
    expect(errorsSectionState(links as MonitorIssueLinkDto[] | null, hasConnection)).toBe(expected);
  });

  it('any link → rows', () => {
    expect(errorsSectionState([link()], false)).toBe('rows');
  });

  it('a failed read names itself, with a retry that refreshes the page', () => {
    render(<MonitorErrorsLoadFailed />);
    expect(screen.getByText(m.loadFailedTitle)).toBeTruthy();
    expect(screen.getByText(m.loadFailedBody)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: en.common.retry }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('panel 8 — unlink', () => {
  const aria = m.unlink.aria.replace('{title}', 'Payment provider returned 502 Bad Gateway');

  type UnlinkAction = Parameters<typeof MonitorErrorsList>[0]['unlinkAction'];
  function renderList(unlinkAction: UnlinkAction) {
    render(
      <MonitorErrorsList
        links={[link()]}
        canWrite
        unlinkAction={unlinkAction}
        workItemId="wi-1"
        identifier="ACME-1"
      />,
      { now: NOW },
    );
    fireEvent.click(screen.getByRole('button', { name: aria }));
  }

  it('the confirm states the CONSEQUENCE, and confirming unlinks and refreshes', async () => {
    const unlinkAction = vi.fn(async () => ({ ok: true as const, removed: true }));
    renderList(unlinkAction);
    expect(document.body.textContent).toContain(
      'Remove the link to Payment provider returned 502 Bad Gateway? If this error happens again, a new bug will be filed for it.',
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: m.unlink.action }));
    });
    expect(unlinkAction).toHaveBeenCalledWith({
      workItemId: 'wi-1',
      identifier: 'ACME-1',
      monitorIssueId: 'mi-1',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('removed: false is NOT a silent success — it says there was nothing to unlink', async () => {
    renderList(vi.fn(async () => ({ ok: true as const, removed: false })));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: m.unlink.action }));
    });
    expect(screen.getByRole('alert').textContent).toBe(m.unlink.nothing);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, code: 'forbidden' }, m.error.forbidden],
    [{ ok: false, code: 'not_found' }, m.error.notFound],
    [{ ok: false, code: 'provider_failed', reason: 'boom' }, 'The link could not be removed: boom'],
  ] as const)('a refusal %o shows its line', async (result, copy) => {
    renderList(vi.fn(async () => result) as UnlinkAction);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: m.unlink.action }));
    });
    expect(screen.getByRole('alert').textContent).toBe(copy);
  });
});

describe('locales', () => {
  function keys(obj: unknown, prefix = ''): string[] {
    if (typeof obj !== 'object' || obj === null) return [prefix];
    return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
  }

  it('every monitorErrors key this section uses exists in both en and zh', () => {
    expect(keys(zh.monitorErrors).sort()).toEqual(keys(en.monitorErrors).sort());
  });

  it('renders in zh', () => {
    render(
      <ul>
        <ErrorRow link={link()} />
      </ul>,
      { now: NOW, locale: 'zh', messages: zh },
    );
    expect(screen.getByTestId('error-row').textContent).toContain('出现 40,112 次');
  });
});

describe('the remaining row arms', () => {
  it('a live issue with no permalink: the title is plain text and the out-link is a spacer', () => {
    renderRow(link({ permalink: null }));
    const row = screen.getByTestId('error-row');
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).getByText('Payment provider returned 502 Bad Gateway').className).toContain(
      'text-(--el-text)',
    );
  });

  it('resolve lines written without their timestamps (none is) still read as sentences', () => {
    renderRow(
      link({ resolve: { state: 'resolved', attemptedAt: null, resolvedAt: null, error: null } }),
    );
    expect(document.querySelector('[data-note="resolve-resolved"]')?.textContent).toBe(
      'Resolved in Sentry by Motir ',
    );
    cleanup();
    renderRow(
      link({ resolve: { state: 'failed', attemptedAt: null, resolvedAt: null, error: null } }),
    );
    expect(document.querySelector('[data-note="resolve-failed"]')?.textContent).toBe(
      "Couldn't resolve this in Sentry:  Tried  — Motir tries again at the next check.",
    );
  });

  it('unlink: Cancel and Escape both close the confirm without unlinking', async () => {
    const unlinkAction = vi.fn();
    render(
      <MonitorErrorsList
        links={[link()]}
        canWrite
        unlinkAction={unlinkAction}
        workItemId="wi-1"
        identifier="ACME-1"
      />,
      { now: NOW },
    );
    const aria = m.unlink.aria.replace('{title}', 'Payment provider returned 502 Bad Gateway');
    fireEvent.click(screen.getByRole('button', { name: aria }));
    fireEvent.click(await screen.findByRole('button', { name: en.common.cancel }));
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: m.unlink.action })).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: aria }));
    fireEvent.keyDown(await screen.findByRole('button', { name: m.unlink.action }), {
      key: 'Escape',
    });
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: m.unlink.action })).toBeNull(),
    );
    expect(unlinkAction).not.toHaveBeenCalled();
  });
});

// ── THE EVIDENCE BLOCK (Story MOTIR-5975 · Subtask MOTIR-5980), drawn by
// `design/monitoring/work-item-errors--evidence.mock.html` + design-notes §15.
describe('§15 — the EVIDENCE block inside a row', () => {
  const e = en.monitorErrors.evidence;
  const frames = [
    {
      filePath: 'lib/services/githubWebhookService.ts',
      function: 'upsertPr',
      lineNumber: 412,
      inApp: true,
    },
    { filePath: 'app/api/github/webhook/route.ts', function: null, lineNumber: 74, inApp: true },
    { filePath: 'node_modules/next/server.js', function: 'handle', lineNumber: null, inApp: false },
    { filePath: 'node_modules/prisma/runtime.js', function: 'commit', lineNumber: 9, inApp: null },
  ];
  const present: MonitorIssueLinkDto['evidence'] = {
    state: 'present',
    stale: false,
    exception: { type: 'PrismaClientKnownRequestError', message: 'expired transaction' },
    frames,
    tags: Array.from({ length: 14 }, (_, i) => ({ key: `k${i}`, value: `v${i}` })),
    request: { method: 'POST', path: '/api/github/webhook' },
    eventId: '3f9a1c7e04b2d88a91c0',
    eventAt: '2026-09-19T11:50:00.000Z',
    readAt: '2026-09-19T11:52:00.000Z',
    lastFailedAt: null,
  };
  const withEvidence = (evidence: Partial<MonitorIssueLinkDto['evidence']>) =>
    link({ evidence: { ...present, ...evidence } });
  const row = (l: MonitorIssueLinkDto) => {
    renderRow(l);
    return screen.getByTestId('error-row');
  };
  const open = () => fireEvent.click(screen.getByRole('button', { name: new RegExp(e.show) }));

  it('evidenceView is TOTAL over state × stale', () => {
    for (const state of ['never_read', 'present', 'no_exception'] as const) {
      for (const stale of [false, true]) {
        const view = evidenceView({ state, stale });
        if (state === 'never_read') expect(view).toEqual({ kind: 'never_read' });
        else expect(view).toEqual({ kind: 'block', exception: state === 'present', stale });
      }
    }
  });

  it('present: collapsed by default, the door summarises type · request · latest event', () => {
    const r = row(withEvidence({ state: 'present' }));
    const door = within(r).getByRole('button', { name: new RegExp(e.show) });
    expect(door.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('evidence-block')).toBeNull();
    const summary = within(r).getByTestId('evidence-summary').textContent!;
    expect(summary).toContain('PrismaClientKnownRequestError');
    expect(summary).toContain('POST /api/github/webhook');
    expect(summary).toContain('latest event');
  });

  it('present, open: exception, request, in-app frames with framework folded, tags, footer', () => {
    row(withEvidence({ state: 'present' }));
    open();
    const block = screen.getByTestId('evidence-block');
    expect(block.textContent).toContain('PrismaClientKnownRequestError: expired transaction');
    expect(block.textContent).toContain('POST /api/github/webhook');
    expect(block.textContent).toContain('2 in your code · 2 framework · most recent call first');
    // In-app frames show as path:line and "in function"; a null function drops "in …".
    expect(block.textContent).toContain('lib/services/githubWebhookService.ts:412');
    expect(block.textContent).toContain('in upsertPr');
    expect(block.textContent).toContain('app/api/github/webhook/route.ts:74');
    expect(block.querySelectorAll('[data-frame="framework"]')).toHaveLength(0);
    fireEvent.click(within(block).getByRole('button', { name: 'Show 2 framework frames' }));
    const fw = block.querySelectorAll('[data-frame="framework"]');
    expect(fw).toHaveLength(2);
    // A null lineNumber prints the path alone — never "unknown"; inApp null is framework.
    expect(fw[0]!.textContent).toBe('node_modules/next/server.jsin handle');
    expect(fw[1]!.textContent).toContain('node_modules/prisma/runtime.js:9');
    // 12 tags, then the fold.
    expect(block.querySelectorAll('[data-tag]')).toHaveLength(12);
    fireEvent.click(within(block).getByRole('button', { name: 'Show all 14 tags' }));
    expect(block.querySelectorAll('[data-tag]')).toHaveLength(14);
    expect(block.textContent).toContain('Event 3f9a1c7e04b2…');
    expect(block.textContent).toContain('Latest event');
    expect(screen.queryByText(new RegExp('out of date'))).toBeNull();
  });

  it('a trace with NO in-app frame shows flat and ungrouped', () => {
    row(withEvidence({ state: 'present', frames: frames.slice(2) }));
    open();
    const block = screen.getByTestId('evidence-block');
    expect(block.textContent).toContain('2 frames, most recent call first');
    expect(within(block).queryByRole('button', { name: /framework frames/ })).toBeNull();
  });

  it('never_read: NO door, the quiet clock note', () => {
    const r = row(
      withEvidence({
        state: 'never_read',
        exception: null,
        frames: [],
        tags: [],
        request: null,
        eventId: null,
        eventAt: null,
        readAt: null,
      }),
    );
    expect(within(r).queryByRole('button', { name: new RegExp(e.show) })).toBeNull();
    expect(r.textContent).toContain(e.neverRead);
  });

  it('no_exception: the door says so, the block opens on the quiet sentence and keeps request + tags', () => {
    row(withEvidence({ state: 'no_exception', exception: null, frames: [] }));
    expect(screen.getByTestId('evidence-summary').textContent).toContain(e.summaryNoException);
    open();
    const block = screen.getByTestId('evidence-block');
    expect(block.textContent).toContain(e.noException);
    expect(block.textContent).not.toContain(e.stackTrace);
    expect(block.textContent).toContain('POST /api/github/webhook');
    expect(block.querySelectorAll('[data-tag]').length).toBeGreaterThan(0);
  });

  it('stale: the OLD evidence still shows with its event time, under the failed-check line', () => {
    row(withEvidence({ state: 'present', stale: true, lastFailedAt: '2026-09-19T11:58:00.000Z' }));
    expect(screen.getByTestId('evidence-summary').textContent).toContain(e.summaryStale);
    open();
    const block = screen.getByTestId('evidence-block');
    const stale = block.querySelector('[data-evidence-block="stale"]')!;
    expect(stale.textContent).toContain('The last check failed');
    expect(block.textContent).toContain('PrismaClientKnownRequestError: expired transaction');
  });

  it('gone: the evidence is KEPT and not marked stale', () => {
    row(
      link({
        resolve: { state: 'gone', attemptedAt: null, resolvedAt: null, error: null },
        evidence: { ...present, stale: true, lastFailedAt: '2026-09-19T11:58:00.000Z' },
      }),
    );
    expect(screen.getByTestId('evidence-summary').textContent).not.toContain(e.summaryStale);
    open();
    expect(
      screen.getByTestId('evidence-block').querySelector('[data-evidence-block="stale"]'),
    ).toBeNull();
  });

  it('the list is a @container, so the rows’ narrow rules can apply', () => {
    render(
      <MonitorErrorsList
        links={[link()]}
        canWrite={false}
        unlinkAction={vi.fn()}
        workItemId="wi"
        identifier="MOT-1"
      />,
      { now: NOW },
    );
    expect(screen.getByTestId('errors-list').className).toContain('@container');
  });

  it('renders the block in zh', () => {
    render(
      <ul>
        <ErrorRow link={withEvidence({ state: 'present' })} />
      </ul>,
      { now: NOW, locale: 'zh', messages: zh },
    );
    fireEvent.click(
      screen.getByRole('button', { name: new RegExp(zh.monitorErrors.evidence.show) }),
    );
    expect(screen.getByTestId('evidence-block').textContent).toContain(
      zh.monitorErrors.evidence.exception,
    );
  });
});

describe('§15 — the evidence block’s remaining arms', () => {
  const base: MonitorIssueLinkDto['evidence'] = {
    state: 'present',
    stale: false,
    exception: { type: 'Error', message: 'short' },
    frames: [],
    tags: [],
    request: null,
    eventId: 'abcdef0123456789',
    eventAt: '2026-09-19T11:50:00.000Z',
    readAt: '2026-09-19T11:52:00.000Z',
    lastFailedAt: null,
  };
  const openRow = (evidence: Partial<MonitorIssueLinkDto['evidence']>) => {
    renderRow(link({ evidence: { ...base, ...evidence } }));
    fireEvent.click(screen.getByRole('button', { name: /Show evidence/ }));
    return screen.getByTestId('evidence-block');
  };

  it('a long message is clamped with a fold that opens and closes it — never cut', () => {
    const block = openRow({ exception: { type: 'Error', message: 'x'.repeat(400) } });
    expect(screen.getByTestId('evidence-message').className).toContain('line-clamp-4');
    fireEvent.click(within(block).getByRole('button', { name: 'Show full message' }));
    expect(screen.getByTestId('evidence-message').className).not.toContain('line-clamp-4');
    fireEvent.click(within(block).getByRole('button', { name: 'Show less' }));
    expect(screen.getByTestId('evidence-message').className).toContain('line-clamp-4');
  });

  it('a type-only and a message-only exception each print what they have', () => {
    expect(openRow({ exception: { type: 'TypeOnly', message: null } }).textContent).toContain(
      'TypeOnly',
    );
    cleanup();
    const block = openRow({ exception: { type: null, message: 'only the message' } });
    expect(block.textContent).toContain('only the message');
    expect(block.textContent).not.toContain('null');
  });

  it('a request with no method prints the path alone; no event id and no event time drop their parts', () => {
    const block = openRow({ request: { method: null, path: '/p' }, eventId: null, eventAt: null });
    expect(block.querySelector('[data-evidence-block="request"]')!.textContent).toContain('/p');
    expect(block.textContent).not.toContain('Event ');
    expect(screen.getByTestId('evidence-summary').textContent).not.toContain('latest event');
  });

  it('stale with no event time still names the failed check', () => {
    const block = openRow({ stale: true, eventAt: null, lastFailedAt: '2026-09-19T11:58:00.000Z' });
    expect(block.querySelector('[data-evidence-block="stale"]')!.textContent).toContain(
      'The last check failed',
    );
  });

  it('copies the WHOLE event id, says Copied, and a denied clipboard says so and leaves the id', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const block = openRow({});
    await act(async () => {
      fireEvent.click(within(block).getByRole('button', { name: 'Copy event ID' }));
    });
    expect(writeText).toHaveBeenCalledWith('abcdef0123456789');
    expect(block.textContent).toContain('Copied');
    expect(block.textContent).toContain('Event abcdef012345…');

    writeText.mockRejectedValueOnce(new Error('denied'));
    await act(async () => {
      fireEvent.click(within(block).getByRole('button', { name: 'Copy event ID' }));
    });
    expect(block.textContent).toContain("Couldn't copy — select the ID instead.");
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('closing the door hides the block again', () => {
    openRow({});
    fireEvent.click(screen.getByRole('button', { name: /Hide evidence/ }));
    expect(screen.queryByTestId('evidence-block')).toBeNull();
  });
});
