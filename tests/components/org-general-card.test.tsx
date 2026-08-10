// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { OrgGeneralCard } from '@/app/(authed)/settings/organization/_components/OrgGeneralCard';

// The org-settings General card after MOTIR-2548 removed the Organization URL
// row (`docs/decisions/organization-url.md`).
//
// This replaces `OrgGeneralCard-url-field.test.tsx`, whose entire subject was
// that field. It asserts the ABSENCE deliberately rather than only asserting
// that the name field is present: a card that rendered the URL row AND the name
// row would satisfy the weaker check, and the whole point of the change is that
// the product no longer shows an address it cannot resolve.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

afterEach(cleanup);

function renderCard() {
  return render(
    <ToastProvider>
      <OrgGeneralCard
        orgId="org1"
        initialName="moooon"
        role="owner"
        workspaceCount={3}
        memberCount={14}
      />
    </ToastProvider>,
  );
}

describe('OrgGeneralCard', () => {
  it('renders the organization NAME as its only editable field', () => {
    renderCard();
    const name = screen.getByLabelText('Organization name') as HTMLInputElement;
    expect(name.value).toBe('moooon');
    expect(name.readOnly).toBe(false);
  });

  it('renders NO Organization URL field, by label or by affix', () => {
    renderCard();
    // The label is gone…
    expect(screen.queryByLabelText('Organization URL')).toBeNull();
    expect(screen.queryByText('Organization URL')).toBeNull();
    // …and so is the `motir.co/` affix that made it read as an address. Checking
    // both matters: the row could have been "kept but unlabelled", which would
    // still show a URL nobody can follow.
    expect(screen.queryByText('motir.co/')).toBeNull();
  });

  it('still shows the workspace + member summary and the Save control', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /Save/ })).toBeTruthy();
    // The footer summary survives the removal — the card is a coherent layout,
    // not a gap where a row used to be.
    expect(screen.getByText(/3/)).toBeTruthy();
    expect(screen.getByText(/14/)).toBeTruthy();
  });
});
