// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { AuditRepoList } from '@/app/(authed)/code-health/_components/AuditRepoList';
import { buildRepoAuditRows } from '@/lib/codeHealth/repoAuditRows';
import type { RepoAuditSurfaceDTO } from '@/lib/dto/codeHealth';

// Panel 7's repo list (MOTIR-2207): the layer ABOVE the report that chooses
// whose report is on screen. Before this card there was no affordance anywhere
// on the page hinting that four of MOTIR's five repos had derived audits.

// A fixed instant, so `relativeTime` is deterministic AND next-intl never falls
// back to the environment clock (the ENVIRONMENT_FALLBACK → hydration-mismatch
// class the app's `i18n/request.ts` `now` kills in production).
const NOW = new Date('2026-08-05T00:05:00.000Z');
const AUDITED_AT = '2026-08-05T00:00:00.000Z';

function audited(repoKey: string, pct: number, total: number): RepoAuditSurfaceDTO {
  return {
    repoKey,
    surface: {
      audit: {
        id: `audit_${repoKey}`,
        healthSummary: { grade: pct >= 70 ? 'B' : 'D', conformancePct: pct },
        codeGraphRef: null,
        repoKey,
        createdAt: AUDITED_AT,
      },
      findings: [],
      total,
      nextOffset: null,
      scanner: null,
    },
  };
}

const neverAudited = (repoKey: string): RepoAuditSurfaceDTO => ({
  repoKey,
  surface: { audit: null, findings: [], total: 0, nextOffset: null, scanner: null },
});

const unloadable = (repoKey: string): RepoAuditSurfaceDTO => ({ repoKey, surface: null });

/** An audit that landed but reported no grade — the `healthSummary` fields are
 *  all optional, so this is a shape the DTO permits and the row must survive. */
const ungraded = (repoKey: string, total: number): RepoAuditSurfaceDTO => ({
  repoKey,
  surface: {
    audit: {
      id: `audit_${repoKey}`,
      healthSummary: {},
      codeGraphRef: null,
      repoKey,
      createdAt: AUDITED_AT,
    },
    findings: [],
    total,
    nextOffset: null,
    scanner: null,
  },
});

function renderList(
  audits: RepoAuditSurfaceDTO[],
  over: {
    deriving?: string[];
    selected?: string | null;
    onSelect?: (repoKey: string) => void;
    onRetry?: (repoKey: string) => void;
    onAuditRepos?: (repoKeys: string[]) => void;
    busy?: boolean;
  } = {},
) {
  return renderWithIntl(
    <AuditRepoList
      rows={buildRepoAuditRows(audits, over.deriving ?? [])}
      selectedRepoKey={over.selected ?? audits[0]?.repoKey ?? null}
      onSelect={over.onSelect ?? vi.fn()}
      onRetry={over.onRetry ?? vi.fn()}
      {...(over.onAuditRepos ? { onAuditRepos: over.onAuditRepos } : {})}
      {...(over.busy === undefined ? {} : { busy: over.busy })}
    />,
    { now: NOW },
  );
}

const group = () => screen.getByRole('group', { name: 'Choose a repository’s audit report' });
const rowButtons = () => within(group()).getAllByRole('button');

afterEach(cleanup);

describe('AuditRepoList — N = 1 (Panel 7 §7)', () => {
  it('renders NOTHING for a single connected repo', () => {
    const { container } = renderList([audited('a/one', 78, 10)]);

    // Selection and comparison are both vacuous with one row, so the tab is
    // exactly what it renders today. This is the regression guard for
    // MOTIR-2207's "a single-repo project renders as it does now" criterion.
    expect(container.textContent).toBe('');
  });

  it('renders nothing for a project with no connected repo either', () => {
    const { container } = renderList([]);

    expect(container.textContent).toBe('');
  });
});

describe('AuditRepoList — the list, worst first', () => {
  const FIVE = [
    audited('moooon/motir-ai', 63, 143),
    audited('moooon/motir-core', 78, 212),
    audited('moooon/motir-gateway', 34, 96),
    audited('moooon/starter', 94, 11),
    neverAudited('moooon/motir-meta'),
  ];

  it('orders the rows worst-first and puts the un-audited repo last', () => {
    renderList(FIVE);

    const names = rowButtons().map((b) => b.getAttribute('aria-label'));
    expect(names.map((n) => n?.replace('Show the audit for ', '').split(' · ')[0])).toEqual([
      'moooon/motir-gateway',
      'moooon/motir-ai',
      'moooon/motir-core',
      'moooon/starter',
      'moooon/motir-meta',
    ]);
  });

  it('shows EVERY repo — the four that would have been invisible included', () => {
    renderList(FIVE);

    for (const repoKey of FIVE.map((a) => a.repoKey)) {
      expect(screen.getByText(repoKey)).toBeTruthy();
    }
  });

  it('carries a per-repo grade and finding count, never a project-level grade', () => {
    renderList(FIVE);

    expect(screen.getByText('D · 34% conform')).toBeTruthy();
    expect(screen.getByText('B · 78% conform')).toBeTruthy();
    expect(screen.getByText('212 findings')).toBeTruthy();
    // Counts that are TRUE BY ADDITION (§2) — 143+212+96+11 = 462.
    expect(screen.getByText('4 of 5 audited')).toBeTruthy();
    expect(screen.getByText('462 findings across them')).toBeTruthy();
    expect(screen.getByText('1 not audited yet')).toBeTruthy();
  });

  it('rolls up the deriving and unloadable repos honestly', () => {
    renderList([audited('a/one', 78, 212), neverAudited('a/two'), unloadable('a/three')], {
      deriving: ['a/two'],
    });

    expect(screen.getByText('1 of 3 audited')).toBeTruthy();
    expect(screen.getByText('1 deriving')).toBeTruthy();
    expect(screen.getByText('1 couldn’t be loaded')).toBeTruthy();
    // The deriving repo has landed nothing, so it adds nothing to the total.
    expect(screen.getByText('212 findings across them')).toBeTruthy();
  });
});

describe('AuditRepoList — the four row states carry a WORD, not just a colour', () => {
  it('names each state in text and in the row’s accessible name', () => {
    renderList(
      [
        audited('a/one', 78, 5),
        neverAudited('a/two'),
        neverAudited('a/three'),
        unloadable('a/four'),
      ],
      {
        deriving: ['a/two'],
      },
    );

    expect(screen.getByText('Deriving…')).toBeTruthy();
    expect(screen.getByText('Not audited yet')).toBeTruthy();
    expect(screen.getByText('Couldn’t load this report')).toBeTruthy();

    const names = rowButtons().map((b) => b.getAttribute('aria-label'));
    expect(names).toContain('Show the audit for a/two · Deriving…');
    expect(names).toContain('Show the audit for a/three · Not audited yet');
    expect(names).toContain('Show the audit for a/four · Couldn’t load this report');
    // The grade repeats the LETTER and the percentage as text, so the tone is
    // never the only thing carrying it (finding #35).
    expect(names).toContain('Show the audit for a/one · B · 78% conform');
  });
});

describe('AuditRepoList — selection + a11y', () => {
  const TWO = [audited('a/one', 34, 5), audited('a/two', 90, 7)];

  it('marks the selected row aria-current and calls back with the repo KEY', () => {
    const onSelect = vi.fn();
    renderList(TWO, { selected: 'a/one', onSelect });

    const [first, second] = rowButtons();
    expect(first!.getAttribute('aria-current')).toBe('true');
    expect(second!.getAttribute('aria-current')).toBeNull();

    fireEvent.click(second!);
    // Selection is held by repoRef, never by index — so a re-sort cannot move it.
    expect(onSelect).toHaveBeenCalledWith('a/two');
  });

  it('is a role=group of sibling BUTTONS — never a listbox with nested controls', () => {
    renderList([...TWO, unloadable('a/three')]);

    // `role="listbox"` + `role="option"` rows may not contain interactive
    // children: the shipped SavedFilterDropdown failed the 6.2.6 axe sweep on
    // exactly that (aria-required-children critical + nested-interactive).
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    const retry = screen.getByRole('button', { name: 'Try again' });
    // The recovery is a SIBLING of the row button, not nested inside it.
    expect(retry.closest('button[aria-current], button[aria-label]')).toBeNull();
  });

  it('the unavailable row’s recovery re-reads that repo alone', () => {
    const onRetry = vi.fn();
    const onSelect = vi.fn();
    renderList([...TWO, unloadable('a/three')], { onRetry, onSelect });

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(onRetry).toHaveBeenCalledWith('a/three');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('every row is reachable and activatable by keyboard', () => {
    const onSelect = vi.fn();
    renderList(TWO, { onSelect });

    const [, second] = rowButtons();
    second!.focus();
    expect(document.activeElement).toBe(second);
    // Native <button> semantics: Enter/Space activate without a key handler of
    // our own, which is the whole reason the row is a button and not a div.
    fireEvent.click(second!);
    expect(onSelect).toHaveBeenCalledWith('a/two');
  });
});

// The derive triggers (Panel 8 / MOTIR-2249). These were shipped untested: the
// component's coverage entry named the literal `app/(authed)/…` path, which the
// coverage matcher resolves to no file, so the ≥90% gate never saw this file
// and the whole `onAuditRepos` half read as covered while being unexercised
// (MOTIR-2449).
describe('AuditRepoList — the derive triggers (Panel 8)', () => {
  const MIXED = [
    audited('a/graded', 34, 5),
    neverAudited('a/fresh'),
    neverAudited('a/pending'),
    unloadable('a/broken'),
  ];

  it('the header action derives every repo with NO report, in one press', () => {
    const onAuditRepos = vi.fn();
    renderList(MIXED, { onAuditRepos });

    const header = screen.getByRole('button', { name: 'Audit the 2 with no report' });
    fireEvent.click(header);

    // `unavailable` is excluded on purpose (Panel 8 §2): its read failed, so
    // nothing here knows whether it needs deriving.
    expect(onAuditRepos).toHaveBeenCalledWith(['a/fresh', 'a/pending']);
  });

  it('removes the header action when every repo already has a report', () => {
    renderList([audited('a/one', 34, 5), audited('a/two', 90, 7)], { onAuditRepos: vi.fn() });

    // ABSENT at zero, never disabled (Panel 8 §3).
    expect(screen.queryByRole('button', { name: /Audit the/ })).toBeNull();
  });

  it('removes EVERY derive trigger while a run is in flight', () => {
    renderList(MIXED, { onAuditRepos: vi.fn(), busy: true });

    expect(screen.queryByRole('button', { name: /Audit the/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Audit a/fresh' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-audit a/graded' })).toBeNull();
    // The free re-READ is untouched by a run — it is not a derive trigger.
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('renders no derive trigger at all when the page passes no handler', () => {
    renderList(MIXED);

    expect(screen.queryByRole('button', { name: /Audit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Re-audit/ })).toBeNull();
  });

  it('derives ONE repo from its own row, named by that repo', () => {
    const onAuditRepos = vi.fn();
    renderList(MIXED, { onAuditRepos });

    fireEvent.click(screen.getByRole('button', { name: 'Audit a/fresh' }));
    expect(onAuditRepos).toHaveBeenCalledWith(['a/fresh']);

    // A repo that HAS a report offers the rarer re-derive instead.
    fireEvent.click(screen.getByRole('button', { name: 'Re-audit a/graded' }));
    expect(onAuditRepos).toHaveBeenLastCalledWith(['a/graded']);
    // Weight encodes price: the two repos with no report get the bordered
    // `secondary` label, the graded one the quieter re-derive.
    expect(screen.getAllByText('Audit this repo')).toHaveLength(2);
    expect(screen.getByText('Re-audit')).toBeTruthy();
  });

  it('offers no derive trigger on a deriving or unavailable row', () => {
    renderList([audited('a/one', 34, 5), neverAudited('a/two'), unloadable('a/broken')], {
      deriving: ['a/two'],
      onAuditRepos: vi.fn(),
    });

    // `deriving` — the work is already happening; `unavailable` — the read
    // failed, so deriving would spend money to fix what may be a display error.
    expect(screen.queryByRole('button', { name: /a\/two/ })?.getAttribute('aria-label')).toBe(
      'Show the audit for a/two · Deriving…',
    );
    expect(screen.queryByRole('button', { name: 'Audit a/two' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Audit a/broken' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-audit a/broken' })).toBeNull();
  });
});

describe('AuditRepoList — the states an audit’s own numbers can be missing', () => {
  it('falls back to the bare word when an audit reported no grade', () => {
    renderList([ungraded('a/one', 4), audited('a/two', 90, 7)]);

    // `healthSummary` is all-optional, so "audited, no number" is reachable —
    // the chip then carries the neutral tint and the word, never a grade of 0.
    const chip = screen.getByText('Audited');
    expect(chip.className).toContain('bg-(--el-muted)');
    const names = rowButtons().map((b) => b.getAttribute('aria-label'));
    expect(names).toContain('Show the audit for a/one · Audited');
  });

  it('times a deriving row from the audit it is replacing', () => {
    // A repo whose PREVIOUS audit is on screen while a fresh one derives keeps
    // its `createdAt`, so the row can say WHEN rather than "just started".
    renderList([audited('a/one', 34, 5), audited('a/two', 90, 7)], { deriving: ['a/two'] });

    expect(screen.getByText('started 5 minutes ago')).toBeTruthy();
  });
});
