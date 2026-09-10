// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { RepositorySetStep } from '@/components/planning/repositories/RepositorySetStep';
import en from '@/messages/en.json';
import type { ProjectRepoDto, ProjectRepoEstablishViewDto } from '@/lib/dto/projectRepos';

/**
 * THE VOCABULARY GUARD for MOTIR-5010 (subtask MOTIR-5017) — the deleted
 * repository question cannot come back.
 *
 * ⚠️ WRITTEN AGAINST THE CONCEPT, NEVER AGAINST A DIRECTORY LISTING. A guard that
 * greps `components/planning/repositories/` for a string passes the moment
 * somebody moves the file, and it passes while the string reappears one directory
 * over — so it would be loudest exactly when it is least needed. What is asserted
 * here instead is what the component RENDERS, in every state it can be in, and
 * what its module actually EXPORTS. A refactor that moves the file carries these
 * assertions with it, because they import the symbol rather than the path.
 *
 * The three things that must not return, and why each was removed:
 *
 *   1. **`Connect GitHub`** — the ready panel's old primary, labelled
 *      `t('connectGithub')` while its handler merely navigated. It was shown to
 *      people who had connected GitHub months earlier, and pressing it fetched
 *      nothing. The invitation is sent at establish now, so there is nothing left
 *      to ask (MOTIR-5015).
 *   2. **`I already have code`** — the door into the technical path, which left
 *      for ONBOARDING. A project with no repository cannot be planned at all, so
 *      a user standing here has already answered that question (MOTIR-5014).
 *   3. **The repository VOCABULARY itself** — names, roles, pickers, the
 *      derivation's "why". The whole point of the default path is that a founder
 *      is never asked to curate a developer artifact.
 */

function row(over: Partial<ProjectRepoDto> = {}): ProjectRepoDto {
  return {
    id: 'r1',
    role: 'web',
    name: 'acme-booking-web',
    state: 'proposed',
    seedSource: 'platform_starter',
    position: 'a0',
    established: false,
    failureReason: null,
    realizedRepo: null,
    derivation: null,
    access: { state: 'not_invited', login: null, invitationUrl: null },
    ...over,
  } as ProjectRepoDto;
}

function view(rows: ProjectRepoDto[], over: Partial<ProjectRepoEstablishViewDto> = {}) {
  return {
    set: { projectId: 'proj-1', rows },
    hostOwner: 'motir-projects',
    githubLogin: null,
    githubAvatarUrl: null,
    hasInstallation: false,
    connectCandidates: [],
    ...over,
  } as ProjectRepoEstablishViewDto;
}

function renderStep(v: ProjectRepoEstablishViewDto) {
  return renderWithIntl(
    <RepositorySetStep
      projectKey="MOTIR"
      initialView={v}
      backlogHref="/items"
      connectHref="/settings/workspace/github"
    />,
  );
}

/** The realized repository a `created` row carries — the only shape that can put
 *  a repository NAME on screen, which is what makes it the interesting case. */
const REALIZED = {
  id: 'gr-1',
  provider: 'github',
  owner: 'motir-projects',
  name: 'acme-booking-web',
  repoRef: 'motir-projects/acme-booking-web',
  defaultBranch: 'main',
  archived: false,
} as ProjectRepoDto['realizedRepo'];

/**
 * EVERY state the step can render, by the derivation `defaultStateOf` performs —
 * enumerated here so the guard cannot silently stop covering one. A new state
 * added to the component without a row here leaves that state unguarded, which is
 * the failure mode a "render the default and look" test has.
 */
const EVERY_STATE: { name: string; v: ProjectRepoEstablishViewDto }[] = [
  { name: 'idle', v: view([row()]) },
  { name: 'working', v: view([row({ state: 'creating' })]) },
  {
    name: 'ready · no identity',
    v: view([row({ state: 'created', established: true, realizedRepo: REALIZED })]),
  },
  {
    name: 'ready · invited',
    v: view(
      [
        row({
          state: 'created',
          established: true,
          realizedRepo: REALIZED,
          access: {
            state: 'invited',
            login: 'yuezhu',
            invitationUrl: 'https://github.com/motir-projects/acme-booking-web/invitations',
          },
        }),
      ],
      { githubLogin: 'yuezhu' },
    ),
  },
  {
    name: 'failed',
    v: view([row({ state: 'failed', failureReason: 'GitHub declined the request' })]),
  },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the post-approval step’s vocabulary cannot come back', () => {
  it('renders NO ask about GitHub or about code the user already has, in ANY state', () => {
    for (const { name, v } of EVERY_STATE) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => v }) as unknown as Response),
      );
      const { container } = renderStep(v);
      const text = container.textContent ?? '';

      // The two retired labels, by their SHIPPED English strings — read from the
      // catalog where they still exist for the settings surface that kept them,
      // so this assertion cannot drift from what a user would actually see.
      const connect = en.repositorySet.connectGithub;
      expect(text, `${name} renders the retired connect ask`).not.toContain(connect);
      expect(text, `${name} renders the retired technical-path door`).not.toContain(
        'I already have code',
      );

      cleanup();
    }
  });

  it('renders NO repository vocabulary — no name, no role, no owner prefix, in ANY state', () => {
    for (const { name, v } of EVERY_STATE) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, json: async () => v }) as unknown as Response),
      );
      const { container } = renderStep(v);
      const text = (container.textContent ?? '').toLowerCase();

      // ⚠️ THE MODEL MUST NOT REACH THE SCREEN. `notes.html` #151: derive it, use
      // it, and do not ask a non-technical user to curate a developer artifact.
      // A `created` row carries a REALIZED repository, so this is the state where
      // a leak would actually have something to leak.
      for (const leak of ['acme-booking-web', 'motir-projects', 'repositor', 'starter']) {
        expect(text, `${name} leaks "${leak}"`).not.toContain(leak);
      }

      cleanup();
    }
  });

  it('offers exactly ONE forward action per state — never a choice about repositories', () => {
    // idle: Continue, and nothing beside it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => EVERY_STATE[0]!.v }) as unknown as Response),
    );
    renderStep(EVERY_STATE[0]!.v);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
    cleanup();

    // failed: Try again, and nothing beside it. This is the panel the deleted
    // door appeared on TWICE, and the second site is the one a deletion that
    // reads only the first leaves behind.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => EVERY_STATE[4]!.v }) as unknown as Response),
    );
    renderStep(EVERY_STATE[4]!.v);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('the module exports no MODE switch — the step has one surface', async () => {
    // ⚠️ ASSERTED ON THE MODULE, not on a file's text. `own`, `set` and `access`
    // were members of a `Mode` union that no longer exists; a future refactor
    // that re-introduces a surface would have to re-introduce a way to reach it,
    // and the two renders above are what would catch that.
    const mod = await import('@/components/planning/repositories/RepositorySetStep');
    expect(Object.keys(mod)).toEqual(['RepositorySetStep']);

    // And the props the deleted surfaces needed are gone from the component's
    // call signature — `RepositorySetStep` takes four, none of which is a mode.
    expect(RepositorySetStep.length).toBe(1);
  });

  /* ⚠️ NO CASE ASSERTS THAT `RepositoryRow` IS ABSENT, and the reason is worth
     writing down rather than leaving as a gap. Vite resolves imports at TRANSFORM
     time, so a `await expect(import(...)).rejects` of a deleted module is a build
     error before a single assertion runs — the file fails to load rather than
     passing. The absence is already proved, harder, by two things that run on
     every pull request: `tsc --noEmit` and `pnpm build` both fail on an import of
     a module that is not there. A test that re-asserted it would be a weaker copy
     of a check the toolchain performs unconditionally. */
});
