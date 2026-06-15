// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ProjectDetailsCard } from '@/app/(authed)/settings/project/_components/ProjectDetailsCard';

// ProjectDetailsCard (Subtask 6.8.4) — the EDITABLE Details landing body. The
// ROLE SPLIT is the load-bearing contract (the 6.4.6 gating grammar the mock's
// panel-5 draws):
//   * admin → "Admin" pill + editable name Input + Change avatar / Change key
//     affordances + the save bar + Previous-keys release + the Archive danger
//     zone;
//   * non-admin member → "Read-only" pill, the VALUES visible but NO controls,
//     no save bar, no Previous keys, no danger zone.
// The avatar picker, change-key, release, and archive modals pull
// next/navigation + the Server Actions — stubbed so the unit render stays pure.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/app/(authed)/_project-actions', () => ({ archiveProjectAction: vi.fn() }));
vi.mock('@/app/(authed)/settings/project/actions', () => ({
  updateProjectDetailsAction: vi.fn(),
  changeProjectKeyAction: vi.fn(),
  releaseProjectKeyAction: vi.fn(),
}));

afterEach(cleanup);

const baseProps = {
  projectId: 'p-1',
  projectName: 'Motir',
  projectIdentifier: 'PROD',
  avatarIcon: 'rocket' as string | null,
  avatarColor: 'lavender' as string | null,
  previousKeys: [{ identifier: 'NIFR', retiredLabel: '4 June 2026' }],
};

function renderCard(props: { canManage: boolean; previousKeys?: typeof baseProps.previousKeys }) {
  return renderWithIntl(
    <ToastProvider>
      <ProjectDetailsCard {...baseProps} {...props} />
    </ToastProvider>,
  );
}

describe('ProjectDetailsCard (6.8.4 — editable)', () => {
  it('renders the editable surface for an admin: name Input, Change avatar / key, save bar, danger zone', () => {
    renderCard({ canManage: true });
    expect(screen.getByText('Admin')).toBeTruthy();
    expect(screen.queryByText('Read-only')).toBeNull();
    // Name is an editable input seeded with the current value.
    const nameInput = screen.getByLabelText('Name') as HTMLInputElement;
    expect(nameInput.value).toBe('Motir');
    // Key is a read-only value + a guarded change affordance (not a free input).
    expect(screen.getByText('PROD')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Change key/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change avatar' })).toBeTruthy();
    // The save bar + the re-homed danger zone.
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
    expect(screen.getByText('Danger zone')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
  });

  it('enables Save only once an edit makes the form dirty', () => {
    renderCard({ canManage: true });
    const save = screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Motir 2' } });
    expect(save.disabled).toBe(false);
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
  });

  it('lists previous keys with a Release control, and hides the row when there are none', () => {
    const { unmount } = renderCard({ canManage: true });
    expect(screen.getByText('Previous keys')).toBeTruthy();
    expect(screen.getByText('NIFR')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Release' })).toBeTruthy();
    unmount();
    renderCard({ canManage: true, previousKeys: [] });
    expect(screen.queryByText('Previous keys')).toBeNull();
  });

  it('shows the Read-only pill and HIDES every control for a non-admin member', () => {
    renderCard({ canManage: false });
    expect(screen.getByText('Read-only')).toBeTruthy();
    expect(screen.queryByText('Admin')).toBeNull();
    // Values are visible…
    expect(screen.getByText('Motir')).toBeTruthy();
    expect(screen.getByText('PROD')).toBeTruthy();
    // …but no editing affordances, save bar, previous keys, or danger zone.
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Change avatar' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Change key/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByText('Previous keys')).toBeNull();
    expect(screen.queryByText('Danger zone')).toBeNull();
  });

  // Regression — bug-card-header-loses-padding-when-body-overrides-p-0.
  it('admin header: the "Project details" title + Admin pill sit inside a padded wrapper, not flush against the card edge', () => {
    renderCard({ canManage: true });
    const title = screen.getAllByText('Project details')[0]!;
    // Walk up to find the nearest ancestor carrying horizontal card padding.
    let node: HTMLElement | null = title;
    let padded: HTMLElement | null = null;
    while (node) {
      if (node.className?.includes?.('px-(--spacing-card-padding)')) {
        padded = node;
        break;
      }
      node = node.parentElement;
    }
    expect(padded, 'header is wrapped in a horizontally-padded element').not.toBeNull();
    expect(padded!.className).toContain('pt-(--spacing-card-padding)');
    // The padded wrapper must contain BOTH the title and the Admin pill — i.e.
    // it's the CardHead wrapper, not some narrower ancestor.
    expect(padded!.textContent).toContain('Project details');
    expect(padded!.textContent).toContain('Admin');
  });
});
