// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { GithubInstallationDTO } from '@/lib/dto/github';

// THE GITLAB CARD SHOWS A PLAIN MEMBER ONLY WHAT THEY MAY DO (bug MOTIR-6320).
//
// The page computed `canDisconnect` for the GitHub arm and never passed it to
// `<GitlabConnection>`, so every member was offered Disconnect GitLab, the
// project picker's Connect and a live sync switch per project. The card now takes
// `canManage` and draws the permission-gated UI rule's treatments
// (`design/projects/design-notes.md`, Amendment 2026-08-08): the entry points
// HIDDEN, the in-place switch DISABLED beside the sentence that says who can.
//
// ⚠️ Since MOTIR-6312 the PAGE refuses a plain org member before this card is
// reached (`tests/settings/organizationGitPage.test.tsx` holds that). This file
// holds the card's own contract, which is what keeps it honest wherever it is
// mounted — and what the write-control guard now reads it for.

const getConnectionForWorkspace = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/gitlabConnectionService', () => ({
  gitlabConnectionService: { getConnectionForWorkspace },
}));
vi.mock('@/app/(authed)/settings/organization/git/actions', () => ({
  disconnectGitlabAction: vi.fn(),
  disconnectGitlabProjectAction: vi.fn(),
  connectGitlabProjectAction: vi.fn(),
  listGitlabProjectsAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next-intl/server', async () => {
  const { createTranslator } = await import('next-intl');
  const messages = (await import('@/messages/en.json')).default;
  return {
    getLocale: async () => 'en',
    getTranslations: async (namespace: string) =>
      createTranslator({ locale: 'en', messages, namespace } as never),
  };
});

import { GitlabConnection } from '@/app/(authed)/settings/organization/git/_components/GitlabConnection';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ADMIN_ONLY = 'Only owners and admins of Acme can connect or disconnect a git host.';

const CONNECTION = {
  accountLogin: 'octocat',
  repos: [{ id: 'r1', repoId: '12', owner: 'moooon', name: 'motir-core', defaultBranch: 'main' }],
} as unknown as GithubInstallationDTO;

/** `GitlabConnection` resolves to an async panel element; resolve both levels. */
async function renderCard(canManage: boolean) {
  const outer = (await GitlabConnection({
    userId: 'u1',
    workspaceId: 'ws1',
    canManage,
    organizationName: 'Acme',
  })) as ReactElement<Record<string, unknown>>;
  const panel = outer.type as (p: Record<string, unknown>) => Promise<ReactElement>;
  return renderWithIntl(await panel(outer.props));
}

describe('connected — a plain member', () => {
  it('is offered no Disconnect and no Connect, and is told who can', async () => {
    getConnectionForWorkspace.mockResolvedValue(CONNECTION);
    await renderCard(false);

    expect(screen.queryByRole('button', { name: /disconnect/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /connect a project/i })).toBeNull();
    expect(screen.getByText(ADMIN_ONLY)).toBeTruthy();
  });

  it('sees the project still syncing, with its switch DISABLED', async () => {
    getConnectionForWorkspace.mockResolvedValue(CONNECTION);
    await renderCard(false);

    const toggle = screen.getByRole('switch');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('connected — an Owner or Admin', () => {
  it('keeps Disconnect, the picker and a live switch, with no refusal sentence', async () => {
    getConnectionForWorkspace.mockResolvedValue(CONNECTION);
    const { container } = await renderCard(true);

    expect(screen.getByRole('button', { name: /disconnect/i })).toBeTruthy();
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false);
    expect(container.textContent).not.toContain(ADMIN_ONLY);
    expect(screen.getByRole('button', { name: /connect a project/i })).toBeTruthy();
  });
});

describe('not connected', () => {
  it('a plain member gets no Connect GitLab link — the sentence stands in its place', async () => {
    getConnectionForWorkspace.mockResolvedValue(null);
    const { container } = await renderCard(false);

    expect(container.querySelector('a[href="/api/gitlab/oauth/start"]')).toBeNull();
    expect(screen.getByText(ADMIN_ONLY)).toBeTruthy();
  });

  it('an Owner or Admin gets the Connect GitLab link', async () => {
    getConnectionForWorkspace.mockResolvedValue(null);
    const { container } = await renderCard(true);

    expect(container.querySelector('a[href="/api/gitlab/oauth/start"]')).not.toBeNull();
    expect(container.textContent).not.toContain(ADMIN_ONLY);
  });
});
