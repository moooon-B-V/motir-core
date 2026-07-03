// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import zhMessages from '@/messages/zh.json';
import type { ProjectDTO } from '@/lib/dto/projects';

// Component tests for the in-app "Plan a new project with AI" entry
// (MOTIR-1485 design → MOTIR-1486 code). The design decision this locks in:
// the AI door ROUTES to /onboarding (the shipped fork, MOTIR-1461/1462) — it
// does NOT pre-create a project and does NOT draw a second new-vs-existing
// chooser — while the manual "Create project" door stays exactly as shipped.

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));
// The switcher + modal import project Server Actions; stub them so these
// DB-free unit renders don't reach the server.
vi.mock('@/app/(authed)/_project-actions', () => ({
  createProjectAction: vi.fn(async () => undefined),
  setActiveProjectAction: vi.fn(async () => undefined),
  archiveProjectAction: vi.fn(async () => undefined),
}));

import { ProjectSwitcher } from '@/app/(authed)/_components/ProjectSwitcher';
import { ProjectsEmptyState } from '@/app/(authed)/_components/ProjectsEmptyState';

const ACME: ProjectDTO = {
  id: 'proj_acme',
  workspaceId: 'ws_1',
  name: 'Acme',
  identifier: 'ACME',
  avatarIcon: null,
  avatarColor: null,
  archivedAt: null,
} as unknown as ProjectDTO;

function renderSwitcher() {
  return renderWithIntl(
    <ToastProvider>
      <ProjectSwitcher projects={[ACME]} activeProjectId={ACME.id} />
    </ToastProvider>,
  );
}

function renderEmpty(messages?: Record<string, unknown>) {
  return renderWithIntl(
    <ToastProvider>
      <ProjectsEmptyState />
    </ToastProvider>,
    messages ? { messages } : undefined,
  );
}

afterEach(() => {
  cleanup();
  push.mockClear();
  refresh.mockClear();
});

describe('ProjectSwitcher — "Plan a new project with AI" door', () => {
  it('renders an accent AI row that links to /onboarding, above the kept "Create project" row', () => {
    renderSwitcher();
    // Open the popover so its footer rows mount.
    fireEvent.click(screen.getByRole('button', { name: 'Switch project' }));

    const aiDoor = screen.getByRole('link', { name: /plan a new project with ai/i });
    expect(aiDoor.getAttribute('href')).toBe('/onboarding');

    // The manual door is kept, unchanged (opens the modal, not a route).
    const createRow = screen.getByRole('button', { name: 'Create project' });
    expect(createRow.getAttribute('href')).toBeNull();

    // The AI door LEADS — it renders before the manual door in the DOM.
    expect(
      aiDoor.compareDocumentPosition(createRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('ProjectsEmptyState — the two peer doors', () => {
  it('shows a primary AI door linking to /onboarding and a secondary "Create project" door', () => {
    renderEmpty();

    const aiDoor = screen.getByRole('link', { name: /plan a new project with ai/i });
    expect(aiDoor.getAttribute('href')).toBe('/onboarding');

    // Manual door stays a button (opens the shipped modal); it must NOT route.
    const createBtn = screen.getByRole('button', { name: 'Create project' });
    expect(createBtn.getAttribute('href')).toBeNull();
  });

  it('opens the shipped create-project modal from the manual door (unchanged behaviour)', () => {
    renderEmpty();
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    // The shipped CreateProjectModal renders its Name field once open.
    expect(screen.getByLabelText('Project name')).toBeTruthy();
  });

  it('localizes the AI door label (zh catalog parity)', () => {
    renderEmpty(zhMessages as unknown as Record<string, unknown>);
    const aiDoor = screen.getByRole('link', { name: '用 AI 规划新项目' });
    expect(aiDoor.getAttribute('href')).toBe('/onboarding');
  });
});
