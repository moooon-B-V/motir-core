// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { DecisionWaitingHeaderLink } from '@/app/(authed)/items/[key]/_components/DecisionWaitingHeaderLink';
import { LATE_FALLBACK_ATTR } from '@/app/(authed)/items/[key]/_components/decisionAnchor';
import type { PendingDecisionDTO } from '@/lib/dto/approvalGate';
import zhMessages from '@/messages/zh.json';

// THE ITEM HEADER'S DECISION-WAITING MARKER (MOTIR-5878; design MOTIR-5875 panels
// 6–8). A POINTER to the section holding the gate — never a decide control. Its
// destination is whatever section carries `data-decision-anchor~="<kind>"`, and a
// press before the late tier has streamed waits for that section ONCE.

const YOURS: PendingDecisionDTO = { state: 'yours', kind: 'design_result', routedToId: 'u1' };

let scrolled: Element[] = [];

beforeEach(() => {
  scrolled = [];
  // happy-dom has no layout: record which element a press brings into view.
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

/** A late-tier section card, as `ContentSectionCard` renders one with anchors. */
function section(kinds: string, id: string) {
  const el = document.createElement('div');
  el.setAttribute('data-decision-anchor', kinds);
  el.tabIndex = -1;
  el.id = id;
  document.body.appendChild(el);
  return el;
}

describe('DecisionWaitingHeaderLink', () => {
  it('YOURS reads as the state AND the destination, and is never a Review & approve door', () => {
    render(<DecisionWaitingHeaderLink decision={YOURS} routedToName={null} />);
    const button = screen.getByRole('button', {
      name: 'Awaiting you — design approval. Go to the design approval',
    });
    expect(button.getAttribute('title')).toBe('Go to the design approval');
    expect(button.querySelector('[data-decision-marker="yours"]')).toBeTruthy();
    expect(button.querySelector('.lucide-arrow-down')).toBeTruthy();
    // The page's doors are the band's and the held notice's; this adds none.
    expect(screen.queryAllByRole('button', { name: /Review & approve/ })).toHaveLength(0);
    expect(document.querySelector('.lucide-scan-eye')).toBeNull();
  });

  it('OTHERS names who it waits on, in the quiet treatment', () => {
    render(
      <DecisionWaitingHeaderLink
        decision={{ state: 'others', kind: 'acceptance_result', routedToId: 'u2' }}
        routedToName="Ana Ruiz"
      />,
    );
    const button = screen.getByRole('button', {
      name: 'Waiting on Ana Ruiz — acceptance approval. Go to the acceptance approval',
    });
    expect(button.querySelector('[data-decision-marker="others"]')?.textContent).toContain(
      'Waiting on Ana Ruiz',
    );
  });

  it('lands on the section carrying ITS kind — scrolls to it and focuses it', () => {
    const development = section('pull_request_approval decision_approval', 'dev');
    const design = section('design_result', 'design');
    render(<DecisionWaitingHeaderLink decision={YOURS} routedToName={null} />);

    fireEvent.click(screen.getByRole('button'));

    expect(scrolled).toEqual([design]);
    expect(document.activeElement).toBe(design);
    expect(scrolled).not.toContain(development);
  });

  it('follows the frame: a design gate drawn INSIDE Development lands on Development', () => {
    const development = section('pull_request_approval decision_approval design_result', 'dev');
    render(<DecisionWaitingHeaderLink decision={YOURS} routedToName={null} />);

    fireEvent.click(screen.getByRole('button'));

    expect(scrolled).toEqual([development]);
    expect(document.activeElement).toBe(development);
  });

  it('pressed BEFORE the section has streamed: waits at the fallback, then lands ONCE', async () => {
    const fallback = document.createElement('div');
    fallback.setAttribute(LATE_FALLBACK_ATTR, '');
    document.body.appendChild(fallback);
    render(<DecisionWaitingHeaderLink decision={YOURS} routedToName={null} />);
    const button = screen.getByRole('button');

    fireEvent.click(button);

    expect(scrolled).toEqual([fallback]);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.lucide-loader-circle')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Opening the design approval…');

    // The late stack streams in: the fallback leaves, the section arrives.
    let design!: HTMLElement;
    await act(async () => {
      fallback.remove();
      design = section('design_result', 'design');
    });

    expect(scrolled).toEqual([fallback, design]);
    expect(document.activeElement).toBe(design);
    expect(button.getAttribute('aria-busy')).toBeNull();
    expect(button.querySelector('.lucide-arrow-down')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('');

    // ONCE: a later section mounting does not move the reader again.
    await act(async () => {
      section('design_result', 'design-2');
    });
    expect(scrolled).toHaveLength(2);
  });

  it('stops waiting, and stays put, when the stack settles with no section for its kind', async () => {
    const fallback = document.createElement('div');
    fallback.setAttribute(LATE_FALLBACK_ATTR, '');
    document.body.appendChild(fallback);
    render(<DecisionWaitingHeaderLink decision={YOURS} routedToName={null} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);

    await act(async () => {
      fallback.remove();
      section('pull_request_approval', 'dev'); // a section, but not for this kind
    });

    expect(button.getAttribute('aria-busy')).toBeNull();
    expect(scrolled).toEqual([fallback]);
  });

  it('with neither the section nor a pending stack, a press does nothing', () => {
    render(<DecisionWaitingHeaderLink decision={YOURS} routedToName={null} />);
    fireEvent.click(screen.getByRole('button'));
    expect(scrolled).toEqual([]);
    expect(screen.getByRole('button').getAttribute('aria-busy')).toBeNull();
  });

  it('renders in Chinese', () => {
    render(
      <DecisionWaitingHeaderLink
        decision={{ state: 'others', kind: 'design_result', routedToId: 'u2' }}
        routedToName="Ana"
      />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(
      screen.getByRole('button', { name: '等待 Ana 处理——设计审批. 前往设计审批' }),
    ).toBeTruthy();
  });
});

describe('ContentSectionCard — the anchor a section carries for the header marker', () => {
  it('renders `data-decision-anchor` (space-separated) and is focusable when given kinds', async () => {
    const { ContentSectionCard } =
      await import('@/app/(authed)/items/[key]/_components/ContentSectionCard');
    render(
      <ContentSectionCard
        title="Development"
        decisionAnchor={['pull_request_approval', 'design_result']}
      >
        body
      </ContentSectionCard>,
    );
    const card = document.querySelector('[data-decision-anchor]');
    expect(card?.getAttribute('data-decision-anchor')).toBe('pull_request_approval design_result');
    expect(card?.getAttribute('tabindex')).toBe('-1');
    expect(document.querySelector('[data-decision-anchor~="design_result"]')).toBe(card);
  });

  it('renders neither when given no kinds', async () => {
    const { ContentSectionCard } =
      await import('@/app/(authed)/items/[key]/_components/ContentSectionCard');
    render(<ContentSectionCard title="Description">body</ContentSectionCard>);
    expect(document.querySelector('[data-decision-anchor]')).toBeNull();
    expect(document.querySelector('[tabindex="-1"]')).toBeNull();
  });
});
