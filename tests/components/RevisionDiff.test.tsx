// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { RevisionDiff } from '@/components/onboarding/RevisionDiff';

afterEach(() => cleanup());

describe('RevisionDiff', () => {
  it('renders added / removed / changed leaf changes with humanized paths + values', () => {
    renderWithIntl(
      <RevisionDiff
        diff={[
          { path: 'pitch.headline', kind: 'changed', before: 'Old line', after: 'New line' },
          { path: 'mvpScope.includes[2]', kind: 'added', after: 'CSV export' },
          { path: 'risks[0]', kind: 'removed', before: 'churn' },
        ]}
      />,
    );
    // Kind chips.
    expect(screen.getByText('Added')).toBeTruthy();
    expect(screen.getByText('Removed')).toBeTruthy();
    expect(screen.getByText('Changed')).toBeTruthy();
    // Humanized paths (camel → spaced, array index 1-indexed).
    expect(screen.getByText('Pitch › Headline')).toBeTruthy();
    expect(screen.getByText('Mvp Scope › Includes › 3')).toBeTruthy();
    // Values: changed shows before AND after.
    expect(screen.getByText('Old line')).toBeTruthy();
    expect(screen.getByText('New line')).toBeTruthy();
    expect(screen.getByText('CSV export')).toBeTruthy();
    expect(screen.getByText('churn')).toBeTruthy();
  });

  it('renders the "no changes" line for an empty or malformed diff', () => {
    const { container } = renderWithIntl(<RevisionDiff diff={null} />);
    expect(container.textContent).toContain('Nothing changed in this revision.');
    cleanup();
    renderWithIntl(<RevisionDiff diff={[]} />);
    expect(screen.getByText('Nothing changed in this revision.')).toBeTruthy();
  });
});
