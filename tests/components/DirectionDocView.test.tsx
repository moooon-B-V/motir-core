// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { DirectionDocView } from '@/components/onboarding/DirectionDocView';
import type {
  DirectionDocView as DirectionDocModel,
  FeatureCatalogView as FeatureCatalogModel,
} from '@/lib/onboarding/directionDoc';

afterEach(() => cleanup());

const VISION_MD = [
  '# Motir — Vision (Tier 2)',
  '',
  '## 1. Pitch',
  '',
  'A focused invoicing tool for **solo freelancers**.',
  '',
  '## 2. In scope',
  '',
  '- Create & send invoices',
  '- Track paid / overdue',
  '',
  '## 12. Open questions',
  '',
  '- Will Stripe coverage gate which markets launch first?',
  '',
  '## 13. Non-goals',
  '',
  'Not a full accounting suite.',
].join('\n');

const visionDoc: DirectionDocModel = { kind: 'vision', contentMd: VISION_MD };

const catalog: FeatureCatalogModel = {
  categories: [
    {
      id: 'c1',
      title: 'Invoicing',
      features: [
        {
          id: 'f1',
          name: 'Send invoices',
          descriptionMd: 'A clean form, emailed as a PDF.',
          phase: 'mvp',
          status: 'todo',
        },
      ],
    },
  ],
  glossary: [
    {
      id: 'g1',
      title: 'Money',
      concepts: [
        {
          id: 'gc1',
          term: 'Overdue',
          aka: 'late',
          descriptionMd: 'An invoice past its due date.',
          example: 'Sent Jan 1, due Jan 15, unpaid Jan 16.',
        },
      ],
    },
  ],
};

describe('DirectionDocView', () => {
  it('renders the plain-language tier label as the title, not the internal doc title', () => {
    render(<DirectionDocView doc={visionDoc} />);
    expect(screen.getByRole('heading', { level: 1, name: "What we'll build" })).toBeTruthy();
    // the jargon internal title is stripped
    expect(screen.queryByText(/Motir — Vision \(Tier 2\)/)).toBeNull();
  });

  it('renders the editorial Markdown body', () => {
    render(<DirectionDocView doc={visionDoc} />);
    expect(screen.getByRole('heading', { name: '1. Pitch' })).toBeTruthy();
    expect(screen.getByText('solo freelancers').tagName).toBe('STRONG');
    expect(screen.getByText('Create & send invoices')).toBeTruthy();
  });

  it('is READ-ONLY — no edit affordance and a read-only hint', () => {
    render(<DirectionDocView doc={visionDoc} />);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    // the read-only hint is present (chat is the sole input)
    expect(screen.getByText(/Read-only\./)).toBeTruthy();
  });

  it('surfaces the Open questions as a distinct region, removed from the body', () => {
    render(<DirectionDocView doc={visionDoc} />);
    const region = screen.getByRole('complementary', { name: 'Open questions' });
    expect(within(region).getByText(/Stripe coverage gate/)).toBeTruthy();
    // the body keeps later sections but no longer carries the open-questions section twice
    expect(screen.getByRole('heading', { name: '13. Non-goals' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /12\. Open questions/ })).toBeNull();
  });

  it('folds the feature catalog into the VISION tier only', () => {
    const { unmount } = render(<DirectionDocView doc={visionDoc} catalog={catalog} />);
    expect(screen.getByRole('region', { name: 'Feature catalog' })).toBeTruthy();
    expect(screen.getByText('Send invoices')).toBeTruthy();
    expect(screen.getByText('MVP')).toBeTruthy();
    expect(screen.getByText('Overdue')).toBeTruthy();
    unmount();

    // a discovery doc must NOT render a catalog even if one is passed
    render(
      <DirectionDocView
        doc={{ kind: 'discovery', contentMd: '## 1. Problem' }}
        catalog={catalog}
      />,
    );
    expect(screen.queryByRole('region', { name: 'Feature catalog' })).toBeNull();
  });

  it('renders cross-links to the other produced tiers in journey order', () => {
    const onNavigate = vi.fn();
    render(
      <DirectionDocView
        doc={visionDoc}
        availableDocs={['validation', 'discovery', 'vision']}
        onNavigate={onNavigate}
      />,
    );
    const nav = screen.getByRole('navigation', { name: 'Other parts of your direction' });
    const links = within(nav).getAllByRole('button');
    // self (vision) filtered out; ordered discovery → validation
    expect(links.map((b) => b.textContent)).toEqual([
      expect.stringContaining('Understanding your idea'),
      expect.stringContaining('Will people want it?'),
    ]);
    fireEvent.click(links[0]!);
    expect(onNavigate).toHaveBeenCalledWith('discovery');
  });

  it('renders cross-links as non-interactive labels when no onNavigate is given', () => {
    render(<DirectionDocView doc={visionDoc} availableDocs={['discovery']} />);
    const nav = screen.getByRole('navigation', { name: 'Other parts of your direction' });
    expect(within(nav).queryByRole('button')).toBeNull();
    expect(within(nav).getByText('Understanding your idea')).toBeTruthy();
  });

  it('applies the tier colour accent', () => {
    const { container } = render(<DirectionDocView doc={visionDoc} />);
    const article = container.querySelector('.dd-doc') as HTMLElement;
    expect(article.style.getPropertyValue('--dd-accent')).toBe('var(--el-accent-on-surface)');
  });
});
