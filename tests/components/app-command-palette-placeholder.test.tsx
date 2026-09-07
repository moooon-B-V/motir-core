// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import type { ProjectDTO } from '@/lib/dto/projects';

// Subtask MOTIR-2552 — the palette input's placeholder is CATALOG copy, not the
// primitive's default.
//
// `components/ui/CommandPalette.tsx` declares `placeholder = 'Type a command or
// search…'` as a prop default, and for a long time the app never passed the prop
// — so the ⌘K modal rendered a hardcoded English literal that no locale could
// reach. The regression is silent in both directions: dropping the prop restores
// a plausible-looking English placeholder, and the primitive's own suite cannot
// see it because the primitive is behaving exactly as documented. So the
// assertion has to live at the APP composition, and it has to name the string.

const { navSearchParams } = vi.hoisted(() => ({ navSearchParams: new URLSearchParams() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/dashboard',
  // MOTIR-4730 — the planning door in this tree reads the address, so a
  // partial navigation mock is a crash rather than a gap.
  useSearchParams: () => navSearchParams,
}));
vi.mock('@/app/(authed)/_project-actions', () => ({
  setActiveProjectAction: vi.fn(async () => undefined),
}));
vi.mock('@/app/(authed)/_actions', () => ({ switchWorkspaceAction: vi.fn(async () => undefined) }));
vi.mock('@/lib/auth/client', () => ({ signOut: vi.fn(async () => undefined) }));
vi.mock('@/app/(authed)/_components/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({ open: true, setOpen: vi.fn() }),
}));
vi.mock('@/app/(authed)/_components/CreateIssueProvider', () => ({
  useCreateIssue: () => ({ openCreateIssue: vi.fn(), canCreate: false }),
}));
vi.mock('@/app/(authed)/_components/OnboardingResumeProvider', () => ({
  useOnboardingResume: () => false,
}));
vi.mock('@/lib/contexts/theme-context', () => ({
  useTheme: () => ({ pattern: 'light', setPattern: vi.fn() }),
}));

import { AppCommandPalette } from '@/app/(authed)/_components/AppCommandPalette';

const PROJECT = {
  id: 'proj_motir',
  workspaceId: 'ws_1',
  name: 'Motir',
  identifier: 'MOTIR',
  key: 'MOTIR',
  archivedAt: null,
} as unknown as ProjectDTO;

function renderPalette(messages?: Record<string, unknown>) {
  return renderWithIntl(
    <AppCommandPalette
      workspaces={[]}
      activeWorkspaceId="ws_1"
      projects={[PROJECT]}
      activeProjectId={PROJECT.id}
      hasProject
    />,
    messages ? { messages, locale: 'zh' } : undefined,
  );
}

/** The palette's single text input, found by the primitive's own stable name. */
const input = () => screen.getByRole('textbox', { name: 'Search commands' });

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the ⌘K palette input placeholder (MOTIR-2552)', () => {
  it('renders the en catalog string, not the primitive default', () => {
    renderPalette();

    expect(input().getAttribute('placeholder')).toBe('Search a shortcut');
  });

  it('renders the zh twin — the string is translatable at all only because the prop is passed', () => {
    renderPalette(zhMessages as unknown as Record<string, unknown>);

    expect(input().getAttribute('placeholder')).toBe('搜索快捷键');
  });

  it('never falls back to the primitive default in either locale', () => {
    renderPalette();
    expect(screen.queryByPlaceholderText('Type a command or search…')).toBeNull();
    cleanup();

    renderPalette(zhMessages as unknown as Record<string, unknown>);
    expect(screen.queryByPlaceholderText('Type a command or search…')).toBeNull();
  });
});
