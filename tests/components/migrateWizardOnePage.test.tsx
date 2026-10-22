// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { enMessages, renderWithIntl } from '../helpers/renderWithIntl';
import zhMessages from '@/messages/zh.json';
import type {
  MigrateConnectOutcome,
  MigrateConnectStateDto,
  MigrateOnboardingDto,
} from '@/lib/dto/migrateOnboarding';

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
    latestImport: null,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...overrides,
  };
}

/** The connect step's own read (MOTIR-8472); the step's states are
 *  `onboarding-connect-step.test.tsx`'s to prove. */
function connectState(
  outcome: MigrateConnectOutcome,
  repoRefs: string[] = [],
): MigrateConnectStateDto {
  return {
    organizationId: 'org-1',
    installation: { bound: repoRefs.length > 0, accounts: [] },
    repositories: repoRefs.map((repoRef) => ({
      provider: 'github',
      repoRef,
      defaultBranch: 'main',
    })),
    outcome,
    snapshot: 'mcs1.cnVuLTE',
  };
}
const NOT_CONNECTED_TITLE = enMessages.onboardingMigrate.connect.missingTitle;

// The connect step also reads the accounts the Motir App is already installed on
// (MOTIR-8245). These cases are about the step with NONE, so every fake answers
// that read with an empty list, the world in which the pre-flight leads; the
// list itself is `onboarding-existing-accounts.test.tsx`'s to prove.
const ACCOUNTS_READ = /\/api\/organizations\/[^/]+\/github\/accounts$/;

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    ACCOUNTS_READ.test(String(input))
      ? json({ state: 'ok', accounts: [] })
      : handler(String(input), init),
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
      if (url.endsWith('/connect-state')) return json(connectState('not_started'));
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
    expect(await screen.findByText(NOT_CONNECTED_TITLE)).toBeTruthy();
    expect(calls.mock.calls.some(([u]) => String(u) === '/api/onboarding/migrate')).toBe(true);
    expect(
      container.querySelector('[data-onboarding-hero]')?.getAttribute('data-onboarding-hero'),
    ).toBe('full');
  });

  it('with two projects, offers the choice with the open one picked, and switches before it starts', async () => {
    fakeFetch((url) => {
      if (url === '/api/onboarding/migrate') return json(makeRun({ projectId: 'p2' }));
      if (url.endsWith('/connect-state')) return json(connectState('not_started'));
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
    expect(await screen.findByText(NOT_CONNECTED_TITLE)).toBeTruthy();
  });
});

describe('the bar', () => {
  it('carries the language control after Save & exit, before the initial (MOTIR-8286)', () => {
    fakeFetch(() => json({}, 404));
    const { container } = renderWithIntl(
      <MigrateWizard initialRun={makeRun()} projectName="Quiet Harbor" userInitial="Y" />,
    );
    const bar = container.querySelector('[data-onboarding-brand-bar]') as HTMLElement;
    const control = screen.getByRole('combobox', { name: /Language/ });
    expect(bar.contains(control)).toBe(true);
    const exit = screen.getByRole('link', { name: 'Save & exit' });
    expect(exit.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('colours "Start from an idea instead" in the accent ink, tinting on hover (MOTIR-8935)', () => {
    fakeFetch(() => json({}, 404));
    renderWithIntl(
      <MigrateWizard initialRun={makeRun()} projectName="Quiet Harbor" userInitial="Y" />,
    );
    const back = screen.getByRole('link', { name: 'Start from an idea instead' });
    expect(back.getAttribute('href')).toBe('/onboarding/discovery');
    const classes = back.className.split(/\s+/);
    // The design's colour (design-notes.md § "2026-10-21", Change 3) replaces
    // the plain secondary ink, border and the bar's neutral hover.
    expect(classes).toEqual(
      expect.arrayContaining([
        'text-(--el-accent-on-surface)',
        'border-(--el-accent-on-surface)',
        'hover:bg-(--el-tint-sky)',
        'focus-visible:ring-(--focus-ring-color)',
      ]),
    );
    expect(classes).not.toContain('text-(--el-text)');
    expect(classes).not.toContain('border-(--el-button-border)');
    expect(classes).not.toContain('hover:bg-(--el-page-bg)');
    // Save & exit stays a plain ghost: the bar has one coloured control.
    expect(screen.getByRole('link', { name: 'Save & exit' }).className).not.toContain(
      '--el-accent-on-surface',
    );
  });
});

describe('Connect notices the connection by itself (Revision 1)', () => {
  it('shows the connected repositories and Continue, with no "I have connected" button', async () => {
    fakeFetch((url) => {
      if (url.endsWith('/connect-state')) return json(connectState('connected', ['acme/web']));
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

  it('starts the GitHub install from this step in a new tab, and waits for it (MOTIR-8475)', async () => {
    fakeFetch((url) =>
      url.endsWith('/connect-state') ? json(connectState('not_started')) : json({}, 404),
    );
    const open = vi.spyOn(window, 'open').mockReturnValue({ opener: null } as unknown as Window);
    renderWithIntl(
      <MigrateWizard initialRun={makeRun()} projectName="Quiet Harbor" userInitial="Y" />,
    );
    const start = await screen.findByRole('button', { name: /Connect GitHub/ });
    fireEvent.click(start);
    expect(open).toHaveBeenCalledWith('/api/github/install/start', '_blank');
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(screen.getByText('Waiting for GitHub')).toBeTruthy();
    open.mockRestore();
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

describe('the indexing indicator in the bar (MOTIR-8771)', () => {
  const indexing = {
    repos: [{ provider: 'github', repoRef: 'acme/widgets', status: 'indexing' }],
    indexedCount: 0,
    failedCount: 0,
    total: 1,
    hasRunning: true,
    allIndexed: false,
  };

  it('shows on the import step from the one index read, and opening it keeps the step', async () => {
    fakeFetch((url) => {
      if (url.endsWith('/index-status')) return json(indexing);
      return json({}, 404);
    });
    renderWithIntl(
      <MigrateWizard
        initialRun={makeRun({ step: 'import', connectedRepoRef: 'acme/widgets' })}
        projectName="Quiet Harbor"
        userInitial="Y"
      />,
    );
    const chip = await screen.findByTestId('migrate-index-indicator');
    expect(chip.textContent).toContain('Indexing widgets');
    const current = () => document.querySelector('[aria-current="step"]')?.textContent ?? '(none)';
    const before = current();
    fireEvent.click(chip);
    expect(await screen.findByTestId('migrate-index-detail')).toBeTruthy();
    expect(current()).toBe(before);
    expect(push).not.toHaveBeenCalled();
  });

  it.each(['connect', 'index'] as const)('is not in the bar on %s', async (step) => {
    fakeFetch((url) => {
      if (url.endsWith('/index-status')) return json(indexing);
      if (url.endsWith('/connect-state')) return json(connectState('not_started'));
      return json({}, 404);
    });
    renderWithIntl(
      <MigrateWizard
        initialRun={makeRun({ step, connectedRepoRef: 'acme/widgets' })}
        projectName="Quiet Harbor"
        userInitial="Y"
      />,
    );
    await act(async () => {});
    expect(screen.queryByTestId('migrate-index-indicator')).toBeNull();
  });
});

describe('the Import step ends onboarding with Enter Motir (MOTIR-8772)', () => {
  const indexStatus = (status: 'queued' | 'indexing' | 'indexed' | 'failed') => ({
    repos: [{ provider: 'github', repoRef: 'acme/widgets', status }],
    indexedCount: status === 'indexed' ? 1 : 0,
    failedCount: status === 'failed' ? 1 : 0,
    total: 1,
    hasRunning: status === 'indexing',
    allIndexed: status === 'indexed',
  });
  const importer = {
    project: { id: 'p1', name: 'Quiet Harbor' },
    statuses: [],
    connected: {
      jira: { connected: false },
      linear: { connected: false },
      github: { connected: false },
      plane: { connected: false },
    },
    existingImportId: null,
  };
  const runningImport = { source: 'jira' as const, status: 'running' as const, processedCount: 40 };

  it.each(['indexing', 'failed'] as const)(
    'Enter Motir is enabled with the index %s, posts to enter and goes to the project',
    async (state) => {
      const calls = fakeFetch((url, init) => {
        if (url.endsWith('/index-status')) return json(indexStatus(state));
        if (url.endsWith('/enter') && init?.method === 'POST')
          return json(makeRun({ step: 'done', status: 'completed' }));
        return json({}, 404);
      });
      renderWithIntl(
        <MigrateWizard
          initialRun={makeRun({ step: 'import', connectedRepoRef: 'acme/widgets' })}
          projectName="Quiet Harbor"
          userInitial="Y"
        />,
      );
      await screen.findByTestId('migrate-index-indicator');
      expect(screen.queryByRole('button', { name: 'Skip import' })).toBeNull();
      const enter = screen.getByRole('button', { name: 'Enter Motir' }) as HTMLButtonElement;
      expect(enter.disabled).toBe(false);
      expect(screen.getByText('Indexing and any import keep going after you enter.')).toBeTruthy();
      await act(async () => {
        fireEvent.click(enter);
      });
      expect(
        calls.mock.calls.some(
          ([u, init]) =>
            String(u) === '/api/onboarding/migrate/run-1/enter' && init?.method === 'POST',
        ),
      ).toBe(true);
      expect(push).toHaveBeenCalledWith('/roadmap');
    },
  );

  it('shows a started import running in the background with the sources inert', async () => {
    fakeFetch((url) => {
      if (url.endsWith('/index-status')) return json(indexStatus('indexing'));
      return json({}, 404);
    });
    renderWithIntl(
      <MigrateWizard
        initialRun={makeRun({
          step: 'import',
          connectedRepoRef: 'acme/widgets',
          latestImport: runningImport,
        })}
        projectName="Quiet Harbor"
        userInitial="Y"
        importer={importer}
      />,
    );
    await act(async () => {});
    const line = screen.getByTestId('migrate-import-running');
    expect(line.getAttribute('role')).toBe('status');
    expect(line.textContent).toContain('Importing from Jira · 40 work items so far');
    expect(line.textContent).toContain("You don't have to wait for it.");
    const sources = screen.getByTestId('migrate-import-sources');
    expect(sources.getAttribute('aria-disabled')).toBe('true');
    expect(sources.hasAttribute('inert')).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Enter Motir' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('with no import running, the sources are live and there is no status line', async () => {
    fakeFetch((url) =>
      url.endsWith('/index-status') ? json(indexStatus('indexed')) : json({}, 404),
    );
    renderWithIntl(
      <MigrateWizard
        initialRun={makeRun({
          step: 'import',
          connectedRepoRef: 'acme/widgets',
          latestImport: { source: 'jira', status: 'succeeded', processedCount: 120 },
        })}
        projectName="Quiet Harbor"
        userInitial="Y"
        importer={importer}
      />,
    );
    await act(async () => {});
    expect(screen.queryByTestId('migrate-import-running')).toBeNull();
    const sources = screen.getByTestId('migrate-import-sources');
    expect(sources.hasAttribute('aria-disabled')).toBe(false);
    expect(sources.hasAttribute('inert')).toBe(false);
  });

  it('the rail has no questions step, and names both background jobs', async () => {
    fakeFetch((url) =>
      url.endsWith('/index-status') ? json(indexStatus('indexing')) : json({}, 404),
    );
    renderWithIntl(
      <MigrateWizard
        initialRun={makeRun({
          step: 'import',
          connectedRepoRef: 'acme/widgets',
          latestImport: runningImport,
        })}
        projectName="Quiet Harbor"
        userInitial="Y"
      />,
    );
    await screen.findByText('In the background · In progress');
    const rail = screen.getByRole('navigation', { name: 'Your migration' });
    expect(rail.textContent).not.toContain('A few questions');
    expect(rail.textContent).not.toContain('Your direction');
    expect(rail.textContent).toContain(
      'Indexing and importing run in the background. Enter Motir whenever you like.',
    );
    expect(rail.textContent).toContain('In the background · 40 so far');
    // A background job is never the current step.
    expect(rail.querySelectorAll('[aria-current="step"]')).toHaveLength(0);
  });

  it('the Index step does not wait: Next opens while the index is still queued', async () => {
    fakeFetch((url) =>
      url.endsWith('/index-status') ? json(indexStatus('queued')) : json({}, 404),
    );
    renderWithIntl(
      <MigrateWizard
        initialRun={makeRun({ step: 'index', connectedRepoRef: 'acme/widgets' })}
        projectName="Quiet Harbor"
        userInitial="Y"
      />,
    );
    const next = (await screen.findByRole('button', {
      name: /Next: import your work/,
    })) as HTMLButtonElement;
    await screen.findByText('0 of 1 repositories done');
    expect(next.disabled).toBe(false);
  });

  it('renders in Chinese', async () => {
    fakeFetch((url) =>
      url.endsWith('/index-status') ? json(indexStatus('indexing')) : json({}, 404),
    );
    renderWithIntl(
      <MigrateWizard
        initialRun={makeRun({
          step: 'import',
          connectedRepoRef: 'acme/widgets',
          latestImport: runningImport,
        })}
        projectName="Quiet Harbor"
        userInitial="Y"
      />,
      { locale: 'zh', messages: zhMessages },
    );
    expect(await screen.findByRole('button', { name: '进入 Motir' })).toBeTruthy();
    expect(screen.getByText('进入之后，索引和导入会继续进行。')).toBeTruthy();
    expect(screen.getByTestId('migrate-import-running').textContent).toContain(
      '正在从 Jira 导入 · 已处理 40 个工作项',
    );
    expect(screen.getByText('索引和导入都在后台运行。你随时可以进入 Motir。')).toBeTruthy();
  });
});
