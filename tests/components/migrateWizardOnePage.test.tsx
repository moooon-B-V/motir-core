// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { MigrateOnboardingDto } from '@/lib/dto/migrateOnboarding';

// MOTIR-8254 — the migrate wizard on the vibe layout, as one page to finish
// onboarding (`design/onboarding-migrate/` § 2026-10-12, Revisions 1–6). These
// drive the island's own decisions: which first screen it paints (Revisions 3
// and 4), how Connect notices a connection (Revision 1), and that Decision and
// the questions step stay on this page (Revision 6). The routes are faked at
// `fetch`; what they do is `tests/migrate-onboarding/`'s to prove.

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/onboarding/migrate',
}));
const setActiveProjectAction = vi.fn(async (_id: string) => {});
vi.mock('@/app/(authed)/_project-actions', () => ({
  setActiveProjectAction: (id: string) => setActiveProjectAction(id),
}));

import { MigrateWizard } from '@/app/(onboarding)/onboarding/migrate/_components/MigrateWizard';

function makeRun(overrides: Partial<MigrateOnboardingDto> = {}): MigrateOnboardingDto {
  return {
    id: 'run-1',
    projectId: 'p1',
    kind: 'migrate',
    step: 'connect',
    status: 'active',
    keptSteps: [],
    connectedRepoRef: null,
    codeGraphReady: false,
    conventionApprovedAt: null,
    discoveryJobId: null,
    generateJobId: null,
    importSkipped: false,
    importCompleted: false,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const PROJECTS = [
  { id: 'p1', name: 'Quiet Harbor', identifier: 'QH' },
  { id: 'p2', name: 'Ledger Lane', identifier: 'LL' },
];

describe('the first screen', () => {
  it('with one project, starts the run on arrival and opens on Connect under the full hero', async () => {
    const calls = fakeFetch((url) => {
      if (url === '/api/onboarding/migrate') return json(makeRun());
      if (url.endsWith('/index-status'))
        return json({ repos: [], indexedCount: 0, total: 0, hasRunning: false, allIndexed: false });
      return json({}, 404);
    });
    const { container } = renderWithIntl(
      <MigrateWizard
        initialRun={null}
        projectName="Quiet Harbor"
        userInitial="Y"
        projects={[PROJECTS[0]!]}
        activeProjectId="p1"
        autoStart
      />,
    );
    // No Start panel is ever painted: Connect's Checking line shows at once.
    expect(screen.queryByRole('group', { name: /Which project/ })).toBeNull();
    expect(screen.getByText('Checking for connected repositories…')).toBeTruthy();
    expect(await screen.findByText('No repositories connected yet')).toBeTruthy();
    expect(calls.mock.calls.some(([u]) => String(u) === '/api/onboarding/migrate')).toBe(true);
    expect(
      container.querySelector('[data-onboarding-hero]')?.getAttribute('data-onboarding-hero'),
    ).toBe('full');
  });

  it('with two projects, offers the choice with the open one picked, and switches before it starts', async () => {
    fakeFetch((url) => {
      if (url === '/api/onboarding/migrate') return json(makeRun({ projectId: 'p2' }));
      if (url.endsWith('/index-status'))
        return json({ repos: [], indexedCount: 0, total: 0, hasRunning: false, allIndexed: false });
      return json({}, 404);
    });
    renderWithIntl(
      <MigrateWizard
        initialRun={null}
        projectName="Quiet Harbor"
        userInitial="Y"
        projects={PROJECTS}
        activeProjectId="p1"
      />,
    );
    const open = screen.getByRole('radio', { name: /Quiet Harbor/ }) as HTMLInputElement;
    expect(open.checked).toBe(true);
    expect(screen.getByText('Open now')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Ledger Lane/ }));
    const cta = screen.getByRole('button', { name: 'Start with Ledger Lane' });
    await act(async () => {
      fireEvent.click(cta);
    });
    expect(setActiveProjectAction).toHaveBeenCalledWith('p2');
    expect(await screen.findByText('No repositories connected yet')).toBeTruthy();
  });
});

describe('Connect notices the connection by itself (Revision 1)', () => {
  it('shows the connected repositories and Continue, with no "I have connected" button', async () => {
    fakeFetch((url) => {
      if (url.endsWith('/index-status'))
        return json({
          repos: [{ repoRef: 'acme/web', provider: 'github', status: 'queued' }],
          indexedCount: 0,
          total: 1,
          hasRunning: true,
          allIndexed: false,
        });
      return json({}, 404);
    });
    renderWithIntl(
      <MigrateWizard initialRun={makeRun()} projectName="Quiet Harbor" userInitial="Y" />,
    );
    expect(await screen.findByText('1 repository is connected')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Connected repositories' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.queryByText("I've connected my repos")).toBeNull();
  });

  it('opens GitHub settings in a new tab and waits for it', async () => {
    fakeFetch((url) =>
      url.endsWith('/index-status')
        ? json({ repos: [], indexedCount: 0, total: 0, hasRunning: false, allIndexed: false })
        : json({}, 404),
    );
    renderWithIntl(
      <MigrateWizard initialRun={makeRun()} projectName="Quiet Harbor" userInitial="Y" />,
    );
    const link = await screen.findByRole('link', { name: /Connect GitHub/ });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('href')).toBe('/settings/organization/git');
    fireEvent.click(link);
    expect(screen.getByText('Waiting for GitHub')).toBeTruthy();
  });
});

describe('one page to finish onboarding (Revision 6)', () => {
  it('Plan my project now advances in place instead of leaving for the discovery canvas', async () => {
    fakeFetch((url, init) => {
      if (url.endsWith('/advance') && init?.method === 'POST')
        return json(makeRun({ step: 'discovery' }));
      // the questions step asks again (409 until a doc is drafted) and re-reads
      if (url === '/api/onboarding/migrate/run-1') return json(makeRun({ step: 'discovery' }));
      return json({}, 409);
    });
    renderWithIntl(
      <MigrateWizard
        initialRun={makeRun({ step: 'audit_convention' })}
        projectName="Quiet Harbor"
        userInitial="Y"
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Plan my project now' }));
    });
    expect(await screen.findByRole('heading', { name: 'A few questions' })).toBeTruthy();
    expect(push).not.toHaveBeenCalledWith('/onboarding/discovery');
  });

  it('a run resumed at the questions step offers Continue planning, which resumes in place', async () => {
    fakeFetch(() => json({}, 409));
    renderWithIntl(
      <MigrateWizard
        initialRun={makeRun({ step: 'discovery' })}
        projectName="Quiet Harbor"
        userInitial="Y"
      />,
    );
    const resume = screen.getByRole('button', { name: 'Continue planning' });
    expect(screen.queryByRole('link', { name: 'Continue planning' })).toBeNull();
    await act(async () => {
      fireEvent.click(resume);
    });
    expect(screen.getByRole('heading', { name: 'A few questions' })).toBeTruthy();
  });

  it('when the plan is drafted, says how many items it holds and offers Review your plan', async () => {
    fakeFetch((url) =>
      url.endsWith('/plan')
        ? json({ planId: 'plan-1', status: 'planned', itemCount: 24 })
        : json({}, 404),
    );
    renderWithIntl(
      <MigrateWizard
        initialRun={makeRun({ step: 'review', generateJobId: 'g1' })}
        projectName="Quiet Harbor"
        userInitial="Y"
      />,
    );
    expect(await screen.findByText(/24 items are drafted for Quiet Harbor/)).toBeTruthy();
    expect(screen.getByText('Your first plan is ready')).toBeTruthy();
  });
});
