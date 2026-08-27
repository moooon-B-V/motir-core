// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import {
  RequireTwoFactorCard,
  type RequireTwoFactorCardProps,
} from '@/app/(authed)/settings/organization/_components/RequireTwoFactorCard';

// RequireTwoFactorCard (Story MOTIR-1215 · Subtask MOTIR-3646) — the require-2FA
// control, built to `design/org-admin/security-policy.mock.html` panels 3–6, 8.
//
// The component is the story's one piece of REUSED UI: MOTIR-3647 mounts this
// same file at the workspace tier, at `/settings/workspace/security` and inside
// `WorkspaceFoldInSection`. So the suite drives each of the four states from
// PROPS ALONE — a state that needed a service, a cookie or a tier name from
// inside would not survive that second mounting — and asserts the import
// boundary that keeps it true.

const SOURCE = join(
  process.cwd(),
  'app/(authed)/settings/organization/_components/RequireTwoFactorCard.tsx',
);

function renderCard(over: Partial<RequireTwoFactorCardProps> = {}) {
  const props: RequireTwoFactorCardProps = {
    requiresTwoFactor: false,
    lockedBy: null,
    description: 'Everyone in this organization signs in with a second factor.',
    stateOnLabel: 'Required for every member of Acme',
    canManage: true,
    tierName: 'Acme',
    onSave: vi.fn(async () => ({ ok: true })),
    ...over,
  };
  return {
    props,
    ...render(
      <ToastProvider>
        <RequireTwoFactorCard {...props} />
      </ToastProvider>,
    ),
  };
}

afterEach(cleanup);

// ── The four states, from props alone ───────────────────────────────────────

describe('the four control states', () => {
  it('OFF — an operable switch, and the state named in TEXT', () => {
    renderCard({ requiresTwoFactor: false });
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.getAttribute('disabled')).toBeNull();
    // Named in text, never by colour alone.
    expect(screen.getByText('Not required')).toBeTruthy();
  });

  it('ON, set at this tier — still operable, because nothing is above it', () => {
    renderCard({ requiresTwoFactor: true });
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('disabled')).toBeNull();
    expect(screen.getByText('Required for every member of Acme')).toBeTruthy();
  });

  it('LOCKED ON by the organization — disabled, NOT absent, and it NAMES the org', () => {
    // The state the whole precedence model is visible in. A missing control
    // tells an admin nothing; a live one that silently does nothing is worse.
    renderCard({ requiresTwoFactor: false, lockedBy: 'Acme' });
    const sw = screen.getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('disabled')).not.toBeNull();
    expect(screen.getByText('Required by Acme')).toBeTruthy();
    expect(
      screen.getByText(/Acme requires two-factor authentication for every member/),
    ).toBeTruthy();
  });

  it('ON HERE **AND** ABOVE — a DIFFERENT note, so the two facts stay separable', () => {
    // Collapsing this into the panel above is how turning the organization's
    // policy off would silently drop a requirement a workspace admin chose.
    renderCard({ requiresTwoFactor: true, lockedBy: 'Acme' });
    expect(screen.getByRole('switch').getAttribute('disabled')).not.toBeNull();
    expect(screen.getByText('Required by Acme')).toBeTruthy();
    expect(
      screen.getByText(/This workspace requires two-factor authentication, and so does Acme/),
    ).toBeTruthy();
    // …and NOT the other tier's note.
    expect(screen.queryByText(/so it cannot be switched off here/)).toBeNull();
  });

  it('REFUSED — the refusal panel replaces the card, and names the tier', () => {
    renderCard({ canManage: false, tierName: 'Acme' });
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('You don’t have access to this')).toBeTruthy();
    expect(screen.getByText(/Only an owner or an admin of Acme/)).toBeTruthy();
  });
});

// ── The write is ABSOLUTE ───────────────────────────────────────────────────

describe('saving', () => {
  it('calls onSave with the DESIRED value, not a flip instruction', async () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    renderCard({ requiresTwoFactor: false, onSave });

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(true));
    expect(onSave.mock.calls[0]).toEqual([true]);
  });

  it('a re-render carrying the SAME server value is a no-op — no extra save, no move', async () => {
    // The UI half of the absolute setter's idempotence. (The service half — the
    // same value written twice returning the same DTO — is asserted in
    // `tests/twoFactorPolicy.test.ts`; a switch cannot be clicked to the value
    // it already holds, so the component's share of the rule is that a repeated
    // server value must not move it or fire a second write.)
    const onSave = vi.fn(async () => ({ ok: true }));
    const { rerender } = renderCard({ requiresTwoFactor: false, onSave });
    const sw = screen.getByRole('switch');

    fireEvent.click(sw);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(true));
    expect(sw.getAttribute('aria-checked')).toBe('true');

    onSave.mockClear();
    rerender(
      <ToastProvider>
        <RequireTwoFactorCard
          requiresTwoFactor
          lockedBy={null}
          description="d"
          stateOnLabel="Required for every member of Acme"
          canManage
          tierName="Acme"
          onSave={onSave}
        />
      </ToastProvider>,
    );
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a server value that CHANGED under us re-syncs the switch', async () => {
    // A second admin flipped it. The server value is the truth; the optimistic
    // one is only a bridge to it.
    const onSave = vi.fn(async () => ({ ok: true }));
    const { rerender } = renderCard({ requiresTwoFactor: false, onSave });
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');

    rerender(
      <ToastProvider>
        <RequireTwoFactorCard
          requiresTwoFactor
          lockedBy={null}
          description="d"
          stateOnLabel="Required for every member of Acme"
          canManage
          tierName="Acme"
          onSave={onSave}
        />
      </ToastProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'),
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it('a failed save REVERTS the optimistic flip', async () => {
    const onSave = vi.fn(async () => ({ ok: false, error: 'nope' }));
    renderCard({ requiresTwoFactor: false, onSave });
    const sw = screen.getByRole('switch');

    fireEvent.click(sw);
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('false'));
  });

  it('a locked switch cannot be saved at all', () => {
    const onSave = vi.fn(async () => ({ ok: true }));
    renderCard({ requiresTwoFactor: false, lockedBy: 'Acme', onSave });

    fireEvent.click(screen.getByRole('switch'));
    expect(onSave).not.toHaveBeenCalled();
  });
});

// ── The import boundary that keeps it reusable ──────────────────────────────

describe('⚠️ the component is tier-agnostic, and that is asserted rather than trusted', () => {
  const source = readFileSync(SOURCE, 'utf8');

  it("carries 'use client'", () => {
    expect(source.trimStart().startsWith("'use client'")).toBe(true);
  });

  it('imports NO service, and no server-only module', () => {
    // The import that would make it un-mountable at the workspace tier — and the
    // reason MOTIR-3647 can reuse this file instead of rewriting it.
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]!);
    expect(imports.filter((i) => i.includes('lib/services'))).toEqual([]);
    expect(imports.filter((i) => i.includes('lib/repositories'))).toEqual([]);
    expect(imports.filter((i) => i.includes('/actions'))).toEqual([]);
    expect(imports.filter((i) => i === 'next/headers')).toEqual([]);
  });

  it('never names a tier — no `organization`/`workspace` literal decides its render', () => {
    // Every tier-varying string arrives as a prop. A component that branched on
    // a tier internally would have to be rewritten one card later.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/from '[^']+'/g, '');
    expect(code).not.toMatch(/['"]organization['"]/);
    expect(code).not.toMatch(/['"]workspace['"]/);
  });

  it('has no toggle: the save prop takes a VALUE', () => {
    // Over the CODE, not the comments — the file's own header explains why there
    // is no `onToggle`, and a grep over the raw source is defeated by the
    // explanation. (It was, once: this assertion failed on its own docstring.)
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/onToggle/);
    expect(code).not.toMatch(/!requiresTwoFactor\)/);
    expect(source).toMatch(/onSave: \(next: boolean\)/);
  });
});
