// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { RunFindings } from '@/app/(authed)/runs/_components/RunFindings';
import type { DispatchRunEventDto } from '@/lib/dto/dispatchRuns';

// WHAT THE RUN PRODUCED, on the surface (Story MOTIR-1789 · MOTIR-3983).
//
// ⚠️ THE ABSENT CASE IS THE FIRST ASSERTION, not the last. Most runs file no bug
// and submit no plan, so a strip that is present and empty on every ordinary run
// teaches a reader to skip exactly the place the rare thing appears — and that
// failure renders perfectly, which is why it needs a test rather than an eye.

afterEach(cleanup);

function ev(
  over: Partial<DispatchRunEventDto> & { kind: string; seq: number },
): DispatchRunEventDto {
  return {
    id: `e${over.seq}`,
    cardId: 'leg_1',
    data: null,
    body: null,
    createdAt: '2026-08-30T14:02:00.000Z',
    ...over,
  } as DispatchRunEventDto;
}

const bug = (seq: number, key: string | null, title: string | null) =>
  ev({ kind: 'bug_filed', seq, data: { key, workItemId: 'wi', title } });
const submitted = (seq: number, planId: string | null, proposalCount: number | null) =>
  ev({ kind: 'plan_submitted', seq, data: { planId, proposalCount } });
const approved = (seq: number, planId: string, key: string, proposalCount: number) =>
  ev({ kind: 'plan_approved', seq, data: { planId, key, proposalCount } });

describe('⚠️ a run that produced NEITHER grows no region at all', () => {
  it('renders nothing for an empty stream', () => {
    const { container } = render(<RunFindings events={[]} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('run-findings')).toBeNull();
  });

  it('renders nothing for a run whose events are all ordinary lifecycle', () => {
    const { container } = render(
      <RunFindings events={[ev({ kind: 'card_settled', seq: 1 }), ev({ kind: 'log', seq: 2 })]} />,
    );
    // Not an empty box, not a heading — NOTHING. The log starts at the top.
    expect(container.innerHTML).toBe('');
  });
});

describe('the PLAN in its two states, which must not look alike', () => {
  it('a SUBMITTED plan is an ASK: it says it is waiting and offers the review', () => {
    render(<RunFindings events={[submitted(3, 'pln_8c41', 6)]} />);

    const row = screen.getByTestId('finding-plan-submitted');
    expect(row.textContent).toContain('Plan submitted');
    expect(row.textContent).toContain('6 proposals');
    expect(row.textContent).toContain('waiting for you');
    const link = screen.getByRole('link', { name: 'Review →' });
    expect(link.getAttribute('href')).toBe('/plans/pln_8c41');
  });

  it('an APPROVED plan is NEWS: no waiting language, and named plan by plan', () => {
    render(
      <RunFindings
        events={[approved(4, 'pln_a077', 'MOTIR-1793', 2), approved(5, 'pln_b12', 'MOTIR-1801', 3)]}
      />,
    );

    const row = screen.getByTestId('finding-plan-approved');
    expect(row.textContent).toContain('your tree changed while you were away');
    expect(row.textContent).not.toContain('waiting for you');
    // ⚠️ NAMED PLAN BY PLAN, never a count — `autoLoop.ts` settled that, and a
    // count would tell an operator their tree moved without telling them where.
    expect(row.textContent).toContain('pln_a077');
    expect(row.textContent).toContain('MOTIR-1793');
    expect(row.textContent).toContain('pln_b12');
    expect(row.textContent).toContain('MOTIR-1801');
  });

  it('the two are DIFFERENT rows — an ask never wears the news face', () => {
    render(<RunFindings events={[submitted(1, 'pln_1', 1), approved(2, 'pln_2', 'MOTIR-9', 1)]} />);
    expect(screen.getByTestId('finding-plan-submitted')).toBeTruthy();
    expect(screen.getByTestId('finding-plan-approved')).toBeTruthy();
  });
});

describe('the BUGS — separate rows, each one reachable', () => {
  it('shows one bug, with a link to it', () => {
    render(<RunFindings events={[bug(2, 'MOTIR-3991', 'Prisma generate fails')]} />);

    const row = screen.getByTestId('finding-bug');
    expect(row.textContent).toContain('MOTIR-3991');
    expect(row.textContent).toContain('Prisma generate fails');
    expect(screen.getByRole('link', { name: 'Open →' }).getAttribute('href')).toBe(
      '/items/MOTIR-3991',
    );
  });

  it('⚠️ SEVERAL from one run stay several rows — never "3 bugs"', () => {
    render(
      <RunFindings
        events={[
          bug(1, 'MOTIR-1', 'first'),
          bug(2, 'MOTIR-2', 'second'),
          bug(3, 'MOTIR-3', 'third'),
        ]}
      />,
    );

    expect(screen.getAllByTestId('finding-bug')).toHaveLength(3);
    expect(screen.getAllByRole('link', { name: 'Open →' })).toHaveLength(3);
  });
});

describe('⚠️ it renders ONLY what the record carries', () => {
  it('a bug whose event has no title shows no title, and invents none', () => {
    render(<RunFindings events={[bug(1, 'MOTIR-3991', null)]} />);
    const row = screen.getByTestId('finding-bug');
    expect(row.textContent).toContain('MOTIR-3991');
    // The em-dash separator only appears WITH a title.
    expect(row.textContent).not.toContain('—');
  });

  it('a finding whose TARGET the record cannot name renders, with no link', () => {
    // The gone case: drawn from `data` alone. It must not be dropped (that would
    // say the run found nothing) and must not link nowhere.
    render(<RunFindings events={[bug(1, null, 'A defect somebody later deleted')]} />);

    const row = screen.getByTestId('finding-bug');
    expect(row.textContent).toContain('A defect somebody later deleted');
    expect(screen.queryByRole('link', { name: 'Open →' })).toBeNull();
  });

  it('a submitted plan with no plan id renders the fact and offers no review link', () => {
    render(<RunFindings events={[submitted(1, null, 4)]} />);
    expect(screen.getByTestId('finding-plan-submitted').textContent).toContain('Plan submitted');
    expect(screen.queryByRole('link', { name: 'Review →' })).toBeNull();
  });

  it('a malformed `data` payload does not crash the strip', () => {
    render(
      <RunFindings
        events={[
          ev({ kind: 'bug_filed', seq: 1, data: 'not an object' }),
          ev({ kind: 'plan_submitted', seq: 2, data: { planId: 42, proposalCount: 'six' } }),
        ]}
      />,
    );
    // Both rows still render; neither invents a value from a wrong type.
    expect(screen.getByTestId('finding-bug')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Review →' })).toBeNull();
  });
});

describe('the order is the RUN’s', () => {
  it('sorts by seq, not by arrival', () => {
    render(
      <RunFindings events={[bug(9, 'MOTIR-LATE', 'later'), bug(2, 'MOTIR-EARLY', 'earlier')]} />,
    );
    const strip = screen.getByTestId('run-findings');
    expect(strip.textContent!.indexOf('earlier')).toBeLessThan(strip.textContent!.indexOf('later'));
  });
});
