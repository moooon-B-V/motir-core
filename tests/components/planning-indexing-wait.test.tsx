// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { PlanningIndexingWait } from '@/components/planning/PlanningIndexingWait';

// THE WINDOW SHOWS THE WAIT (Story MOTIR-4753 · MOTIR-4829).
//
// ⚠️ THE ASSERTION THIS SUITE EXISTS FOR IS THAT THERE ARE TWO ELEMENTS. Yue
// settled it twice in one turn — *"the planner SHOULD tell the user, the repo is
// being indexed"*, then *"with the banner and say it"* — and the failure mode of
// merging them is SILENT: a build that keeps only the banner looks finished, and
// a build that keeps only the turn puts a durable state into a transcript that
// scrolls away. So the two are asserted as two, by testid, in every phase.

afterEach(cleanup);

const props = {
  repositories: ['acme/widgets'],
  message: "You've connected acme/widgets but I haven't read it yet — I'm building its index now.",
  phase: 'running' as const,
};

describe('TWO ELEMENTS, and neither is the other’s caption', () => {
  it('renders the BANNER and the TURN as distinct nodes', () => {
    render(<PlanningIndexingWait {...props} />);
    const banner = screen.getByTestId('planning-indexing-banner');
    const turn = screen.getByTestId('planning-indexing-turn');
    expect(banner).toBeTruthy();
    expect(turn).toBeTruthy();
    // Neither contains the other — a build that nested them would satisfy two
    // `getByTestId` calls and still have collapsed the pair.
    expect(banner.contains(turn)).toBe(false);
    expect(turn.contains(banner)).toBe(false);
  });

  it('the BANNER carries the STATE and names the repository', () => {
    render(<PlanningIndexingWait {...props} />);
    const banner = screen.getByTestId('planning-indexing-banner');
    expect(banner.textContent).toContain('acme/widgets');
    expect(banner.textContent).toContain('In progress');
  });

  it('the TURN carries the planner’s message VERBATIM', () => {
    render(<PlanningIndexingWait {...props} />);
    // ⚠️ VERBATIM IS THE CONTRACT. This is the verdict's own `message` — the
    // planner speaking about a project it has just looked at — and the surface
    // may not rewrite, truncate or wrap it in copy of Motir's own.
    expect(screen.getByTestId('planning-indexing-turn').textContent).toContain(props.message);
  });

  it('and the message is NOT duplicated into the banner', () => {
    render(<PlanningIndexingWait {...props} />);
    expect(screen.getByTestId('planning-indexing-banner').textContent).not.toContain(props.message);
  });
});

describe('QUEUED and RUNNING differ in the tail and the sub-line, never the title', () => {
  it('the title is the same sentence in both', () => {
    render(<PlanningIndexingWait {...props} phase="queued" />);
    const queued = screen.getByTestId('planning-indexing-banner').textContent ?? '';
    cleanup();
    render(<PlanningIndexingWait {...props} phase="running" />);
    const running = screen.getByTestId('planning-indexing-banner').textContent ?? '';
    // The person is waiting for the same thing either way, and a title that
    // changes under them reads as a second event.
    expect(queued).toContain('Indexing acme/widgets');
    expect(running).toContain('Indexing acme/widgets');
  });

  it('the tail and the sub-line are what tell somebody who came back that it moved', () => {
    render(<PlanningIndexingWait {...props} phase="queued" />);
    const banner = screen.getByTestId('planning-indexing-banner');
    expect(banner.getAttribute('data-phase')).toBe('queued');
    expect(banner.textContent).toContain('Queued');
    expect(banner.textContent).toContain('Just started');
    expect(banner.textContent).not.toContain('In progress');
  });
});

describe('THE EXIT — the person opened this window to plan', () => {
  it('says the work continues without them', () => {
    render(<PlanningIndexingWait {...props} />);
    expect(screen.getByTestId('planning-indexing-exit').textContent).toContain('come back');
  });
});

describe('THE FAILED ARM — two ways onward, because a dead end is forbidden', () => {
  const failed = { ...props, phase: 'failed' as const };

  it('says what happened without naming a cause it was not told', () => {
    render(<PlanningIndexingWait {...failed} onRetry={vi.fn()} onPlanAnyway={vi.fn()} />);
    const banner = screen.getByTestId('planning-indexing-banner');
    expect(banner.getAttribute('data-phase')).toBe('failed');
    expect(banner.textContent).toContain("I couldn't index acme/widgets");
    expect(banner.textContent).toContain('Nothing is lost');
  });

  it('offers BOTH ways onward, and each fires its own handler', () => {
    const onRetry = vi.fn();
    const onPlanAnyway = vi.fn();
    render(<PlanningIndexingWait {...failed} onRetry={onRetry} onPlanAnyway={onPlanAnyway} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Plan anyway' }));
    expect(onPlanAnyway).toHaveBeenCalledTimes(1);
  });

  it('and the EXIT line comes down — the work is NOT continuing without them', () => {
    render(<PlanningIndexingWait {...failed} onRetry={vi.fn()} onPlanAnyway={vi.fn()} />);
    expect(screen.queryByTestId('planning-indexing-exit')).toBeNull();
  });
});

describe('NOT A PROGRESS BAR — panel 1’s rule, on a second state', () => {
  it.each(['queued', 'running', 'failed'] as const)('%s carries no progressbar role', (phase) => {
    // `motir-core` is told an index SUCCEEDED and never how far along it is, so a
    // track and a fill would be a claim nothing can support. Indexing is the wait
    // that most feels like it has a percentage, which is why this is asserted per
    // phase rather than once.
    render(
      <PlanningIndexingWait {...props} phase={phase} onRetry={vi.fn()} onPlanAnyway={vi.fn()} />,
    );
    expect(screen.queryByRole('progressbar')).toBeNull();
    cleanup();
  });

  it('but it IS a live region, because what changes here is a statement', () => {
    const { container } = render(<PlanningIndexingWait {...props} />);
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });
});

describe('it names EVERY repository being waited on', () => {
  it('rather than a bare “your repository”', () => {
    render(<PlanningIndexingWait {...props} repositories={['acme/widgets', 'acme/api']} />);
    const banner = screen.getByTestId('planning-indexing-banner');
    expect(banner.textContent).toContain('acme/widgets');
    expect(banner.textContent).toContain('acme/api');
  });
});
