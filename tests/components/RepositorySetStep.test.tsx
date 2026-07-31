// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { RepositorySetStep } from '@/components/planning/repositories/RepositorySetStep';
import { RepositoryRow } from '@/components/planning/repositories/RepositoryRow';
import type {
  ProjectRepoDto,
  ProjectRepoEstablishViewDto,
  ProjectRepoStateDto,
} from '@/lib/dto/projectRepos';

// THE ESTABLISH STEP (Story MOTIR-1775 · MOTIR-1782 · design/repository-set).
//
// The card's central claim is a NEGATIVE one, so most of what is asserted here is
// what must NOT be on screen: a one-repository plan and a three-repository plan
// render the IDENTICAL default screen, and no repository name, count, role, org,
// seed source or GitHub status code reaches it. That is the `notes.html` #151 rule
// — an AI-derived artifact a non-technical user cannot judge is derived and used,
// never put behind an editor — and it is only true if a test says so, because
// every future change to this file is a chance to leak one word of it.
//
// The technical path is asserted for the opposite property: once the user has
// self-identified by connecting their own GitHub, the vocabulary IS theirs, per-row
// state is independent, and no state is a dead end.

const ROW_DEFAULTS = {
  projectId: 'proj-1',
  label: null,
  seedSource: 'nextjs-prisma-vercel-starter',
  failureReason: null,
  proposalSignal: null,
  realizedRepo: null,
  established: false,
  // The TAKE-IT-OVER saga (MOTIR-711) — null is the common case: no handoff has
  // ever been requested for this row.
  takeover: null,
  createdAt: '2026-07-30T10:00:00.000Z',
  updatedAt: '2026-07-30T10:00:00.000Z',
} as const;

function row(
  over: Partial<ProjectRepoDto> & { id: string; role: ProjectRepoDto['role']; name: string },
): ProjectRepoDto {
  return {
    ...ROW_DEFAULTS,
    state: 'proposed' as ProjectRepoStateDto,
    position: 'a0',
    ...over,
  };
}

function view(
  rows: ProjectRepoDto[],
  over: Partial<ProjectRepoEstablishViewDto> = {},
): ProjectRepoEstablishViewDto {
  return {
    set: { projectId: 'proj-1', rows, ownership: null, targetAccount: null },
    hostOwner: 'motir-projects',
    githubLogin: null,
    hasInstallation: false,
    connectCandidates: [],
    ...over,
  };
}

/** The step polls + writes through `fetch`; every test drives it explicitly so
 *  nothing depends on a real network or on timing. */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => handler(url, init),
  }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** Render ONE row on its own — for the states the step cannot be driven into
 *  from the default path (a settled or in-flight set closes the door into the
 *  technical path, by design). */
function renderRow(r: ProjectRepoDto, opts: { total?: number } = {}) {
  return renderWithIntl(
    <RepositoryRow
      row={r}
      index={0}
      total={opts.total ?? 1}
      hostOwner="motir-projects"
      candidates={[]}
      grantMoreHref="/settings/workspace/github"
      busy={false}
      connecting={false}
      onConnectingChange={() => {}}
      onRename={() => {}}
      onConnect={() => {}}
      onReplan={() => {}}
      onSkip={() => {}}
      onRemove={() => {}}
      onMove={() => {}}
      onRetry={() => {}}
    />,
  );
}

function renderStep(initial: ProjectRepoEstablishViewDto) {
  return renderWithIntl(
    <RepositorySetStep
      projectKey="MOTIR"
      initialView={initial}
      backlogHref="/items"
      connectHref="/settings/workspace/github"
    />,
  );
}

beforeEach(() => {
  stubFetch(() => view([]));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── The DEFAULT path ────────────────────────────────────────────────────────

describe('the default path', () => {
  it('is one sentence, one primary and one quiet secondary — and says nothing technical', () => {
    const { container } = renderStep(
      view([row({ id: 'r1', role: 'web', name: 'acme-booking-web' })]),
    );

    expect(screen.getByRole('heading', { name: 'Motir will host your code' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'I already have code' })).toBeTruthy();

    // The ownership promise is on the MAIN LINE, not in a footnote — it is the
    // line MOTIR-1785's acceptance video must be able to show.
    expect(container.textContent).toContain("It's yours.");

    // …and none of the model reaches the screen.
    const text = container.textContent ?? '';
    for (const leak of ['acme-booking-web', 'motir-projects', 'web', 'repositor', 'starter']) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  it('renders the IDENTICAL screen for a one-repo plan and a three-repo plan', () => {
    // The card's central claim, answered by REMOVING the question rather than by
    // styling it two ways: cardinality is not the user's business, so nothing
    // about it can reach the DOM.
    const one = renderStep(view([row({ id: 'r1', role: 'web', name: 'solo' })]));
    const oneHtml = one.container.innerHTML;
    cleanup();

    const three = renderStep(
      view([
        row({ id: 'r1', role: 'web', name: 'acme-web', position: 'a0' }),
        row({ id: 'r2', role: 'api', name: 'acme-api', position: 'a1' }),
        row({ id: 'r3', role: 'shared', name: 'acme-shared', position: 'a2' }),
      ]),
    );

    expect(three.container.innerHTML).toBe(oneHtml);
  });

  it('goes working → ready on Continue, and never names a repository on the way', async () => {
    let phase: ProjectRepoStateDto = 'proposed';
    stubFetch((url) => {
      if (url.endsWith('/establish')) {
        phase = 'created';
        return { projectId: 'proj-1', rows: [] };
      }
      return view([row({ id: 'r1', role: 'web', name: 'acme-booking-web', state: phase })]);
    });

    const { container } = renderStep(
      view([row({ id: 'r1', role: 'web', name: 'acme-booking-web' })]),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    });

    await waitFor(() => {
      expect(screen.getByTestId('repo-setup-status').textContent).toContain('Your code is ready');
    });
    expect(screen.getByRole('link', { name: 'Go to my backlog' })).toBeTruthy();
    expect(container.textContent).not.toContain('acme-booking-web');
  });

  it('shows ONE status line while creating, however many repositories are behind it', () => {
    const { container } = renderStep(
      view([
        row({ id: 'r1', role: 'web', name: 'a', state: 'creating' }),
        row({ id: 'r2', role: 'api', name: 'b', state: 'creating' }),
      ]),
    );

    const statuses = container.querySelectorAll('[data-testid="repo-setup-status"]');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.textContent).toContain('Setting up your code…');
    expect(statuses[0]!.getAttribute('role')).toBe('status');
  });

  it('reports a failure in plain language — no repository name, no GitHub status code', () => {
    const { container } = renderStep(
      view([
        row({
          id: 'r1',
          role: 'web',
          name: 'acme-booking-web',
          state: 'failed',
          // A REAL reason, of the shape the primitive persists. The default path
          // must render none of it.
          failureReason: 'GitHub declined the request (422) for "acme-booking-web".',
        }),
      ]),
    );

    expect(screen.getByTestId('repo-setup-status').textContent).toContain(
      "Motir couldn't finish setting up your code",
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    const text = container.textContent ?? '';
    expect(text).toContain('Your plan is safe in your backlog.');
    expect(text).not.toContain('acme-booking-web');
    expect(text).not.toContain('422');
    expect(text).not.toContain('GitHub declined');
    // The failure is ANNOUNCED, not just coloured.
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });

  it('has no axe violations in any of its states', async () => {
    for (const state of ['proposed', 'creating', 'created', 'failed'] as ProjectRepoStateDto[]) {
      const { container } = renderStep(
        view([
          row({
            id: 'r1',
            role: 'web',
            name: 'acme-web',
            state,
            failureReason: state === 'failed' ? 'nope' : null,
          }),
        ]),
      );
      const results = await axe.run(container, {
        rules: { 'color-contrast': { enabled: false } },
      });
      expect(results.violations.map((v) => v.id)).toEqual([]);
      cleanup();
    }
  });
});

// ── The door, and what is behind it ─────────────────────────────────────────

describe('“I already have code”', () => {
  it('hands off to the SHIPPED connect pane, and shows no repository vocabulary first', async () => {
    const { container } = renderStep(view([row({ id: 'r1', role: 'api', name: 'acme-api' })]));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I already have code' }));
    });

    expect(screen.getByRole('heading', { name: 'Use the code you already have' })).toBeTruthy();
    const connect = screen.getByRole('link', { name: 'Connect GitHub' });
    expect(connect.getAttribute('href')).toBe('/settings/workspace/github');
    // Still nothing about rows, roles or names — the user has said they have code,
    // not yet proved which account it is in.
    expect(container.textContent).not.toContain('acme-api');
    expect(screen.queryByTestId('repo-row-api')).toBeNull();

    // …and the way back is a real answer, not a trap.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Let Motir host it' }));
    });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('goes STRAIGHT to the set when the user has already connected — the confirmation only explains a hand-off', async () => {
    renderStep(
      view([row({ id: 'r1', role: 'web', name: 'acme-web' })], {
        githubLogin: 'yuezhu',
        hasInstallation: true,
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I already have code' }));
    });

    expect(screen.getByRole('heading', { name: 'Where should each part live?' })).toBeTruthy();
    expect(screen.getByText(/Connected as yuezhu/)).toBeTruthy();
  });
});

// ── The TECHNICAL path ──────────────────────────────────────────────────────

describe('the technical path', () => {
  const connected = { githubLogin: 'yuezhu', hasInstallation: true };

  async function openSet(v: ProjectRepoEstablishViewDto) {
    const rendered = renderStep(v);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I already have code' }));
    });
    return rendered;
  }

  it('reads as ONE question at one row — no role chip, no reorder, no menu', async () => {
    await openSet(view([row({ id: 'r1', role: 'web', name: 'acme-booking' })], connected));

    expect(screen.getByLabelText('Repository name')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Move up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Repository actions' })).toBeNull();
  });

  it('renders one row per part at two rows, each with its role, its name and the fixed owner prefix', async () => {
    const { container } = await openSet(
      view(
        [
          row({ id: 'r1', role: 'web', name: 'acme-web', position: 'a0' }),
          row({
            id: 'r2',
            role: 'api',
            name: 'acme-api',
            position: 'a1',
            proposalSignal: 'plan-item-role',
          }),
        ],
        connected,
      ),
    );

    expect(screen.getByTestId('repo-row-web')).toBeTruthy();
    expect(screen.getByTestId('repo-row-api')).toBeTruthy();
    // The owner is SHOWN, not offered — it is not the user's to choose.
    expect(container.textContent).toContain('motir-projects /');
    // Role-specific accessible names keep the two rows distinguishable to a
    // screen reader even though the visible label is the role chip.
    expect(screen.getByLabelText('Name of the web repository')).toBeTruthy();
    expect(screen.getByLabelText('Name of the api repository')).toBeTruthy();
    // The derivation's WHY, from the persisted signal — a row nothing inferred
    // (the web one here) carries no explanation to invent.
    expect(container.textContent).toContain(
      'Part of the plan you approved builds the api, so Motir asked for a separate home for it',
    );
  });

  it('persists a rename rather than holding it in component state', async () => {
    const calls: { url: string; body: unknown }[] = [];
    stubFetch((url, init) => {
      if (init?.method === 'PATCH') {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return row({ id: 'r1', role: 'web', name: 'renamed' });
      }
      return view([row({ id: 'r1', role: 'web', name: 'renamed' })], connected);
    });

    await openSet(view([row({ id: 'r1', role: 'web', name: 'acme-booking' })], connected));
    const field = screen.getByLabelText('Repository name');
    await act(async () => {
      fireEvent.change(field, { target: { value: 'renamed' } });
      fireEvent.blur(field);
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toContain('/api/projects/MOTIR/repositories/r1');
    expect(calls[0]!.body).toEqual({ name: 'renamed' });
  });

  it('switches a row to “Use one of mine” and connects the picked repository', async () => {
    const posts: { url: string; body: unknown }[] = [];
    stubFetch((url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return row({ id: 'r1', role: 'api', name: 'acme-api', state: 'connected' });
      }
      return view([row({ id: 'r1', role: 'api', name: 'acme-api' })], {
        ...connected,
        connectCandidates: [
          {
            id: 'gh-1',
            owner: 'acme-inc',
            name: 'booking-service',
            repoRef: 'acme-inc/booking-service',
            defaultBranch: 'main',
            claimed: false,
          },
        ],
      });
    });

    await openSet(
      view([row({ id: 'r1', role: 'api', name: 'acme-api' })], {
        ...connected,
        connectCandidates: [
          {
            id: 'gh-1',
            owner: 'acme-inc',
            name: 'booking-service',
            repoRef: 'acme-inc/booking-service',
            defaultBranch: 'main',
            claimed: false,
          },
        ],
      }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use one of mine' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('combobox', { name: 'Repository to use' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /acme-inc\/booking-service/ }));
    });

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/repositories/r1/state');
    expect(posts[0]!.body).toEqual({ to: 'connected', githubRepoId: 'gh-1' });
  });

  it('keeps every per-row outcome independent, and leaves no state a dead end', async () => {
    const { container } = await openSet(
      view(
        [
          row({
            id: 'r1',
            role: 'web',
            name: 'acme-web',
            position: 'a0',
            state: 'created',
            established: true,
            realizedRepo: {
              id: 'gh-1',
              provider: 'github',
              owner: 'motir-projects',
              name: 'acme-web',
              repoRef: 'motir-projects/acme-web',
              defaultBranch: 'main',
            },
          }),
          row({
            id: 'r2',
            role: 'api',
            name: 'acme-api',
            position: 'a1',
            state: 'failed',
            failureReason: 'Motir already hosts a repository called acme-api.',
          }),
          row({ id: 'r3', role: 'infra', name: 'acme-infra', position: 'a2', state: 'skipped' }),
        ],
        connected,
      ),
    );

    const created = screen.getByTestId('repo-row-web');
    const failed = screen.getByTestId('repo-row-api');
    const skipped = screen.getByTestId('repo-row-infra');

    // The created row keeps its outcome and links out to the real repository.
    expect(within(created).getByText('Created')).toBeTruthy();
    expect(
      within(created).getByRole('link', { name: 'motir-projects/acme-web' }).getAttribute('href'),
    ).toBe('https://github.com/motir-projects/acme-web');

    // The failed row carries the REAL reason (a technical user gets the real one),
    // announced as an alert, plus all three recoveries.
    const alert = within(failed).getByRole('alert');
    expect(alert.textContent).toContain('Motir already hosts a repository called acme-api.');
    expect(within(failed).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(within(failed).getByRole('button', { name: 'Use one of mine' })).toBeTruthy();
    expect(within(failed).getByRole('button', { name: 'Skip this one' })).toBeTruthy();

    // The skipped row is quiet, not a severity — and keeps both ways back.
    expect(within(skipped).getByText('Skipped')).toBeTruthy();
    expect(within(skipped).getByRole('button', { name: 'Create it after all' })).toBeTruthy();

    // The partial set is a legal, COMPLETABLE end state.
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeTruthy();
    expect(container.textContent).toContain('1 created · 1 skipped · 1 needs a decision');
  });

  it('retries ONE row without re-attempting its siblings', async () => {
    const posts: { url: string; body: unknown }[] = [];
    const rows = [
      row({
        id: 'r1',
        role: 'web',
        name: 'a',
        position: 'a0',
        state: 'failed',
        failureReason: 'x',
      }),
      row({
        id: 'r2',
        role: 'api',
        name: 'b',
        position: 'a1',
        state: 'failed',
        failureReason: 'y',
      }),
    ];
    stubFetch((url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return { projectId: 'proj-1', rows: [] };
      }
      return view(rows, connected);
    });

    await openSet(view(rows, connected));
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('repo-row-api')).getByRole('button', { name: 'Retry' }),
      );
    });

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toContain('/repositories/establish');
    expect(posts[0]!.body).toEqual({ rowId: 'r2' });
  });

  it('truncates a long owner/name inside the row instead of blowing it out', () => {
    // The repo's recurring horizontal-overflow class is a missing `min-w-0`, so
    // the guard is structural: every flex column that can hold a long name must
    // be shrinkable and the name itself must truncate.
    //
    // Rendered as a ROW rather than through the step, because a set whose only
    // row is `created` is SETTLED — the default path then reads "Your code is
    // ready" and offers no door into the technical path, by design (re-entry is
    // MOTIR-1764's code-context surface, not this step's).
    const long = 'an-extremely-long-repository-name-that-nobody-would-ever-type-by-hand';
    const { container } = renderRow(
      row({
        id: 'r1',
        role: 'web',
        name: long,
        state: 'created',
        established: true,
        realizedRepo: {
          id: 'gh-1',
          provider: 'github',
          owner: 'an-organisation-with-a-very-long-login',
          name: long,
          repoRef: `an-organisation-with-a-very-long-login/${long}`,
          defaultBranch: 'main',
        },
      }),
    );

    const link = screen.getByRole('link', {
      name: `an-organisation-with-a-very-long-login/${long}`,
    });
    expect(link.className).toContain('truncate');
    expect(link.className).toContain('min-w-0');
    expect(container.querySelector('[data-testid="repo-row-web"] .min-w-0')).toBeTruthy();
  });

  it('has no axe violations in ANY per-row state', async () => {
    const states: ProjectRepoDto[] = [
      row({ id: 'r1', role: 'web', name: 'a' }),
      row({ id: 'r2', role: 'api', name: 'b', state: 'creating' }),
      row({
        id: 'r3',
        role: 'web',
        name: 'c',
        state: 'created',
        established: true,
        realizedRepo: {
          id: 'gh-1',
          provider: 'github',
          owner: 'motir-projects',
          name: 'c',
          repoRef: 'motir-projects/c',
          defaultBranch: 'main',
        },
      }),
      row({ id: 'r4', role: 'infra', name: 'd', state: 'failed', failureReason: 'nope' }),
      row({ id: 'r5', role: 'mobile', name: 'e', state: 'skipped' }),
    ];

    for (const state of states) {
      // Two rows so the reorder + menu affordances render too — they are the half
      // a one-row set drops, and the half most likely to carry an ARIA defect.
      const { container } = renderRow(state, { total: 2 });
      const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
      expect(results.violations.map((v) => v.id)).toEqual([]);
      cleanup();
    }
  });
});

// ── Editing the set, and the states the plain flow cannot reach ─────────────

describe('editing the set before it is executed', () => {
  const connected = { githubLogin: 'yuezhu', hasInstallation: true };

  async function openSet(v: ProjectRepoEstablishViewDto) {
    const rendered = renderStep(v);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I already have code' }));
    });
    return rendered;
  }

  function capture(rows: ProjectRepoDto[], over: Partial<ProjectRepoEstablishViewDto> = {}) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    stubFetch((url, init) => {
      if (init?.method && init.method !== 'GET') {
        calls.push({
          url,
          method: init.method,
          body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        return rows[0]!;
      }
      return view(rows, { ...connected, ...over });
    });
    return calls;
  }

  it('adds a repository at SET level, with a name that cannot collide on arrival', async () => {
    const rows = [row({ id: 'r1', role: 'web', name: 'new-repository', position: 'a0' })];
    const calls = capture(rows);
    await openSet(view(rows, connected));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a repository' }));
    });

    await waitFor(() => expect(calls).toHaveLength(1));
    // The set's `(project, name)` unique index would reject a second row named
    // like the first, before the user could rename it.
    expect(calls[0]!.body).toEqual({ role: 'other', name: 'new-repository-2' });
  });

  it('skips and removes a row through the row menu', async () => {
    const rows = [
      row({ id: 'r1', role: 'web', name: 'a', position: 'a0' }),
      row({ id: 'r2', role: 'api', name: 'b', position: 'a1' }),
    ];
    const calls = capture(rows);
    await openSet(view(rows, connected));

    const menus = screen.getAllByRole('button', { name: 'Repository actions' });
    await act(async () => {
      fireEvent.click(menus[0]!);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Skip this one' }));
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ to: 'skipped' });

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Repository actions' })[1]!);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.method).toBe('DELETE');
    expect(calls[1]!.url).toContain('/repositories/r2');
  });

  it('reorders with keyboard-operable controls, disabled only at the edges', async () => {
    const rows = [
      row({ id: 'r1', role: 'web', name: 'a', position: 'a0' }),
      row({ id: 'r2', role: 'api', name: 'b', position: 'a1' }),
    ];
    const calls = capture(rows);
    await openSet(view(rows, connected));

    const ups = screen.getAllByRole('button', { name: 'Move up' });
    const downs = screen.getAllByRole('button', { name: 'Move down' });
    // The grip is decorative; these are the real controls, so the FIRST row
    // cannot move up and the LAST cannot move down.
    expect((ups[0] as HTMLButtonElement).disabled).toBe(true);
    expect((downs[1] as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      fireEvent.click(downs[0]!);
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ direction: 'down' });
    expect(calls[0]!.url).toContain('/repositories/r1/move');
  });

  it('carries the user’s intent through a re-plan, which gives the row a NEW id', async () => {
    // A sibling that is still UNRESOLVED, so the set is not settled and the
    // technical path's door is open — a wholly settled set closes it by design.
    const sibling = row({ id: 'r0', role: 'web', name: 'w', position: 'a0' });
    const skipped = row({ id: 'r1', role: 'api', name: 'a', position: 'a1', state: 'skipped' });
    const fresh = row({ id: 'r2', role: 'api', name: 'a', position: 'a1' });
    const calls: { url: string; body: unknown }[] = [];
    let current: ProjectRepoDto = skipped;
    stubFetch((url, init) => {
      if (init?.method === 'POST') {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        current = fresh;
        return fresh;
      }
      return view([sibling, current], {
        ...connected,
        connectCandidates: [
          {
            id: 'gh-1',
            owner: 'acme-inc',
            name: 'mine',
            repoRef: 'acme-inc/mine',
            defaultBranch: 'main',
            claimed: false,
          },
        ],
      });
    });

    await openSet(view([sibling, skipped], connected));
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId('repo-row-api')).getByRole('button', { name: 'Use one of mine' }),
      );
    });

    await waitFor(() => expect(calls[0]!.body).toEqual({ to: 'proposed' }));
    // The replacement lands on the PICKER, not on a name field — otherwise the
    // user would have to ask for the same thing twice.
    await waitFor(() =>
      expect(
        within(screen.getByTestId('repo-row-api')).getByRole('combobox', {
          name: 'Repository to use for the api',
        }),
      ).toBeTruthy(),
    );
  });

  it('reports a failed action without pretending anything changed', async () => {
    const rows = [row({ id: 'r1', role: 'web', name: 'a' })];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => ({
        ok: init?.method === undefined || init.method === 'GET',
        status: init?.method && init.method !== 'GET' ? 409 : 200,
        json: async () =>
          init?.method && init.method !== 'GET'
            ? { code: 'PROJECT_REPO_NAME_TAKEN' }
            : view(rows, connected),
      })),
    );

    await openSet(view(rows, connected));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a repository' }));
    });

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain("That didn't work");
    });
  });
});

describe('a row, in the states the flow cannot be driven into', () => {
  it('drops the owner prefix when the deployment cannot provision at all', () => {
    const { container } = renderWithIntl(
      <RepositoryRow
        row={row({ id: 'r1', role: 'web', name: 'acme-web' })}
        index={0}
        total={1}
        hostOwner={null}
        candidates={[]}
        grantMoreHref="/settings/workspace/github"
        busy={false}
        connecting={false}
        onConnectingChange={() => {}}
        onRename={() => {}}
        onConnect={() => {}}
        onReplan={() => {}}
        onSkip={() => {}}
        onRemove={() => {}}
        onMove={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(container.textContent).not.toContain('/');
    expect(screen.getByLabelText('Repository name')).toBeTruthy();
  });

  it('says a non-web row starts near-empty, rather than implying a scaffold that does not exist', () => {
    renderRow(row({ id: 'r1', role: 'infra', name: 'acme-infra', seedSource: 'initialised' }));
    expect(screen.getByText(/Starts with a README/)).toBeTruthy();
  });

  it('shows the plain name when the host is one Motir cannot address', () => {
    // `repoWebUrl` answers null for an unknown provider — an honest "I cannot
    // tell you where it lives" beats a guessed URL that 404s.
    renderRow(
      row({
        id: 'r1',
        role: 'web',
        name: 'a',
        state: 'connected',
        established: true,
        realizedRepo: {
          id: 'gh-1',
          provider: 'bitbucket',
          owner: 'acme',
          name: 'a',
          repoRef: 'acme/a',
          defaultBranch: 'main',
        },
      }),
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('acme/a')).toBeTruthy();
  });

  it('marks an already-claimed repository in the picker instead of offering a doomed choice', () => {
    renderWithIntl(
      <RepositoryRow
        row={row({ id: 'r1', role: 'web', name: 'a' })}
        index={0}
        total={1}
        hostOwner="motir-projects"
        candidates={[
          {
            id: 'gh-1',
            owner: 'acme',
            name: 'taken',
            repoRef: 'acme/taken',
            defaultBranch: 'main',
            claimed: true,
          },
        ]}
        grantMoreHref="/settings/workspace/github"
        busy={false}
        connecting
        onConnectingChange={() => {}}
        onRename={() => {}}
        onConnect={() => {}}
        onReplan={() => {}}
        onSkip={() => {}}
        onRemove={() => {}}
        onMove={() => {}}
        onRetry={() => {}}
      />,
    );

    // A one-row set in connect mode is the MONOREPO case, so the hint says so.
    expect(screen.getByText(/Everything lives here/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Grant more on GitHub' })).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: 'Repository to use' }));
    expect(screen.getByRole('option', { name: /already used by this project/ })).toBeTruthy();
  });

  it('re-opens the name field on a failed row, with the reason beside it', () => {
    renderRow(
      row({
        id: 'r1',
        role: 'api',
        name: 'acme-api-2',
        state: 'failed',
        failureReason: 'Motir already hosts a repository called acme-api.',
      }),
      { total: 2 },
    );
    // Editable again — ADR §1.5's de-collided name is only useful if the user can
    // accept or change it.
    expect(screen.getByLabelText('Name of the api repository')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Motir already hosts');
  });

  it('does not commit an empty rename — it restores the row’s name instead', () => {
    const renamed = vi.fn();
    renderWithIntl(
      <RepositoryRow
        row={row({ id: 'r1', role: 'web', name: 'acme-web' })}
        index={0}
        total={1}
        hostOwner="motir-projects"
        candidates={[]}
        grantMoreHref="/settings/workspace/github"
        busy={false}
        connecting={false}
        onConnectingChange={() => {}}
        onRename={renamed}
        onConnect={() => {}}
        onReplan={() => {}}
        onSkip={() => {}}
        onRemove={() => {}}
        onMove={() => {}}
        onRetry={() => {}}
      />,
    );

    const field = screen.getByLabelText('Repository name') as HTMLInputElement;
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.blur(field);
    expect(renamed).not.toHaveBeenCalled();
    expect(field.value).toBe('acme-web');

    // …and an unchanged name is not a write either.
    fireEvent.blur(field);
    expect(renamed).not.toHaveBeenCalled();
  });

  it('offers the way back to Motir hosting on a connected row', () => {
    const replan = vi.fn();
    renderWithIntl(
      <RepositoryRow
        row={row({
          id: 'r1',
          role: 'web',
          name: 'a',
          state: 'connected',
          established: true,
          realizedRepo: {
            id: 'gh-1',
            provider: 'github',
            owner: 'acme',
            name: 'a',
            repoRef: 'acme/a',
            defaultBranch: 'main',
          },
        })}
        index={0}
        total={1}
        hostOwner="motir-projects"
        candidates={[]}
        grantMoreHref="/settings/workspace/github"
        busy={false}
        connecting={false}
        onConnectingChange={() => {}}
        onRename={() => {}}
        onConnect={() => {}}
        onReplan={replan}
        onSkip={() => {}}
        onRemove={() => {}}
        onMove={() => {}}
        onRetry={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Let Motir host it' }));
    expect(replan).toHaveBeenCalledWith('r1', false);
  });
});

describe('the step’s remaining edges', () => {
  const connected = { githubLogin: 'yuezhu', hasInstallation: true };

  it('POLLS while a run is in flight, and stops the moment nothing is', async () => {
    vi.useFakeTimers();
    try {
      let state: ProjectRepoStateDto = 'creating';
      const spy = stubFetch(() => view([row({ id: 'r1', role: 'web', name: 'a', state })]));
      renderStep(view([row({ id: 'r1', role: 'web', name: 'a', state: 'creating' })]));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3200);
      });
      const whileRunning = spy.mock.calls.length;
      expect(whileRunning).toBeGreaterThanOrEqual(2);

      // The set settles; the poll must stop rather than hammer the read forever.
      state = 'created';
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
      const afterSettle = spy.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(spy.mock.calls.length).toBe(afterSettle);
    } finally {
      vi.useRealTimers();
    }
  });

  it('greets an installation nobody’s identity is attached to WITHOUT a name', async () => {
    // Grant 2 without grant 1 — another admin installed the App. The technical
    // path still works; only the greeting loses its login.
    renderStep(
      view([row({ id: 'r1', role: 'web', name: 'a' })], {
        githubLogin: null,
        hasInstallation: true,
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I already have code' }));
    });

    expect(screen.getByText('Choose where each part of your plan lives.')).toBeTruthy();
    expect(screen.queryByText(/Connected as/)).toBeNull();
  });

  it('“Not now” leaves the technical path with everything intact', async () => {
    renderStep(view([row({ id: 'r1', role: 'web', name: 'a' })], connected));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I already have code' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('surfaces a failed establish run and a failed re-plan, without claiming anything changed', async () => {
    stubFetch(() => {
      throw new Error('boom');
    });
    // The initial view is the seed, so the step renders even though every request
    // fails — which is the point: the failure is reported, not swallowed.
    renderStep(view([row({ id: 'r1', role: 'web', name: 'a' })], connected));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I already have code' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add a repository' }));
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("didn't work"));
  });

  it('renders the idle default for a project whose set is empty', () => {
    // Not reachable from the plan page (which mounts the step only for a project
    // that HAS a set), but the derivation must not read an empty set as "ready".
    renderStep(view([]));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    expect(screen.queryByTestId('repo-setup-status')).toBeNull();
  });
});

describe('a row’s ways forward all fire', () => {
  function handlers() {
    return {
      onConnectingChange: vi.fn(),
      onRename: vi.fn(),
      onConnect: vi.fn(),
      onReplan: vi.fn(),
      onSkip: vi.fn(),
      onRemove: vi.fn(),
      onMove: vi.fn(),
      onRetry: vi.fn(),
    };
  }

  function mount(r: ProjectRepoDto, h: ReturnType<typeof handlers>, total = 1, connecting = false) {
    return renderWithIntl(
      <RepositoryRow
        row={r}
        index={1}
        total={total}
        hostOwner="motir-projects"
        candidates={[]}
        grantMoreHref="/settings/workspace/github"
        busy={false}
        connecting={connecting}
        {...h}
      />,
    );
  }

  it('a FAILED row: retry, use one of mine, skip this one', () => {
    const h = handlers();
    mount(row({ id: 'r1', role: 'api', name: 'a', state: 'failed', failureReason: 'x' }), h);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use one of mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip this one' }));

    expect(h.onRetry).toHaveBeenCalledWith('r1');
    expect(h.onConnectingChange).toHaveBeenCalledWith('r1', true);
    expect(h.onSkip).toHaveBeenCalledWith('r1');
  });

  it('a SKIPPED row: create it after all, or use one of mine — carrying the intent', () => {
    const h = handlers();
    mount(row({ id: 'r1', role: 'mobile', name: 'a', state: 'skipped' }), h);

    fireEvent.click(screen.getByRole('button', { name: 'Create it after all' }));
    expect(h.onReplan).toHaveBeenCalledWith('r1', false);
    fireEvent.click(screen.getByRole('button', { name: 'Use one of mine' }));
    expect(h.onReplan).toHaveBeenCalledWith('r1', true);
  });

  it('a PICKING row goes back to Motir hosting without touching the server', () => {
    const h = handlers();
    mount(row({ id: 'r1', role: 'web', name: 'a' }), h, 1, true);
    fireEvent.click(screen.getByRole('button', { name: 'Let Motir host it' }));
    expect(h.onConnectingChange).toHaveBeenCalledWith('r1', false);
  });

  it('moves up as well as down', () => {
    const h = handlers();
    mount(row({ id: 'r1', role: 'web', name: 'a' }), h, 3);
    fireEvent.click(screen.getByRole('button', { name: 'Move up' }));
    expect(h.onMove).toHaveBeenCalledWith('r1', 'up');
  });

  it('shows the authored name when a settled row has lost its realized repo', () => {
    // `state` records what HAPPENED; `realizedRepo` records what is true NOW. A
    // disconnected repository is not a lost plan, so the row still names itself.
    const h = handlers();
    mount(row({ id: 'r1', role: 'web', name: 'acme-web', state: 'created' }), h);
    expect(screen.getByText('acme-web')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('maps EVERY derivation signal to its own copy, never to a raw key', () => {
    for (const [signal, expected] of [
      ['preplan-platform', /You described a/],
      ['default-web', /Nothing in the plan asked for a second repository/],
    ] as const) {
      const h = handlers();
      mount(row({ id: 'r1', role: 'web', name: 'a', proposalSignal: signal }), h);
      expect(screen.getByText(expected)).toBeTruthy();
      cleanup();
    }
  });
});
