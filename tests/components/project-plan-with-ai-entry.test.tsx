// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import zhMessages from '@/messages/zh.json';
import type { ProjectDTO } from '@/lib/dto/projects';

// Component tests for the in-app "Plan a new project with AI" entry
// (MOTIR-1485 design → MOTIR-1486 code). The behaviour these lock in: the AI
// door is a form that SUBMITS startNewAiProjectAction — which mints a fresh
// DRAFT project and hands off to the /onboarding fork scoped to THAT new
// project (it does NOT plan into the currently-active project). The manual
// "Create project" door stays exactly as shipped (opens the modal).

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh }),
}));
// The switcher + modal import project Server Actions; stub them so these
// DB-free unit renders don't reach the server. startNewAiProjectAction is the
// AI door's form action — mocked so we can assert it is the wired handler.
const { startNewAiProjectAction } = vi.hoisted(() => ({
  startNewAiProjectAction: vi.fn(async () => undefined),
}));
vi.mock('@/app/(authed)/_project-actions', () => ({
  createProjectAction: vi.fn(async () => undefined),
  setActiveProjectAction: vi.fn(async () => undefined),
  archiveProjectAction: vi.fn(async () => undefined),
  startNewAiProjectAction,
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

/** The nearest ancestor <form> whose action is the AI server action. */
function aiDoorForm(button: HTMLElement): HTMLFormElement {
  const form = button.closest('form');
  expect(form).not.toBeNull();
  return form as HTMLFormElement;
}

afterEach(() => {
  cleanup();
  push.mockClear();
  refresh.mockClear();
  startNewAiProjectAction.mockClear();
});

describe('ProjectSwitcher — "Plan a new project with AI" door', () => {
  it('renders an accent AI submit-door (wired to startNewAiProjectAction) above the kept "Create project" row', () => {
    renderSwitcher();
    // Open the popover so its footer rows mount.
    fireEvent.click(screen.getByRole('button', { name: 'Switch project' }));

    const aiDoor = screen.getByRole('button', { name: /plan a new project with ai/i });
    // It is a form-submit door — NOT a plain link to the active project.
    expect(aiDoor.getAttribute('type')).toBe('submit');
    expect(aiDoorForm(aiDoor)).toBeTruthy();

    // The manual door is kept, unchanged (opens the modal, not a route).
    const createRow = screen.getByRole('button', { name: 'Create project' });
    expect(createRow.getAttribute('type')).toBe('button');

    // The AI door LEADS — it renders before the manual door in the DOM.
    expect(
      aiDoor.compareDocumentPosition(createRow) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('submitting the AI door invokes startNewAiProjectAction (mints a new project → /onboarding)', () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: 'Switch project' }));
    const aiDoor = screen.getByRole('button', { name: /plan a new project with ai/i });
    fireEvent.submit(aiDoorForm(aiDoor));
    expect(startNewAiProjectAction).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectsEmptyState — the two peer doors', () => {
  it('shows a primary AI submit-door and a secondary "Create project" door', () => {
    renderEmpty();

    const aiDoor = screen.getByRole('button', { name: /plan a new project with ai/i });
    expect(aiDoor.getAttribute('type')).toBe('submit');
    expect(aiDoorForm(aiDoor)).toBeTruthy();

    // Manual door stays a button that opens the shipped modal; it must NOT submit.
    const createBtn = screen.getByRole('button', { name: 'Create project' });
    expect(createBtn.getAttribute('type')).toBe('button');
  });

  it('opens the shipped create-project modal from the manual door (unchanged behaviour)', () => {
    renderEmpty();
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    // The shipped CreateProjectModal renders its Name field once open.
    expect(screen.getByLabelText('Project name')).toBeTruthy();
  });

  it('localizes the AI door label (zh catalog parity)', () => {
    renderEmpty(zhMessages as unknown as Record<string, unknown>);
    expect(screen.getByRole('button', { name: '用 AI 规划新项目' })).toBeTruthy();
  });
});
