// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/dom';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { TierReviewGate } from '@/components/onboarding/TierReviewGate';
import type { DirectionDocView, FeatureCatalogView } from '@/lib/onboarding/directionDoc';
import type { PreplanRevisionDTO } from '@/lib/dto/aiPreplan';

afterEach(() => cleanup());

const doc: DirectionDocView = {
  kind: 'discovery',
  contentMd: '# Discovery (Tier 1)\n\nA focused invoicing tool for freelancers.',
  version: 1,
};

const visionDoc: DirectionDocView = {
  kind: 'vision',
  contentMd: '# Vision (Tier 2)\n\nA calm invoicing workspace for freelancers.',
  version: 1,
};

const catalog: FeatureCatalogView = {
  categories: [
    {
      id: 'cat_1',
      title: 'Work Items',
      features: [
        { id: 'f1', name: 'Boards', descriptionMd: 'Kanban + Scrum', phase: 'mvp', status: 'todo' },
      ],
    },
  ],
  glossary: [],
};

describe('TierReviewGate', () => {
  it('renders the embedded read-only doc + the Continue gate', () => {
    renderWithIntl(
      <TierReviewGate
        doc={doc}
        availableKinds={['vision']}
        revisions={[]}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText('Pre-plan · building your direction')).toBeTruthy();
    expect(screen.getByText(/A focused invoicing tool/)).toBeTruthy();
    expect(screen.getByText(/nothing locks until your plan generates/)).toBeTruthy();
  });

  it('folds the feature catalog into the VISION tier review (7.3.79)', () => {
    renderWithIntl(
      <TierReviewGate
        doc={visionDoc}
        availableKinds={['discovery']}
        revisions={[]}
        catalog={catalog}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    // the catalog renders inside the vision review
    expect(screen.getByText('The feature catalog')).toBeTruthy();
    expect(screen.getByText('Work Items')).toBeTruthy();
    expect(screen.getByText('Boards')).toBeTruthy();
  });

  it('does NOT render the catalog on a non-vision tier even when one is passed', () => {
    renderWithIntl(
      <TierReviewGate
        doc={doc} // discovery
        availableKinds={['vision']}
        revisions={[]}
        catalog={catalog}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.queryByText('The feature catalog')).toBeNull();
  });

  it('renders the vision tier with no catalog section when none is drafted', () => {
    renderWithIntl(
      <TierReviewGate
        doc={visionDoc}
        availableKinds={[]}
        revisions={[]}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.queryByText('The feature catalog')).toBeNull();
    expect(screen.getByText(/A calm invoicing workspace/)).toBeTruthy();
  });

  it('fires Continue and Back', () => {
    const onContinue = vi.fn();
    const onBack = vi.fn();
    renderWithIntl(
      <TierReviewGate
        doc={doc}
        availableKinds={[]}
        revisions={[]}
        onBack={onBack}
        onContinue={onContinue}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Looks good — continue/ }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Back' })[0]!);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('disables Continue while a turn is in flight', () => {
    renderWithIntl(
      <TierReviewGate
        doc={doc}
        availableKinds={[]}
        revisions={[]}
        onBack={vi.fn()}
        onContinue={vi.fn()}
        busy
      />,
    );
    const cont = screen.getByRole('button', { name: /Looks good — continue/ }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
  });

  it('shows the on-page validate-early decision and BLOCKS Continue until chosen', () => {
    const onProveDemand = vi.fn();
    const onBuildItAll = vi.fn();
    const validationDoc: DirectionDocView = {
      kind: 'validation',
      contentMd: '# Validation (Tier 4)\n\nReal demand, but unproven for this take.',
      version: 1,
    };
    renderWithIntl(
      <TierReviewGate
        doc={validationDoc}
        availableKinds={[]}
        revisions={[]}
        validateDecision={{ onProveDemand, onBuildItAll }}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText('One call before we plan')).toBeTruthy();
    const cont = screen.getByRole('button', { name: /Looks good — continue/ }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Prove demand first/ }));
    expect(onProveDemand).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /No — build it all/ }));
    expect(onBuildItAll).toHaveBeenCalledTimes(1);
  });

  it('surfaces the revise / diff / cascade-back layer when the tier was revised (1179)', () => {
    const revisedDoc: DirectionDocView = { ...doc, version: 2 };
    const revisions: PreplanRevisionDTO[] = [
      {
        version: 2,
        changeReason: 'you broadened the audience',
        changeKind: 'direct',
        diff: [{ path: 'pitch.headline', kind: 'changed', before: 'Freelancers', after: 'SMBs' }],
        createdAt: '2026-06-21T00:00:00.000Z',
      },
      {
        version: 1,
        changeReason: null,
        changeKind: 'created',
        diff: null,
        createdAt: '2026-06-20T00:00:00.000Z',
      },
    ];
    renderWithIntl(
      <TierReviewGate
        doc={revisedDoc}
        availableKinds={[]}
        revisions={revisions}
        cascadeActive
        willRefresh={['vision']}
        onBack={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByText('Going back to revisit this step')).toBeTruthy(); // G3 banner
    expect(screen.getByText('What changed')).toBeTruthy(); // latest-revision diff
    expect(screen.getByText('Pitch › Headline')).toBeTruthy();
    expect(screen.getByText('Revision history')).toBeTruthy(); // the log viewer
  });
});
