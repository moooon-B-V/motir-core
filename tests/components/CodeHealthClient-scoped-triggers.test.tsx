// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { CodeHealthClient } from '@/app/(authed)/code-health/_components/CodeHealthClient';
import type { CodeAuditSurfaceDTO, RepoAuditSurfaceDTO } from '@/lib/dto/codeHealth';

// The PER-REPO and BULK audit triggers (MOTIR-2249 · design Panel 8), over the
// repo-scoped trigger MOTIR-2247 ships.
//
// The scope is asserted on the REQUEST BODY, not on the rendered rows: the whole
// point of the card is which repos a press pays to derive, and that is a fact
// about the wire.

const NOW = new Date('2026-08-05T00:05:00.000Z');
const REPOS = ['moooon/motir-ai', 'moooon/motir-core', 'moooon/motir-meta'];

function auditFor(repoKey: string, pct = 78): CodeAuditSurfaceDTO {
  return {
    audit: {
      id: `audit_${repoKey}`,
      healthSummary: { grade: 'B', conformancePct: pct },
      codeGraphRef: null,
      repoKey,
      createdAt: '2026-08-05T00:00:00.000Z',
    },
    findings: [],
    total: 3,
    nextOffset: null,
    scanner: null,
  };
}

const EMPTY: CodeAuditSurfaceDTO = {
  audit: null,
  findings: [],
  total: 0,
  nextOffset: null,
  scanner: null,
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}
let calls: Call[] = [];
let auditFixtures: Record<string, CodeAuditSurfaceDTO> = {};
let failingRepos = new Set<string>();

function json(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  // FAKE timers, never advanced. `observeRun`'s poll awaits `delay(3000)` after
  // the POST resolves; with real timers that delay fires AFTER the test (and
  // after `afterEach` unstubs `fetch`), so an unmounted island reaches the real
  // network and prints ECONNREFUSED. Nothing here needs the poll to tick — every
  // assertion is about the press and the request it makes.
  vi.useFakeTimers({ shouldAdvanceTime: false });
  calls = [];
  failingRepos = new Set();
  // motir-ai + motir-core audited; motir-meta has NO report.
  auditFixtures = {
    'moooon/motir-ai': auditFor('moooon/motir-ai', 63),
    'moooon/motir-core': auditFor('moooon/motir-core', 78),
    'moooon/motir-meta': EMPTY,
  };
  vi.stubGlobal('fetch', (input: string, init?: { method?: string; body?: string }) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    });
    if (url.includes('/convention')) {
      return Promise.resolve(
        json({ repoKey: '', convention: null, versions: [], nextCursor: null }),
      );
    }
    if (url.includes('/refresh')) {
      // The route answers with exactly the repos it queued — so a scoped press
      // gets a scoped result, which is what the in-flight record then stores.
      const scoped = (init?.body === undefined ? null : JSON.parse(init.body)) as {
        repoKeys?: string[];
      } | null;
      const queued = scoped?.repoKeys ?? REPOS;
      return Promise.resolve(
        json({
          repos: queued.map((r) => ({
            repoKey: r,
            auditJobId: `job_${r}`,
            conventionJobId: `cj_${r}`,
          })),
        }),
      );
    }
    if (url.includes('/audit')) {
      const repoKey = new URL(url, 'http://t').searchParams.get('repoKey') ?? '';
      if (failingRepos.has(repoKey)) {
        return Promise.resolve({ ok: false, json: async () => ({}) } as unknown as Response);
      }
      return Promise.resolve(json(auditFixtures[repoKey] ?? EMPTY));
    }
    return Promise.resolve(json({}));
  });
});

afterEach(() => {
  cleanup();
  // Drop any timer the island still has pending BEFORE handing the clock back,
  // so an unmounted poll cannot resume on real timers.
  vi.clearAllTimers();
  localStorage.clear();
  vi.useRealTimers();
});

// The `fetch` stub is deliberately NOT torn down per test: `observeRun`'s poll
// can outlive the component that started it, and an orphaned tick reaching the
// real network prints ECONNREFUSED noise into an otherwise green run. Re-stubbed
// fresh each `beforeEach`; released once at the end.
afterAll(() => {
  vi.unstubAllGlobals();
});

function render(over: { repoRefs?: string[]; audits?: RepoAuditSurfaceDTO[] } = {}) {
  const repoRefs = over.repoRefs ?? REPOS;
  const audits =
    over.audits ??
    repoRefs.map((repoKey) => ({ repoKey, surface: auditFixtures[repoKey] ?? EMPTY }));
  const selected = repoRefs[0] ?? null;
  return renderWithIntl(
    <CodeHealthClient
      projectId="proj_1"
      repoRefs={repoRefs}
      initialAudits={audits}
      initialSelectedRepoKey={selected}
      initialSelectedAudit={audits.find((a) => a.repoKey === selected)?.surface ?? null}
      initialConventions={[]}
      loadError={false}
    />,
    { now: NOW },
  );
}

const repoGroup = () => screen.getByRole('group', { name: 'Choose a repository’s audit report' });
const refreshPosts = () =>
  calls.filter((c) => c.method === 'POST' && c.url.includes('/coding-convention/refresh'));

describe('the per-repo audit trigger', () => {
  it('posts a scope naming exactly that repo, and puts only it into deriving', async () => {
    render();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit moooon/motir-meta' }));
    });

    expect(refreshPosts()).toHaveLength(1);
    expect(refreshPosts()[0]!.body).toEqual({ repoKeys: ['moooon/motir-meta'] });
    // The other two keep their grades — no sibling was dragged into the run.
    expect(within(repoGroup()).getByText('Deriving…')).toBeTruthy();
    expect(within(repoGroup()).getAllByText(/% conform/)).toHaveLength(2);
  });

  it('offers RE-AUDIT on a repo that already has a report, scoped to it alone', async () => {
    render();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Re-audit moooon/motir-core' }));
    });

    expect(refreshPosts()[0]!.body).toEqual({ repoKeys: ['moooon/motir-core'] });
  });

  it('issues exactly ONE post per press, even while the run is in flight', async () => {
    render();
    const trigger = screen.getByRole('button', { name: 'Audit moooon/motir-meta' });

    await act(async () => {
      fireEvent.click(trigger);
      fireEvent.click(trigger);
      fireEvent.click(trigger);
    });

    expect(refreshPosts()).toHaveLength(1);
  });
});

describe('the bulk trigger', () => {
  it('posts exactly the repos with NO report, and none that have one', async () => {
    render();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit the 1 with no report' }));
    });

    expect(refreshPosts()).toHaveLength(1);
    expect(refreshPosts()[0]!.body).toEqual({ repoKeys: ['moooon/motir-meta'] });
  });

  it('does not render when every connected repo has a report', () => {
    auditFixtures = Object.fromEntries(REPOS.map((r) => [r, auditFor(r)]));
    render();

    expect(screen.queryByRole('button', { name: /Audit the \d+ with no report/ })).toBeNull();
  });

  it('EXCLUDES an unreadable repo from its scope — its read failed, not its audit', async () => {
    // motir-core could not be loaded; motir-meta genuinely has no report.
    render({
      audits: [
        { repoKey: 'moooon/motir-ai', surface: auditFor('moooon/motir-ai', 63) },
        { repoKey: 'moooon/motir-core', surface: null },
        { repoKey: 'moooon/motir-meta', surface: EMPTY },
      ],
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit the 1 with no report' }));
    });

    expect(refreshPosts()[0]!.body).toEqual({ repoKeys: ['moooon/motir-meta'] });
  });
});

describe('the two states that get NO derive trigger', () => {
  it('an UNAVAILABLE row offers its free re-READ and no audit trigger', async () => {
    render({
      audits: [
        { repoKey: 'moooon/motir-ai', surface: auditFor('moooon/motir-ai', 63) },
        { repoKey: 'moooon/motir-core', surface: null },
        { repoKey: 'moooon/motir-meta', surface: EMPTY },
      ],
    });

    // The recovery is there…
    expect(within(repoGroup()).getByRole('button', { name: 'Try again' })).toBeTruthy();
    // …and no derive trigger for that repo, so the free and the paid action can
    // never sit in the same row (Panel 8 §2).
    expect(screen.queryByRole('button', { name: 'Audit moooon/motir-core' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-audit moooon/motir-core' })).toBeNull();

    // And "Try again" is still a re-READ, distinguishable from a derivation.
    await act(async () => {
      fireEvent.click(within(repoGroup()).getByRole('button', { name: 'Try again' }));
    });
    expect(refreshPosts()).toHaveLength(0);
    expect(
      calls.some((c) => c.method === 'GET' && c.url.includes('repoKey=moooon%2Fmotir-core')),
    ).toBe(true);
  });

  it('a DERIVING row renders no trigger at all — removed, not disabled', async () => {
    render();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit moooon/motir-meta' }));
    });

    expect(screen.queryByRole('button', { name: 'Audit moooon/motir-meta' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Re-audit moooon/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Audit the \d+ with no report/ })).toBeNull();
  });
});

describe('the in-flight record', () => {
  const RUN_KEY = 'motir:code-health:reaudit-run:proj_1';

  it('round-trips a scoped run across a remount, and offers no second trigger for it', async () => {
    const first = render();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Audit moooon/motir-meta' }));
    });
    expect(JSON.parse(localStorage.getItem(RUN_KEY) ?? 'null').repos).toEqual([
      {
        repoKey: 'moooon/motir-meta',
        auditJobId: 'job_moooon/motir-meta',
        conventionJobId: 'cj_moooon/motir-meta',
      },
    ]);

    first.unmount();
    calls = [];
    render();

    // The record is resumed, so the repo it queued gets no trigger back.
    expect(screen.queryByRole('button', { name: 'Audit moooon/motir-meta' })).toBeNull();
    expect(refreshPosts()).toHaveLength(0);
  });

  it('a SCOPED run never narrows a broader run’s record — the others stay watched', async () => {
    const { mergeReauditRun } = await import('@/lib/codeHealth/reauditRun');
    // A whole-set run is already stored, still deriving every repo.
    const stored = {
      repos: REPOS.map((r) => ({ repoKey: r, auditJobId: `old_${r}`, conventionJobId: `oc_${r}` })),
    };

    // …then a one-repo run is fired (a second tab, or a resumed mount).
    const merged = mergeReauditRun(stored, [
      { repoKey: 'moooon/motir-meta', auditJobId: 'new_meta', conventionJobId: 'nc_meta' },
    ]);

    // Every previously-queued repo survives — none is left deriving unwatched.
    expect(merged.repos.map((r) => r.repoKey).sort()).toEqual([...REPOS].sort());
    // …and the re-fired repo carries the NEWEST job id, not the stale one.
    expect(merged.repos.find((r) => r.repoKey === 'moooon/motir-meta')!.auditJobId).toBe(
      'new_meta',
    );
    expect(merged.repos.find((r) => r.repoKey === 'moooon/motir-ai')!.auditJobId).toBe(
      'old_moooon/motir-ai',
    );
  });

  it('merges onto an EMPTY record without inventing entries', async () => {
    const { mergeReauditRun } = await import('@/lib/codeHealth/reauditRun');
    const queued = [{ repoKey: 'moooon/motir-meta', auditJobId: 'j', conventionJobId: 'c' }];
    expect(mergeReauditRun(null, queued).repos).toEqual(queued);
  });
});

describe('a11y', () => {
  it('has no axe violations with the new controls present, and every trigger names its repo', async () => {
    // axe-core schedules its own work on timers, so this one test needs real
    // ones. Safe here: it fires no re-audit, so it leaves no poll behind.
    vi.useRealTimers();
    const { container } = render();

    // "Audit this repo" alone is meaningless read out of the row.
    expect(screen.getByRole('button', { name: 'Audit moooon/motir-meta' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-audit moooon/motir-core' })).toBeTruthy();
    // The row's select button still carries the repo AND its state.
    expect(
      within(repoGroup()).getByRole('button', {
        name: /^Show the audit for moooon\/motir-meta · /,
      }),
    ).toBeTruthy();

    const axe = (await import('axe-core')).default;
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});

describe('N = 1', () => {
  it('renders no list and therefore neither trigger — the page is unchanged', () => {
    render({ repoRefs: ['moooon/motir-core'] });

    expect(screen.queryByRole('group', { name: 'Choose a repository’s audit report' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Audit moooon/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Audit the \d+ with no report/ })).toBeNull();
  });
});
