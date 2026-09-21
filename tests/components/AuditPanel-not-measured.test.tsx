// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { AuditPanel } from '@/app/(authed)/code/_components/AuditPanel';
import type { CodeAuditFindingDTO, CodeAuditSurfaceDTO } from '@/lib/dto/codeHealth';
import enMessages from '@/messages/en.json';

// MOTIR-5921: an audit that could not read the code graph measured NOTHING. It used
// to render the raw grade word `unknown` over "No findings — your code meets the
// convention", which a person reads as a clean bill of health for code nobody read.
// It now renders "not measured", never a grade and never the all-clear.

const NOT_MEASURED_TITLE = enMessages.codeHealth.audit.notMeasuredTitle;
const MEETS_CONVENTION = enMessages.codeHealth.audit.noFindings;
const REAUDIT = enMessages.codeHealth.audit.repos.reauditOne;

function audit(
  healthSummary: NonNullable<CodeAuditSurfaceDTO['audit']>['healthSummary'],
): CodeAuditSurfaceDTO['audit'] {
  return {
    id: 'audit_1',
    healthSummary,
    codeGraphRef: null,
    repoKey: 'moooon-B-V/motir-ai',
    createdAt: '2026-09-21T15:27:14.000Z',
  };
}

function renderPanel(over: {
  audit: CodeAuditSurfaceDTO['audit'];
  findings?: CodeAuditFindingDTO[];
  onReaudit?: () => void;
}) {
  const findings = over.findings ?? [];
  return renderWithIntl(
    <AuditPanel
      audit={over.audit}
      repoRefs={['moooon-B-V/motir-ai']}
      findings={findings}
      total={findings.length}
      hasMore={false}
      loadingMore={false}
      onLoadMore={vi.fn()}
      scanner={null}
      reauditing={false}
      onReaudit={over.onReaudit ?? vi.fn()}
      partiallyDerivedRepoRef={null}
      unavailableRepoRef={null}
      onRetryRepo={vi.fn()}
      pollExhausted={false}
      onCheckAgain={vi.fn()}
      deepenDismissed={false}
      onDeepenDismiss={vi.fn()}
      onDeepenReopen={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe('AuditPanel — an audit that read no code graph', () => {
  it('renders the not-measured state, not the "meets the convention" all-clear', () => {
    renderPanel({ audit: audit({ notMeasured: true, totalFindings: 0 }) });

    expect(screen.getByText(NOT_MEASURED_TITLE)).toBeTruthy();
    expect(screen.queryByText(MEETS_CONVENTION)).toBeNull();
  });

  it('shows no grade — not even the placeholder word a pre-fix audit recorded', () => {
    const { container } = renderPanel({
      audit: audit({ notMeasured: true, grade: 'unknown' }),
    });

    expect(container.textContent).not.toContain('unknown');
    expect(container.textContent).not.toContain(enMessages.codeHealth.audit.measuredAgainst);
  });

  it('offers the re-audit as the way out', () => {
    const onReaudit = vi.fn();
    renderPanel({ audit: audit({ notMeasured: true }), onReaudit });

    fireEvent.click(screen.getByRole('button', { name: REAUDIT }));
    expect(onReaudit).toHaveBeenCalledTimes(1);
  });

  it('still lists findings an external scanner supplied', () => {
    renderPanel({
      audit: audit({ notMeasured: true }),
      findings: [
        {
          ruleId: 'js/sql-injection',
          category: 'security',
          severity: 'high',
          fileRef: 'src/db.ts:12',
          symbolRef: null,
          why: 'Query built from user input.',
          conventionRuleRef: null,
        },
      ],
    });

    expect(screen.getByText(NOT_MEASURED_TITLE)).toBeTruthy();
    expect(screen.getByText('Query built from user input.')).toBeTruthy();
  });

  it('a MEASURED audit with no findings keeps its all-clear', () => {
    renderPanel({ audit: audit({ grade: 'A', conformancePct: 96, totalFindings: 0 }) });

    expect(screen.getByText(MEETS_CONVENTION)).toBeTruthy();
    expect(screen.queryByText(NOT_MEASURED_TITLE)).toBeNull();
  });
});
