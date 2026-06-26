// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { StationCard } from '@/components/onboarding/StationNode';
import type { StationView } from '@/lib/onboarding/canvasModel';
import type { DiscoverySession } from '@/lib/onboarding/discoveryLoop';
import type { DirectionDocView } from '@/lib/onboarding/directionDoc';

// MOTIR-1363 — the "can skip" tag on an optional station must disappear once the
// step is no longer skippable: a tier whose doc is PRODUCED (linked), and the
// design step once a design has been CHOSEN.

afterEach(() => cleanup());

const session: DiscoverySession = {
  classification: null,
  platform: 'web',
  validationTiming: null,
  currentGate: null,
  status: 'active',
  designChoice: null,
};

function station(over: Partial<StationView> & Pick<StationView, 'kind'>): StationView {
  return { state: 'upcoming', optional: true, openable: false, ...over };
}

const validationDoc: DirectionDocView = {
  kind: 'validation',
  contentMd: '# Validation (Tier 4)\n\nInterview 10 founders first.',
  version: 1,
};

describe('StationCard "can skip" tag (MOTIR-1363)', () => {
  it('SHOWS on an optional tier that is still upcoming with no doc yet', () => {
    renderWithIntl(
      <StationCard
        station={station({ kind: 'validation', state: 'upcoming' })}
        doc={undefined}
        session={session}
      />,
    );
    expect(screen.queryByText('can skip')).not.toBeNull();
  });

  it('HIDES once the tier doc is produced (linked)', () => {
    renderWithIntl(
      <StationCard
        station={station({ kind: 'validation', state: 'active', openable: true })}
        doc={validationDoc}
        session={session}
      />,
    );
    expect(screen.queryByText('can skip')).toBeNull();
  });

  it('SHOWS on the design step before a design is chosen', () => {
    renderWithIntl(
      <StationCard
        station={station({ kind: 'design', state: 'active' })}
        doc={undefined}
        session={session}
      />,
    );
    expect(screen.queryByText('can skip')).not.toBeNull();
  });

  it('HIDES on the design step once a design has been chosen', () => {
    renderWithIntl(
      <StationCard
        station={station({ kind: 'design', state: 'active' })}
        doc={undefined}
        session={{
          ...session,
          designChoice: { styleId: 'soft-playful', paletteId: 'cobalt', typeId: 'grotesk' },
        }}
      />,
    );
    expect(screen.queryByText('can skip')).toBeNull();
  });
});
