// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { CodeHealthClient } from '@/app/(authed)/code-health/_components/CodeHealthClient';
import type { CodeAuditFindingDTO, CodeAuditSurfaceDTO } from '@/lib/dto/codeHealth';

// The /code-health island's remaining paths — the ones the per-repo-read and
// resume suites do not drive. They are gathered here because MOTIR-2223 puts the
// run's lifecycle in this file for the first time, and the per-file coverage
// floor is measured on the file, not on the diff: a path nothing exercises is a
// path the next change to the run breaks silently.
//
// Covered here: the load-error strip and its retry, a project with NO connected
// repo (both at seed time and as a stored report whose repos were later
// disconnected), findings pagination (success · failure), the convention tab,
// the deepen dismiss/re-open flags, a re-audit whose POST fails, and both ends
// of the 60-second poll window (State D on a first audit, the pending strip on
// a RE-audit).

const REPOS = ['moooon/motir-ai', 'moooon/motir-core'];

function finding(ruleId: string): CodeAuditFindingDTO {
  return {
    ruleId,
    category: 'structure',
    severity: 'high',
    why: `${ruleId} explanation`,
    fileRef: 'lib/x.ts',
    symbolRef: null,
    conventionRuleRef: null,
  };
}

function surface(over: Partial<CodeAuditSurfaceDTO> = {}): CodeAuditSurfaceDTO {
  return {
    audit: {
      id: 'audit_1',
      healthSummary: { grade: 'B', conformancePct: 78 },
      codeGraphRef: null,
      repoKey: REPOS[0]!,
      createdAt: '2026-08-05T00:00:00.000Z',
    },
    findings: [finding('no-god-object')],
    total: 2,
    nextOffset: 1,
    scanner: { detected: [], ingested: null, noExternalScanner: true, suggestion: null },
    ...over,
  };
}

const EMPTY_AUDIT: CodeAuditSurfaceDTO = {
  audit: null,
  findings: [],
  total: 0,
  nextOffset: null,
  scanner: null,
};

interface Call {
  url: string;
  method: string;
}
let calls: Call[] = [];
let auditReply: (url: string) => Promise<Response>;
let conventionOk = true;
let refreshOk = true;

function json(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}
const notOk = () => ({ ok: false, status: 500, json: async () => ({}) }) as Response;

beforeEach(() => {
  calls = [];
  conventionOk = true;
  refreshOk = true;
  auditReply = () => Promise.resolve(json(EMPTY_AUDIT));
  localStorage.clear();
  vi.stubGlobal('fetch', (input: string, init?: { method?: string }) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.startsWith('/api/ai/jobs/')) return Promise.resolve(json({ status: 'succeeded' }));
    if (url.includes('/convention')) {
      if (!conventionOk) return Promise.resolve(notOk());
      const repoKey = new URL(url, 'http://t').searchParams.get('repoKey') ?? '';
      return Promise.resolve(
        json({
          repoKey,
          convention: {
            id: `conv_${repoKey}`,
            repoKey,
            version: 1,
            contentMd: `# ${repoKey} house rules`,
            provenance: [],
            createdAt: '2026-08-04T00:00:00.000Z',
          },
          versions: [],
          nextCursor: null,
        }),
      );
    }
    if (url.includes('/audit')) return auditReply(url);
    return refreshOk ? Promise.resolve(json({ repos: [] })) : Promise.resolve(notOk());
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(
  over: {
    repoRefs?: string[];
    initialAudit?: CodeAuditSurfaceDTO | null;
    loadError?: string | false;
  } = {},
) {
  return renderWithIntl(
    <CodeHealthClient
      projectId="proj_1"
      repoRefs={over.repoRefs ?? REPOS}
      initialAudit={over.initialAudit ?? null}
      initialConventions={[]}
      loadError={over.loadError ?? false}
    />,
  );
}

const click = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

describe('CodeHealthClient — the island’s remaining paths', () => {
  it('a server-side load error renders the strip, and Retry re-reads both surfaces', async () => {
    render({ loadError: 'MOTIR_AI_UNAVAILABLE: down' });
    expect(screen.getByText(/Couldn’t load code health/)).toBeTruthy();

    auditReply = () => Promise.resolve(json(surface()));
    await click('Retry');

    // The strip clears on a successful re-read, and the report replaces it.
    expect(screen.queryByText(/Couldn’t load code health/)).toBeNull();
    expect(screen.getByText('B')).toBeTruthy();
  });

  it('a Retry whose read FAILS puts the strip back rather than blanking the page', async () => {
    render({ loadError: 'MOTIR_AI_UNAVAILABLE: down' });
    conventionOk = false;
    await click('Retry');

    expect(
      screen.getByText('Couldn’t load code health. Motir AI may be unavailable.'),
    ).toBeTruthy();
  });

  it('a project with NO connected repo reads nothing at all — there is no repoKey to scope by', async () => {
    render({ repoRefs: [], loadError: 'MOTIR_AI_UNAVAILABLE: down' });
    await click('Retry');

    // Both boundary reads REQUIRE a repoKey, so an unscoped fetch would be a 400.
    expect(calls).toHaveLength(0);
    expect(screen.getByText('No codebase to analyze yet')).toBeTruthy();
  });

  it('“Show more” appends the next findings page and stops when the offset runs out', async () => {
    render({ initialAudit: surface() });
    expect(screen.getByText('no-god-object')).toBeTruthy();

    auditReply = () =>
      Promise.resolve(json(surface({ findings: [finding('no-magic-number')], nextOffset: null })));
    await click(/Show more|Load more/i);

    expect(screen.getByText('no-god-object')).toBeTruthy();
    expect(screen.getByText('no-magic-number')).toBeTruthy();
    const paged = calls.filter((c) => c.url.includes('findingsOffset=1'));
    expect(paged).toHaveLength(1);
    // The offset came back null, so the affordance is gone — never an endless page.
    expect(screen.queryByRole('button', { name: /Show more|Load more/i })).toBeNull();
  });

  it('a failed findings page surfaces its own message and leaves the loaded rows alone', async () => {
    render({ initialAudit: surface() });
    auditReply = () => Promise.resolve(notOk());
    await click(/Show more|Load more/i);

    expect(screen.getByText(/Couldn’t load more/)).toBeTruthy();
    expect(screen.getByText('no-god-object')).toBeTruthy();
  });

  it('the Convention tab renders one card per repo the reload derived', async () => {
    render({ loadError: 'MOTIR_AI_UNAVAILABLE: down' });
    await click('Retry');
    await click('Convention');

    expect(screen.getByText(REPOS[0]!)).toBeTruthy();
    expect(screen.getByText(REPOS[1]!)).toBeTruthy();
  });

  it('the deepen affordance dismisses to a re-open link and back, persisted per project', async () => {
    render({ initialAudit: surface() });
    const dismissKey = 'motir:code-health:deepen-dismissed:proj_1';
    const TITLE = 'Deepen this audit with an external scanner';

    await click('Dismiss');
    expect(localStorage.getItem(dismissKey)).toBe('1');
    // Dismissed: only the quiet one-line re-open button is left (Panel 6 State D).
    expect(screen.queryByRole('heading', { name: TITLE })).toBeNull();

    await click(TITLE);
    expect(localStorage.getItem(dismissKey)).toBeNull();
    expect(screen.getByRole('heading', { name: TITLE })).toBeTruthy();
  });

  // A project whose repos were DISCONNECTED after an audit was derived: the
  // report is still on screen (it is a stored row, not a live read) but there is
  // no `repoKey` left to scope a request by, and both boundary reads require one.
  // Every read path must therefore no-op rather than fire an unscoped 400.
  describe('a stored report with no connected repo left', () => {
    it('does not page the findings list', async () => {
      render({ repoRefs: [], initialAudit: surface() });
      await click('Load more findings');

      expect(calls).toHaveLength(0);
      expect(screen.getByText('no-god-object')).toBeTruthy();
    });

    it('fires the re-audit but polls nothing, since there is no surface to poll', async () => {
      vi.useFakeTimers();
      render({ repoRefs: [], initialAudit: surface() });

      await click('Set up CodeQL');
      await click('Re-audit now');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000 * 3);
      });

      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
      expect(calls.filter((c) => c.url.includes('/audit'))).toHaveLength(0);
    });
  });

  it('a re-audit whose POST fails shows the re-audit error and stores no run', async () => {
    refreshOk = false;
    render();

    await click('Run the first audit');

    expect(screen.getByText('Couldn’t start the re-audit.')).toBeTruthy();
    expect(localStorage.getItem('motir:code-health:reaudit-run:proj_1')).toBeNull();
    // Failing to START is the one case where the trigger must come back.
    expect(screen.getByRole('button', { name: 'Run the first audit' })).toBeTruthy();
  });

  it('a FIRST audit that outlasts the 60s window rests in State D, and “Check again” re-READS', async () => {
    vi.useFakeTimers();
    render();

    await click('Run the first audit');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * 21);
    });

    // Still running, never failed: a resting state, not the rose error strip.
    expect(screen.getByText('Still working on your first audit')).toBeTruthy();
    expect(screen.queryByText('Couldn’t start the re-audit.')).toBeNull();

    const before = calls.filter((c) => c.method === 'POST').length;
    auditReply = () => Promise.resolve(json(surface()));
    await click('Check again');

    // "Check again" must never re-queue the pair that is still in flight.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(before);
    expect(screen.getByText('B')).toBeTruthy();
  });

  it('a RE-audit that outlasts the window keeps the report and says so in the strip', async () => {
    vi.useFakeTimers();
    render({ initialAudit: surface() });

    // "Re-audit now" lives inside the expanded setup block, behind the best-fit
    // tool row — the same path a user walks after configuring a scanner.
    await click('Set up CodeQL');
    await click('Re-audit now');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * 21);
    });

    // The previous report is still on screen, so there is no empty state to rest
    // in — this is the one branch that keeps the strip.
    expect(screen.getByText('B')).toBeTruthy();
    expect(screen.queryByText('Still working on your first audit')).toBeNull();
    expect(screen.getByText(/Re-audit started/)).toBeTruthy();
  });
});
