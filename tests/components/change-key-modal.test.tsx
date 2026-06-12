// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { ChangeKeyModal } from '@/app/(authed)/settings/project/_components/ChangeKeyModal';

// ChangeKeyModal (Subtask 6.8.4) — the guarded change-key flow. Live STRICT
// format validation (`/^[A-Z0-9]{3,5}$/`), the "Available" + consequence copy
// when ready, and a single heading (the custom icon+title head — NOT doubled by
// a Modal `title` prop). The action is stubbed; server-collision mapping is the
// action-wiring test's surface.

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/(authed)/settings/project/actions', () => ({ changeProjectKeyAction: vi.fn() }));

afterEach(cleanup);

function renderModal() {
  return renderWithIntl(
    <ToastProvider>
      <ChangeKeyModal open onOpenChange={vi.fn()} currentKey="PROD" projectName="Motir" />
    </ToastProvider>,
  );
}

describe('ChangeKeyModal', () => {
  it('renders exactly one "Change project key" heading (no doubled Modal title)', () => {
    renderModal();
    expect(screen.getAllByText('Change project key')).toHaveLength(1);
  });

  it('disables Change key for a malformed key and shows the format error', () => {
    renderModal();
    const input = screen.getByLabelText('New key');
    fireEvent.change(input, { target: { value: 'N!' } });
    expect(screen.getByText(/is not a valid project key/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Change key' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('shows Available + the consequence and enables Change key for a valid new key', () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'NIF' } });
    expect(screen.getByText('Available')).toBeTruthy();
    expect(screen.getByText(/Every issue identifier becomes/)).toBeTruthy();
    expect(screen.getByText(/links keep working/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Change key' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('keeps Change key disabled when the new key equals the current key', () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('New key'), { target: { value: 'PROD' } });
    expect(screen.queryByText('Available')).toBeNull();
    expect((screen.getByRole('button', { name: 'Change key' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
