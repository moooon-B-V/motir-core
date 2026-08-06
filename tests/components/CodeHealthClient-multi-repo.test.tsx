// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { CodeHealthClient } from '@/app/(authed)/code-health/_components/CodeHealthClient';
import type { CodeAuditSurfaceDTO, RepoAuditSurfaceDTO } from '@/lib/dto/codeHealth';

// The audit tab, for a MULTI-REPO project (MOTIR-2207 · Panel 7). The island's
// half of retiring `repos[0]`: which repo's report is on screen, which repo the
// poll watches, and what renders when only SOME repos have landed.
//
// Everything is asserted on the URLs actually fetched rather than by reading the
// component — the card's own criterion ("asserted by a test on the fetched URLs,
// not by inspection").

const NOW = new Date('2026-08-05T00:05:00.000Z');
const REPOS = ['moooon/motir-ai', 'moooon/motir-core', 'moooon/motir-gateway'];
const CONFORMANCE: Record<string, number> = {
  'moooon/motir-ai': 63,
  'moooon/motir-core': 78,
  'moooon/motir-gateway': 34,
};

function auditFor(repoKey: string, over: Partial<CodeAuditSurfaceDTO> = {}): CodeAuditSurfaceDTO {
  return {
    audit: {
      id: `audit_${repoKey}`,
      healthSummary: { grade: 'B', conformancePct: CONFORMANCE[repoKey] ?? 50 },
      codeGraphRef: null,
      repoKey,
      createdAt: '2026-08-05T00:00:00.000Z',
    },
    findings: [
      {
        ruleId: `rule-${repoKey}`,
        category: 'c',
        severity: 'low',
        fileRef: null,
        symbolRef: null,
        why: null,
        conventionRuleRef: null,
      },
    ],
    total: 1,
    nextOffset: null,
    scanner: null,
    ...over,
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
}
let calls: Call[] = [];
/** Whatever `/audit?repoKey=…` answers, keyed by repo. */
let auditFixtures: Record<string, CodeAuditSurfaceDTO> = {};
/** Repos whose audit read should REJECT (a 502 from the boundary). */
let failingRepos = new Set<string>();

function json(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  failingRepos = new Set();
  auditFixtures = Object.fromEntries(REPOS.map((r) => [r, auditFor(r)]));
  vi.stubGlobal('fetch', (input: string, init?: { method?: string }) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    if (url.includes('/convention')) {
      return Promise.resolve(
        json({ repoKey: '', convention: null, versions: [], nextCursor: null }),
      );
    }
    if (url.includes('/refresh')) {
      return Promise.resolve(
        json({
          repos: REPOS.map((r) => ({
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
  // A re-audit PERSISTS its run (MOTIR-2223), and a stored run legitimately
  // removes the trigger on the next mount — so leaving one behind makes the
  // following test render a page mid-run. Same cleanup the sibling suites do.
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(
  over: {
    repoRefs?: string[];
    audits?: RepoAuditSurfaceDTO[];
    selected?: string | null;
    selectedAudit?: CodeAuditSurfaceDTO | null;
  } = {},
) {
  const repoRefs = over.repoRefs ?? REPOS;
  // Seed from the SAME fixtures the fetch fake answers with, so a test that
  // tunes a repo's surface (a pagination cursor, a scanner state) gets that
  // surface on the initial render too, not a default built beside it.
  const audits =
    over.audits ??
    repoRefs.map((repoKey) => ({ repoKey, surface: auditFixtures[repoKey] ?? auditFor(repoKey) }));
  const selected = over.selected !== undefined ? over.selected : 'moooon/motir-gateway';
  return renderWithIntl(
    <CodeHealthClient
      projectId="proj_1"
      repoRefs={repoRefs}
      initialAudits={audits}
      initialSelectedRepoKey={selected}
      initialSelectedAudit={
        over.selectedAudit !== undefined
          ? over.selectedAudit
          : selected === null
            ? null
            : (audits.find((a) => a.repoKey === selected)?.surface ?? null)
      }
      initialConventions={[]}
      loadError={false}
    />,
    { now: NOW },
  );
}

const auditCalls = () => calls.filter((c) => c.url.includes('/coding-convention/audit'));
const repoKeysFetched = () =>
  auditCalls().map((c) => new URL(c.url, 'http://t').searchParams.get('repoKey'));
const postCalls = () => calls.filter((c) => c.method === 'POST');

/** The §10.3 state that makes the "Deepen this audit" card — and with it the
 *  "Re-audit now" trigger — render over an existing report (MOTIR-1592). */
const NO_SCANNER = {
  detected: [],
  ingested: null,
  noExternalScanner: true,
  suggestion: 'github_code_scanning' as const,
};

/** "Re-audit now" lives inside the expanded setup block, behind the best-fit
 *  tool row — the same path a user walks after configuring a scanner. */
async function clickReaudit() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Set up CodeQL' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Re-audit now' }));
  });
}
const repoGroup = () => screen.getByRole('group', { name: 'Choose a repository’s audit report' });
const rowFor = (repoKey: string) =>
  within(repoGroup()).getByRole('button', { name: new RegExp(`^Show the audit for ${repoKey} ·`) });

describe('the audit tab presents EVERY repo, one report at a time', () => {
  it('opens on the worst repo’s report with a row for each connected repo', () => {
    render();

    // ONE SELECT button per connected repo. Counted by accessible name rather
    // than by every button in the group: since MOTIR-2249 a row also carries a
    // derive trigger, so a bare button count no longer means "one row each".
    expect(
      within(repoGroup()).getAllByRole('button', { name: /^Show the audit for / }),
    ).toHaveLength(3);
    // The report is the SELECTED repo's — the worst-conforming one, not the
    // alphabetically-first one `repos[0]` used to pick.
    expect(screen.getByText('rule-moooon/motir-gateway')).toBeTruthy();
    expect(rowFor('moooon/motir-gateway').getAttribute('aria-current')).toBe('true');
  });

  it('clicking a row swaps the report, scoped to THAT repo', async () => {
    render();

    await act(async () => {
      fireEvent.click(rowFor('moooon/motir-core'));
    });

    expect(screen.getByText('rule-moooon/motir-core')).toBeTruthy();
    expect(screen.queryByText('rule-moooon/motir-gateway')).toBeNull();
    expect(repoKeysFetched()).toEqual(['moooon/motir-core']);
  });

  it('RESETS the findings list on a switch rather than appending to it', async () => {
    // `nextOffset` is an offset into ONE audit, so carrying a page across repos
    // would page repo B's list with repo A's cursor (Panel 7 §3).
    auditFixtures['moooon/motir-gateway'] = auditFor('moooon/motir-gateway', {
      total: 150,
      nextOffset: 100,
    });
    auditFixtures['moooon/motir-core'] = auditFor('moooon/motir-core', {
      total: 1,
      nextOffset: null,
    });
    render();

    expect(screen.getByRole('button', { name: 'Load more findings' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(rowFor('moooon/motir-core'));
    });

    // The new repo's page-one only: no "Load more" carried over from a list that
    // belonged to a different audit.
    expect(screen.queryByRole('button', { name: 'Load more findings' })).toBeNull();
    expect(screen.getByText('rule-moooon/motir-core')).toBeTruthy();
  });

  it('pages findings against the SELECTED repo, at its own offset', async () => {
    auditFixtures['moooon/motir-core'] = auditFor('moooon/motir-core', {
      total: 150,
      nextOffset: 100,
    });
    render();

    await act(async () => {
      fireEvent.click(rowFor('moooon/motir-core'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Load more findings' }));
    });

    const paged = auditCalls().filter((c) => c.url.includes('findingsOffset'));
    expect(paged).toHaveLength(1);
    const url = new URL(paged[0]!.url, 'http://t');
    expect(url.searchParams.get('repoKey')).toBe('moooon/motir-core');
    expect(url.searchParams.get('findingsOffset')).toBe('100');
  });
});

describe('the re-audit poll watches the repo whose report is on screen', () => {
  it('polls the SELECTED repo, not repos[0] — and POSTs exactly once', async () => {
    vi.useFakeTimers();
    auditFixtures['moooon/motir-core'] = auditFor('moooon/motir-core', { scanner: NO_SCANNER });
    // A different repo from the alphabetical first, so the two are separable.
    render({ selected: 'moooon/motir-core' });

    await clickReaudit();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000 * 3);
    });

    // The ONE-POST invariant (MOTIR-2123), re-asserted because this card touches
    // the poll: a tick must never re-POST the fan-out.
    expect(postCalls()).toHaveLength(1);
    const polled = auditCalls().filter((c) => c.url.includes('repoKey'));
    expect(polled.length).toBeGreaterThan(0);
    // Every poll tick reads the repo the reader is looking at. Watching a fixed
    // `repos[0]` would sit waiting on a report the user cannot see — and would
    // call the run finished the moment an unrelated repo landed.
    for (const call of polled) {
      expect(new URL(call.url, 'http://t').searchParams.get('repoKey')).toBe('moooon/motir-core');
    }
  });

  it('marks every queued repo as deriving in the LIST while the run is in flight', async () => {
    vi.useFakeTimers();
    auditFixtures['moooon/motir-core'] = auditFor('moooon/motir-core', { scanner: NO_SCANNER });
    render({ selected: 'moooon/motir-core' });

    await clickReaudit();

    // The fan-out told the island exactly which repos it queued, so the list
    // says which ones it is waiting on rather than going vague (Panel 7 §5).
    expect(screen.getAllByText('Deriving…')).toHaveLength(3);
    expect(screen.getByText('0 of 3 audited')).toBeTruthy();
    expect(screen.getByText('3 deriving')).toBeTruthy();
  });
});

describe('the partially-derived state (Panel 7 §5)', () => {
  it('E2 · names the ONE repo still deriving and leaves the siblings readable', () => {
    render({
      audits: [
        { repoKey: 'moooon/motir-ai', surface: auditFor('moooon/motir-ai') },
        { repoKey: 'moooon/motir-core', surface: auditFor('moooon/motir-core') },
        { repoKey: 'moooon/motir-gateway', surface: EMPTY },
      ],
      selected: 'moooon/motir-gateway',
      selectedAudit: null,
    });

    // Singular headline naming the repository — NOT State C, which says "these
    // repos" over the whole set because the whole project is waiting.
    expect(screen.getByText('Deriving the audit for moooon/motir-gateway…')).toBeTruthy();
    expect(screen.queryByText('Deriving your first audit…')).toBeNull();
    // …and NOT State D, the 60-second cut-off with nothing at all on screen.
    expect(screen.queryByText('Still working on your first audit')).toBeNull();
    // The other repositories are readable — the list still carries their grades.
    expect(screen.getByText('2 of 3 audited')).toBeTruthy();
  });

  it('E1 · a landed selection renders its report while siblings still derive', () => {
    render({
      audits: [
        { repoKey: 'moooon/motir-ai', surface: EMPTY },
        { repoKey: 'moooon/motir-core', surface: auditFor('moooon/motir-core') },
        { repoKey: 'moooon/motir-gateway', surface: EMPTY },
      ],
      selected: 'moooon/motir-core',
    });

    // A partially-derived project is not an empty screen.
    expect(screen.getByText('rule-moooon/motir-core')).toBeTruthy();
    expect(screen.getByText('1 of 3 audited')).toBeTruthy();
  });

  it('states A–D fire UNCHANGED when NO repo has an audit', () => {
    render({
      audits: REPOS.map((repoKey) => ({ repoKey, surface: EMPTY })),
      selected: 'moooon/motir-ai',
      selectedAudit: null,
    });

    // This panel takes nothing away from MOTIR-2080 / MOTIR-2081: with nothing
    // derived anywhere, the project IS waiting, and State B is the truth.
    expect(screen.getByRole('button', { name: 'Run the first audit' })).toBeTruthy();
    expect(screen.queryByText(/^Deriving the audit for/)).toBeNull();
  });
});

describe('one repo’s read failing degrades that repo only', () => {
  it('renders the siblings’ reports and never the whole-page error strip', () => {
    render({
      audits: [
        { repoKey: 'moooon/motir-ai', surface: null },
        { repoKey: 'moooon/motir-core', surface: auditFor('moooon/motir-core') },
        { repoKey: 'moooon/motir-gateway', surface: auditFor('moooon/motir-gateway') },
      ],
    });

    expect(screen.getByText('Couldn’t load this report')).toBeTruthy();
    // The selected repo's report still renders, and the rose strip — the
    // whole-page failure — is absent.
    expect(screen.getByText('rule-moooon/motir-gateway')).toBeTruthy();
    expect(screen.queryByText(/Couldn’t load code health/)).toBeNull();
  });

  it('“Try again” re-reads that repo alone and recovers its row', async () => {
    render({
      audits: [
        { repoKey: 'moooon/motir-ai', surface: null },
        { repoKey: 'moooon/motir-core', surface: auditFor('moooon/motir-core') },
        { repoKey: 'moooon/motir-gateway', surface: auditFor('moooon/motir-gateway') },
      ],
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });

    // ONE scoped read — the recovery never re-reads the repos that were fine,
    // and never re-audits (a read that failed says nothing about the code).
    expect(repoKeysFetched()).toEqual(['moooon/motir-ai']);
    expect(postCalls()).toHaveLength(0);
    expect(screen.queryByText('Couldn’t load this report')).toBeNull();
    expect(screen.getByText('3 of 3 audited')).toBeTruthy();
  });

  it('a SELECTED repo whose read failed says so in the report area, with a retry', async () => {
    render({
      audits: [
        { repoKey: 'moooon/motir-ai', surface: auditFor('moooon/motir-ai') },
        { repoKey: 'moooon/motir-core', surface: auditFor('moooon/motir-core') },
        { repoKey: 'moooon/motir-gateway', surface: null },
      ],
      selected: 'moooon/motir-gateway',
      selectedAudit: null,
    });

    // Distinct from E2 in the way that matters: nothing is coming unless the
    // reader retries, so it must not claim to be deriving.
    expect(screen.getByText('Couldn’t load the report for moooon/motir-gateway')).toBeTruthy();
    expect(screen.queryByText(/^Deriving the audit for/)).toBeNull();
  });
});

describe('a single-repo project is unchanged', () => {
  it('draws no list and renders the one report exactly as today', () => {
    render({
      repoRefs: ['acme/web'],
      audits: [{ repoKey: 'acme/web', surface: auditFor('acme/web') }],
      selected: 'acme/web',
    });

    // The regression pin: the list's only jobs are selection and comparison,
    // both vacuous at N = 1 (Panel 7 §7).
    expect(screen.queryByRole('group', { name: 'Choose a repository’s audit report' })).toBeNull();
    expect(screen.getByText('rule-acme/web')).toBeTruthy();
  });
});
