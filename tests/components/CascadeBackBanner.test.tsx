// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { CascadeBackBanner } from '@/components/onboarding/CascadeBackBanner';

afterEach(() => cleanup());

describe('CascadeBackBanner', () => {
  it('explains the going-back, reassures nothing is locked, and lists the refreshing tiers', () => {
    renderWithIntl(<CascadeBackBanner willRefresh={['vision', 'validation']} />);
    expect(screen.getByText('Going back to revisit this step')).toBeTruthy();
    expect(screen.getByText("Nothing's locked — going back is always safe.")).toBeTruthy();
    expect(screen.getByText('Will refresh:')).toBeTruthy();
    // Downstream tiers named by their plain-language labels.
    expect(screen.getByText("What we'll build")).toBeTruthy();
    expect(screen.getByText('Will people want it?')).toBeTruthy();
  });

  it('omits the "will refresh" row when no downstream tiers cascade', () => {
    renderWithIntl(<CascadeBackBanner willRefresh={[]} />);
    expect(screen.getByText('Going back to revisit this step')).toBeTruthy();
    expect(screen.queryByText('Will refresh:')).toBeNull();
  });
});
