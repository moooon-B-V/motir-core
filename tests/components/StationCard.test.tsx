// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
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

// MOTIR-1225 — the canvas captured-findings render the STRUCTURED per-tier
// summary (motir-ai derives it; design `ai-chat` screen C: What/Who/Closest ·
// In v1/Out), falling back to the Markdown-derived lines for a tier that has a
// body but no structured summary yet.
const discoveryWithSummary: DirectionDocView = {
  kind: 'discovery',
  contentMd: '# Discovery (Tier 1)\n\nMarkdown body line that must NOT show.',
  version: 2,
  summary: [
    { label: 'What', value: 'send & track invoices', tone: 'positive' },
    { label: 'Who', value: 'solo freelancers', tone: 'positive' },
    { label: 'Closest', value: 'FreshBooks · Wave', tone: 'positive' },
  ],
};

const visionWithMutedOut: DirectionDocView = {
  kind: 'vision',
  contentMd: '# Vision (Tier 2)\n\nbody',
  version: 1,
  summary: [
    { label: 'In v1', value: 'invoices, reminders', tone: 'positive' },
    { label: 'Out', value: 'teams, accounting', tone: 'neutral' },
  ],
};

describe('StationCard captured findings — structured summary (MOTIR-1225)', () => {
  it('renders the labelled key→value findings, NOT the Markdown body, when a summary is present', () => {
    renderWithIntl(
      <StationCard
        station={station({ kind: 'discovery', state: 'done', openable: true })}
        doc={discoveryWithSummary}
        session={session}
      />,
    );
    // the labels render as their own (bold) spans
    expect(screen.getByText('What')).not.toBeNull();
    expect(screen.getByText('Who')).not.toBeNull();
    expect(screen.getByText('Closest')).not.toBeNull();
    // the values render alongside their label
    expect(screen.getByText(/send & track invoices/)).not.toBeNull();
    expect(screen.getByText(/FreshBooks · Wave/)).not.toBeNull();
    // the Markdown-derived fallback line is SUPPRESSED when a summary exists
    expect(screen.queryByText(/Markdown body line that must NOT show/)).toBeNull();
  });

  it('carries the muted negative-space "Out" finding (the neutral tone row)', () => {
    renderWithIntl(
      <StationCard
        station={station({ kind: 'vision', state: 'done', openable: true })}
        doc={visionWithMutedOut}
        session={session}
      />,
    );
    expect(screen.getByText('Out')).not.toBeNull();
    expect(screen.getByText(/teams, accounting/)).not.toBeNull();
  });

  it('falls back to the Markdown-derived lines when the tier has no structured summary', () => {
    renderWithIntl(
      <StationCard
        station={station({ kind: 'discovery', state: 'done', openable: true })}
        doc={{
          kind: 'discovery',
          contentMd: '# Discovery (Tier 1)\n\nThe problem is real and acute.',
          version: 1,
          // no `summary` → the pre-MOTIR-1225 captureLines path
        }}
        session={session}
      />,
    );
    expect(screen.getByText(/The problem is real and acute/)).not.toBeNull();
  });
});

describe('StationCard Continue on the active step (MOTIR-1372)', () => {
  it('renders a Continue button on the active card when onContinue is provided', () => {
    const onContinue = vi.fn();
    renderWithIntl(
      <StationCard
        station={station({ kind: 'vision', state: 'active', openable: true })}
        doc={undefined}
        session={session}
        onContinue={onContinue}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Looks good — continue' });
    fireEvent.click(btn);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('renders no Continue button when onContinue is absent', () => {
    renderWithIntl(
      <StationCard
        station={station({ kind: 'vision', state: 'active', openable: true })}
        doc={undefined}
        session={session}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Looks good — continue' })).toBeNull();
  });
});
