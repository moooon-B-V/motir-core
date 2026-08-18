// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PlanRow } from '@/app/(authed)/plans/_components/PlanRow';
import type { PlanRowView } from '@/app/(authed)/plans/_components/types';

// Component test for the Plans-list row (Subtask 7.21.1 / MOTIR-1338). Asserts
// the row binds the server-built view-model to the design (title, item count,
// when-label, the status pill, and the conditional stale flag) and links the
// whole row to the plan detail. happy-dom + the real `en` catalog (renderWithIntl)
// — no jest-dom (the component-test convention).

afterEach(() => cleanup());

function view(overrides: Partial<PlanRowView> = {}): PlanRowView {
  return {
    id: 'plan_1',
    status: 'planned',
    title: 'Stripe Connect payouts',
    itemCount: 14,
    staleCount: 0,
    whenKey: 'plannedAt',
    whenLabel: '2 hours ago',
    // The three-party attribution (MOTIR-2991). The default is the UNATTRIBUTED
    // state — no requester, no author, no job — so every pre-existing case below
    // keeps asserting the row without one, and each attribution state opts in.
    origin: 'user',
    sourceJobId: null,
    createdByName: null,
    authorSource: null,
    authorHarness: null,
    ...overrides,
  };
}

describe('PlanRow', () => {
  it('renders the title, item count + when-label, and links the row to the plan detail', () => {
    renderWithIntl(<PlanRow view={view()} />);
    expect(screen.getByText('Stripe Connect payouts')).toBeTruthy();
    expect(screen.getByText('14 items')).toBeTruthy();
    expect(screen.getByText('planned 2 hours ago')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Stripe Connect payouts/ });
    expect(link.getAttribute('href')).toBe('/plans/plan_1');
  });

  it('labels the when-line with the verb matching the lifecycle timestamp', () => {
    renderWithIntl(
      <PlanRow
        view={view({ status: 'approved', whenKey: 'approvedAt', whenLabel: 'yesterday' })}
      />,
    );
    expect(screen.getByText('approved yesterday')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
  });

  it('renders the declined status pill', () => {
    renderWithIntl(
      <PlanRow
        view={view({ status: 'declined', whenKey: 'declinedAt', whenLabel: '3 days ago' })}
      />,
    );
    expect(screen.getByText('Declined')).toBeTruthy();
    expect(screen.getByText('declined 3 days ago')).toBeTruthy();
  });

  it('shows the stale flag when staleCount > 0', () => {
    renderWithIntl(<PlanRow view={view({ staleCount: 3 })} />);
    expect(screen.getByText('3 may be out of date')).toBeTruthy();
  });

  it('omits the stale flag when nothing has drifted', () => {
    renderWithIntl(<PlanRow view={view({ staleCount: 0 })} />);
    expect(screen.queryByText(/may be out of date/)).toBeNull();
  });

  it('falls back to a placeholder title for an unnamed generating plan', () => {
    renderWithIntl(
      <PlanRow view={view({ title: '', status: 'generating', whenKey: 'createdAt' })} />,
    );
    expect(screen.getByText('Untitled plan')).toBeTruthy();
    expect(screen.getByText('Generating')).toBeTruthy();
  });

  it('uses the singular item label for a one-item plan', () => {
    renderWithIntl(<PlanRow view={view({ itemCount: 1 })} />);
    expect(screen.getByText('1 item')).toBeTruthy();
  });
});

// ── The three-party attribution (Story MOTIR-2982 · MOTIR-2991) ─────────────
// `design/ai-planning/design-notes.md` Part III is the spec; panel A2 draws the
// seven rows. These assert the STATE MACHINE behind them — which of the two
// halves renders, and the one rule that is easy to get wrong (a decided row
// shows the decider, not the requester).
describe('PlanRow — who asked and who wrote', () => {
  it('names the person and the AGENT on an undecided plan', () => {
    renderWithIntl(
      <PlanRow
        view={view({ createdByName: 'Mara', authorSource: 'mcp', authorHarness: 'Claude Code' })}
      />,
    );
    expect(screen.getByText('Mara')).toBeTruthy();
    expect(screen.getByText('via Claude Code')).toBeTruthy();
  });

  it('names the person and MOTIR when a generation job produced it', () => {
    // Read off `sourceJobId`, NOT `authorSource === 'native'` — the generator
    // records no author (MOTIR-2996), so a row keyed on 'native' would never
    // render for any plan the product actually creates.
    renderWithIntl(<PlanRow view={view({ createdByName: 'Jonas', sourceJobId: 'job_1' })} />);
    expect(screen.getByText('Jonas')).toBeTruthy();
    expect(screen.getByText('via Motir AI')).toBeTruthy();
  });

  it('says AUTO-PLANNED instead of a requester when nobody asked', () => {
    renderWithIntl(
      <PlanRow view={view({ origin: 'cadence', createdByName: null, sourceJobId: 'job_2' })} />,
    );
    expect(screen.getByText('auto-planned')).toBeTruthy();
    expect(screen.getByText('via Motir AI')).toBeTruthy();
  });

  it('renders NOTHING when neither party is known — no placeholder, no gap', () => {
    // The unattributed state. Every plan predating the columns is in it, and a
    // placeholder in a scanned list is a value the reader must learn to ignore.
    const { container } = renderWithIntl(<PlanRow view={view()} />);
    expect(screen.queryByText(/via /)).toBeNull();
    expect(screen.queryByText('auto-planned')).toBeNull();
    // …and specifically no orphan separator left behind by the absent halves.
    expect(container.textContent).not.toContain('·');
  });

  it('renders the requester alone when no agent is known', () => {
    renderWithIntl(<PlanRow view={view({ createdByName: 'Priya' })} />);
    expect(screen.getByText('Priya')).toBeTruthy();
    expect(screen.queryByText(/via /)).toBeNull();
  });

  it('DROPS the requester once the plan is decided, and keeps the agent', () => {
    // The rule from Part III §3: the row already ends "approved yesterday", and
    // while a plan is undecided *who asked* is what you weigh — once decided,
    // *who decided* is the operative fact. Dropping the requester is also what
    // stops two bare person names landing in one scanned line.
    for (const status of ['approved', 'declined'] as const) {
      cleanup();
      renderWithIntl(
        <PlanRow
          view={view({
            status,
            whenKey: status === 'approved' ? 'approvedAt' : 'declinedAt',
            createdByName: 'Mara',
            sourceJobId: 'job_3',
          })}
        />,
      );
      expect(screen.queryByText('Mara')).toBeNull();
      expect(screen.getByText('via Motir AI')).toBeTruthy();
    }
  });

  it('truncates a long harness without touching the title', () => {
    const harness = 'acme-internal-planning-harness v4 (nightly build)';
    renderWithIntl(
      <PlanRow
        view={view({ createdByName: 'Mara', authorSource: 'mcp', authorHarness: harness })}
      />,
    );
    const agent = screen.getByText(`via ${harness}`);
    expect(agent.className).toContain('truncate');
    expect(agent.className).toContain('max-w-[12rem]');
    // The title keeps its OWN ellipsis and is never shortened by this line.
    expect(screen.getByText('Stripe Connect payouts').className).toContain('truncate');
  });

  it('carries the attribution in TEXT, never by icon or colour alone', () => {
    const { container } = renderWithIntl(
      <PlanRow
        view={view({ createdByName: 'Mara', authorSource: 'mcp', authorHarness: 'Codex' })}
      />,
    );
    // Every glyph in the attribution is decorative; the words say the whole thing.
    for (const svg of container.querySelectorAll('svg')) {
      if (svg.closest('a')?.textContent?.includes('Codex')) {
        expect(svg.getAttribute('aria-hidden')).toBe('true');
      }
    }
    expect(screen.getByText('via Codex')).toBeTruthy();
    expect(screen.getByText('Mara')).toBeTruthy();
  });
});
