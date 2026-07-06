// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import type { AcceptanceEvidenceDTO } from '@/lib/dto/acceptanceEvidence';
import type { AcceptanceVideoEligibilityDTO } from '@/lib/dto/acceptanceVideoEligibility';

// AcceptancePanel (Story MOTIR-1627 · Subtask MOTIR-1634) — the three eligibility
// states + the gate action, rendered in happy-dom. The server actions + router
// are mocked; the panel's branching + the optimistic reconcile are under test.

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
const { decideAcceptanceAction, turnOnAcceptanceVideoAction } = vi.hoisted(() => ({
  decideAcceptanceAction: vi.fn(),
  turnOnAcceptanceVideoAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/(authed)/items/[key]/acceptanceActions', () => ({
  decideAcceptanceAction,
  turnOnAcceptanceVideoAction,
}));

const { AcceptancePanel } = await import('@/app/(authed)/items/[key]/_components/AcceptancePanel');

function eligibility(p: Partial<AcceptanceVideoEligibilityDTO>): AcceptanceVideoEligibilityDTO {
  return {
    applicable: true,
    eligible: true,
    reason: 'eligible',
    hasPaidAiPlan: true,
    toggleEnabled: true,
    canManageBilling: true,
    canManageToggle: true,
    organizationId: 'org_1',
    ...p,
  };
}

function evidence(p: Partial<AcceptanceEvidenceDTO> = {}): AcceptanceEvidenceDTO {
  return {
    id: 'ev_1',
    workItemId: 'wi_1',
    status: 'pending',
    videoUrl: 'https://blob.example/run.webm',
    mimeType: 'video/webm',
    sizeBytes: 1024,
    traceUrl: null,
    chapters: [{ label: 'Open the story', tSeconds: 2 }],
    commitSha: 'a981c09abc',
    ciRunUrl: 'https://ci.example/run/1',
    producedByKey: 'MOTIR-1638',
    approvedById: null,
    approvedAt: null,
    createdAt: '2026-07-05T00:00:00.000Z',
    ...p,
  };
}

function renderPanel(props: Parameters<typeof AcceptancePanel>[0]) {
  return render(
    <ToastProvider>
      <AcceptancePanel {...props} />
    </ToastProvider>,
  );
}

const baseProps = {
  workItemId: 'wi_1',
  organizationId: 'org_1',
  settingsHref: '/settings/organization',
};

afterEach(cleanup);

describe('AcceptancePanel', () => {
  it('eligible + evidence → player, chapters, provenance, and the gate buttons', () => {
    renderPanel({
      ...baseProps,
      eligibility: eligibility({}),
      initialEvidence: evidence(),
      canDecide: true,
    });
    expect(screen.getByText('Open the story')).toBeTruthy();
    expect(screen.getByText('a981c09')).toBeTruthy(); // short commit
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /request changes/i })).toBeTruthy();
  });

  it('Approve calls the action + reconciles from the response (no self-refresh of state)', async () => {
    decideAcceptanceAction.mockResolvedValueOnce({
      ok: true,
      storyStatus: 'done',
      evidence: evidence({ status: 'approved', approvedById: 'Yue' }),
    });
    renderPanel({
      ...baseProps,
      eligibility: eligibility({}),
      initialEvidence: evidence(),
      canDecide: true,
    });
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    await waitFor(() => expect(decideAcceptanceAction).toHaveBeenCalledWith('wi_1', 'approve'));
    // After approval the buttons are gone and the Approved pill shows.
    await waitFor(() => expect(screen.getByText('Approved')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /request changes/i })).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it('pending (eligible, no evidence) → the waiting state', () => {
    renderPanel({
      ...baseProps,
      eligibility: eligibility({}),
      initialEvidence: null,
      canDecide: true,
    });
    expect(screen.getByText('Waiting for the acceptance video')).toBeTruthy();
  });

  it('toggle_off + admin → the Turn-on switch', () => {
    renderPanel({
      ...baseProps,
      eligibility: eligibility({ eligible: false, reason: 'toggle_off', toggleEnabled: false }),
      initialEvidence: null,
      canDecide: false,
    });
    expect(screen.getByText('Acceptance video is off')).toBeTruthy();
    expect(screen.getByRole('switch')).toBeTruthy();
  });

  it('no_plan + owner → the Upgrade CTA linking to billing', () => {
    renderPanel({
      ...baseProps,
      eligibility: eligibility({ eligible: false, reason: 'no_plan', hasPaidAiPlan: false }),
      initialEvidence: null,
      canDecide: false,
    });
    const upgrade = screen.getByRole('link', { name: /upgrade/i });
    expect(upgrade.getAttribute('href')).toBe('/settings/organization/billing');
  });
});
