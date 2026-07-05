// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { DevelopmentSectionBody } from '@/components/github/DevelopmentSection';
import type { LinkedPullRequestDto } from '@/lib/dto/github';

// Story 7.10 · MOTIR-1596 — the display side of the explicit item→PR link on the
// shared Development body: a MANUALLY-linked row carries the quiet "linked
// manually" provenance suffix, and the detail host (`manualLinkable`) extends the
// auto-link caption with "— or linked by hand from here" (design Panel 5a).

afterEach(cleanup);

const autoPr: LinkedPullRequestDto = {
  title: 'Auto-resolved change',
  repo: 'moooon/motir-core',
  number: 11,
  state: 'open',
  ci: null,
  url: 'https://github.com/moooon/motir-core/pull/11',
  linkedManually: false,
};
const manualPr: LinkedPullRequestDto = {
  title: 'Hand-linked change',
  repo: 'moooon/motir-gateway',
  number: 57,
  state: 'merged',
  ci: null,
  url: 'https://github.com/moooon/motir-gateway/pull/57',
  linkedManually: true,
};

describe('DevelopmentSectionBody — manual-link provenance (MOTIR-1596)', () => {
  it('shows the "linked manually" suffix only on a manually-linked row', () => {
    render(<DevelopmentSectionBody pullRequests={[autoPr, manualPr]} itemIdentifier="MOTIR-11" />);
    const suffixes = screen.getAllByText('linked manually');
    expect(suffixes).toHaveLength(1);
    // The suffix sits inside the manual PR's meta line (next to its repo/number).
    expect(suffixes[0]!.closest('div')!.textContent).toContain('moooon/motir-gateway · #57');
  });

  it('the detail host (manualLinkable) caption invites hand-linking; the peek does not', () => {
    const { rerender } = render(
      <DevelopmentSectionBody pullRequests={[autoPr]} itemIdentifier="MOTIR-11" manualLinkable />,
    );
    expect(screen.getByText(/or linked by hand from here/i)).toBeTruthy();

    rerender(<DevelopmentSectionBody pullRequests={[autoPr]} itemIdentifier="MOTIR-11" />);
    expect(screen.queryByText(/or linked by hand from here/i)).toBeNull();
  });
});
