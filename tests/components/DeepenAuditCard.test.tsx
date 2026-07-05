// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { DeepenAuditCard } from '@/app/(authed)/code-health/_components/DeepenAuditCard';
import type { ExternalScannerStateDTO } from '@/lib/dto/codeHealth';

// The §10.3 "Deepen this audit" affordance (MOTIR-1592) under happy-dom. The card
// shows only in the `noExternalScanner` state (AuditPanel gates that); here we prove
// its OWN behaviour: best-fit branch (CodeQL default vs SonarQube), the dismiss +
// re-audit callbacks, and the re-auditing state.

function scannerState(over: Partial<ExternalScannerStateDTO> = {}): ExternalScannerStateDTO {
  return {
    detected: [],
    ingested: null,
    noExternalScanner: true,
    suggestion: 'github_code_scanning',
    ...over,
  };
}

afterEach(cleanup);

describe('DeepenAuditCard', () => {
  it('recommends GitHub CodeQL for a GitHub repo (the best-fit default)', () => {
    renderWithIntl(
      <DeepenAuditCard
        scanner={scannerState()}
        reauditing={false}
        onReaudit={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('Deepen this audit with an external scanner')).toBeTruthy();
    // Both tools are offered; the recommended badge sits on the CodeQL row.
    expect(screen.getByRole('button', { name: 'Set up CodeQL' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Sonar' })).toBeTruthy();
    const badgeRow = screen.getByText('Recommended').parentElement;
    expect(badgeRow?.textContent).toContain('CodeQL');
  });

  it('recommends SonarQube when the backend suggests it (non-GitHub repo)', () => {
    renderWithIntl(
      <DeepenAuditCard
        scanner={scannerState({ suggestion: 'sonarqube' })}
        reauditing={false}
        onReaudit={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const badgeRow = screen.getByText('Recommended').parentElement;
    expect(badgeRow?.textContent).toContain('SonarQube');
  });

  it('fires onDismiss from the × control', () => {
    const onDismiss = vi.fn();
    renderWithIntl(
      <DeepenAuditCard
        scanner={scannerState()}
        reauditing={false}
        onReaudit={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('expands the setup guidance and fires onReaudit from "Re-audit now"', () => {
    const onReaudit = vi.fn();
    renderWithIntl(
      <DeepenAuditCard
        scanner={scannerState()}
        reauditing={false}
        onReaudit={onReaudit}
        onDismiss={vi.fn()}
      />,
    );
    // The setup block (and its Re-audit now button) is hidden until the tool opens.
    expect(screen.queryByRole('button', { name: 'Re-audit now' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Set up CodeQL' }));
    const reaudit = screen.getByRole('button', { name: 'Re-audit now' });
    fireEvent.click(reaudit);
    expect(onReaudit).toHaveBeenCalledTimes(1);
  });

  it('shows the re-auditing state and hides the tool rows while a re-audit runs', () => {
    renderWithIntl(
      <DeepenAuditCard
        scanner={scannerState()}
        reauditing={true}
        onReaudit={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('Re-auditing your code…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up CodeQL' })).toBeNull();
  });
});
