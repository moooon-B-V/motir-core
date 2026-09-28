// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';

// THE VISITOR'S CONSENT CARD (Story MOTIR-6170 · MOTIR-6669; design MOTIR-6641
// panels 2–3). What these protect is the consent itself, not pixels: the screen
// says WHO sees WHAT, shows the reader their own identity, never treats a failed
// write as agreement, and is not drawn as an error.

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), prefetch: vi.fn() }),
}));

const recordAction = vi.fn();
vi.mock('@/app/(auth)/p/[identifier]/consent/_actions', () => ({
  recordVisitorConsentAction: (identifier: string) => recordAction(identifier),
}));

import { VisitorConsentCard } from '@/app/(auth)/p/[identifier]/consent/_components/VisitorConsentCard';

function card(overrides: Partial<Parameters<typeof VisitorConsentCard>[0]> = {}) {
  return renderWithIntl(
    <VisitorConsentCard
      identifier="MOTIR"
      projectName="Motir"
      workspaceName="moooon"
      reader={{ name: 'Riya Sen', email: 'riya.sen@example.com' }}
      destination="/p/MOTIR/board"
      goBackHref="/"
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('idle', () => {
  it('names the project, the workspace, who sees the details and what they see', () => {
    card();
    expect(screen.getByRole('heading', { name: 'Before you watch Motir' })).toBeTruthy();
    expect(screen.getByText('Public project · moooon')).toBeTruthy();
    const body = document.body.textContent ?? '';
    expect(body).toContain('is built in public by');
    expect(body).toContain('name and email');
    expect(body).toContain('this project’s workspace Managers');
    expect(body).toContain('We only ask once for this project.');
    expect(screen.getByText('Riya Sen')).toBeTruthy();
    expect(screen.getByText('riya.sen@example.com · your first and latest visit')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /go back/i })).toBeTruthy();
    expect(
      screen.getByText(
        'Going back shares nothing. You’ll be asked again the next time you open Motir.',
      ),
    ).toBeTruthy();
  });

  it('is not an error state — no alert anywhere until a write fails', () => {
    card();
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the neutral label for a reader with no name, and still their own email', () => {
    card({ reader: { name: '  ', email: 'anon@example.com' } });
    expect(screen.getByText('Project member')).toBeTruthy();
    expect(screen.getByText('anon@example.com · your first and latest visit')).toBeTruthy();
  });
});

describe('Continue', () => {
  it('shows Continuing… with both buttons inert while it saves, then goes to the destination', async () => {
    let resolve!: (value: { ok: true }) => void;
    recordAction.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    card();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    expect(screen.getByText('Continuing…')).toBeTruthy();
    expect((screen.getByRole('button', { name: /go back/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => {
      resolve({ ok: true });
    });
    expect(recordAction).toHaveBeenCalledWith('MOTIR');
    expect(push).toHaveBeenCalledWith('/p/MOTIR/board');
  });

  it('a failed save says so, goes nowhere, and lets the reader try again', async () => {
    recordAction.mockRejectedValueOnce(new Error('store down'));
    card();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    expect(screen.getByText('We couldn’t save that. Try again.')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('a member is sent on; a project gone private is re-read', async () => {
    recordAction.mockResolvedValueOnce({ ok: false, reason: 'member' });
    card();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    expect(push).toHaveBeenCalledWith('/p/MOTIR/board');

    cleanup();
    recordAction.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    card();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });
    expect(refresh).toHaveBeenCalled();
  });
});

describe('Go back', () => {
  it('records nothing', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { assign }, configurable: true });
    card({ goBackHref: 'https://motir.co/p/MOTIR' });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /go back/i }));
    });
    expect(recordAction).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('https://motir.co/p/MOTIR');
  });
});
