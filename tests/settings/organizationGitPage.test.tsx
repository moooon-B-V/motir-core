// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { RepositoryInventory } from '@/app/(authed)/settings/organization/git/_components/RepositoryInventory';
import { CODE_GRAPH_RETENTION_WINDOW_DAYS } from '@/lib/codeGraph/offboarding';
import { SETTINGS_REDIRECTS } from '../../next.config';
import type { OrgRepoInventoryRowDto } from '@/lib/dto/organizationRepos';
import { deriveCodeGraphIndexState, type CodeGraphIndexState } from '@/lib/codeGraph/indexState';

// SETTINGS → ORGANISATION → GIT (Story MOTIR-4669 · MOTIR-4680), against
// `design/github/github.mock.html` Panel 6 and the surrounding contracts.
//
// The claims this file holds, each of which the design or an ADR names as a thing
// that goes wrong otherwise:
//
//   1. `Used by N projects` AT REST — the disclosure mechanism, expandable, with
//      the count being the LIST'S LENGTH so a project the viewer cannot browse is
//      never announced as a digit.
//   2. ZERO projects is an ORDINARY ROW, not an empty state and not a warning.
//   3. The index column says only what is KNOWN — including the NULL-HEAD
//      repository, which may not claim currency it cannot support (MOTIR-4817).
//   4. The disconnect dialog names every affected project, interpolates the
//      retention window, and makes NO permanence claim.
//   5. GitHub discloses BEFORE the link-out; GitLab confirms in-app.
//   6. The old workspace addresses redirect, permanently.

const PAGE = readFileSync('app/(authed)/settings/organization/git/page.tsx', 'utf8');

const REPO = (id: string, name: string, provider: 'github' | 'gitlab' = 'github') => ({
  id,
  owner: 'moooon',
  name,
  fullName: `moooon/${name}`,
  defaultBranch: 'main',
  provider,
  archived: false,
  connectedFromWorkspaceId: 'ws1',
});

const ROW = (
  id: string,
  name: string,
  projects: string[],
  indexState: CodeGraphIndexState = 'indexed',
  provider: 'github' | 'gitlab' = 'github',
): OrgRepoInventoryRowDto => ({
  repo: REPO(id, name, provider),
  projects: projects.map((p) => ({
    id: `p-${p}`,
    name: p,
    identifier: p.toUpperCase(),
    workspaceId: 'ws1',
  })),
  indexState,
});

/** 0, 1 and 3 projects — the fixture the acceptance criterion asks for. */
const ROWS: OrgRepoInventoryRowDto[] = [
  ROW('r1', 'motir-core', ['Atlas', 'Beacon', 'Corridor']),
  ROW('r2', 'motir-gateway', ['Atlas'], 'indexed', 'gitlab'),
  ROW('r3', 'design-system', [], 'never'),
];

afterEach(cleanup);

function renderInventory(over: Partial<Parameters<typeof RepositoryInventory>[0]> = {}) {
  const onDisconnect = vi.fn().mockResolvedValue(undefined);
  renderWithIntl(
    <RepositoryInventory
      rows={ROWS}
      organizationName="moooon"
      canDisconnect
      manageOnGithubHref="https://github.com/organizations/moooon/settings/installations/42"
      onDisconnect={onDisconnect}
      retentionDays={CODE_GRAPH_RETENTION_WINDOW_DAYS}
      {...over}
    />,
  );
  return { onDisconnect };
}

describe('the inventory — one row per connected repository', () => {
  it('renders every repository, with its provider', () => {
    renderInventory();
    expect(screen.getByText('motir-core')).toBeTruthy();
    expect(screen.getByText('motir-gateway')).toBeTruthy();
    expect(screen.getByText('design-system')).toBeTruthy();
    expect(screen.getByText('GitLab')).toBeTruthy();
  });

  it('⚠️ `Used by N projects` is a COLUMN, at rest, on a 0/1/3 fixture', () => {
    // The disclosure mechanism. A warning inside a dialog is read past; a count
    // that was on screen all along is not.
    renderInventory();
    expect(screen.getByText('Used by 3 projects')).toBeTruthy();
    expect(screen.getByText('Used by 1 project')).toBeTruthy();
    expect(screen.getByText('Used by no project yet')).toBeTruthy();
  });

  it('expands to the NAMES, in place', () => {
    renderInventory();
    fireEvent.click(screen.getByRole('button', { name: 'Used by 3 projects' }));
    expect(screen.getByText('Atlas')).toBeTruthy();
    expect(screen.getByText('Beacon')).toBeTruthy();
    expect(screen.getByText('Corridor')).toBeTruthy();
  });

  it('⚠️ a repository used by ZERO projects is an ORDINARY row', () => {
    // A LEGAL state: it belongs to the organisation, stays in the inventory and
    // stays indexed. Dropping the graph when the last project unlinks would
    // re-introduce per-project ownership through the back door and make the next
    // project that adds it pay for a full re-index. Not an empty state, not a
    // warning, and not expandable — there is nothing to expand.
    renderInventory();
    expect(screen.getByText('design-system')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Used by 0/ })).toBeNull();
    expect(screen.getByText(/A repository no project uses stays connected/)).toBeTruthy();
    // …and the same disclosure at rest, said ONCE for the organisation rather
    // than by naming N projects on every row (MOTIR-4821).
    expect(
      screen.getByText(/no repositories of its own can also reach the ones connected/),
    ).toBeTruthy();
  });
});

describe('the INDEX column — all four states (MOTIR-4724)', () => {
  it('renders the fixture`s own states', () => {
    renderInventory();
    expect(screen.getAllByText('Indexed').length).toBeGreaterThan(0);
    expect(screen.getByText('Never indexed')).toBeTruthy();
  });

  it('renders all FOUR states — the substrate MOTIR-4724 built', () => {
    // ⚠️ THIS CASE REPLACES ITS OWN OPPOSITE, and the replacement is the point.
    // It read "claims NEITHER `Current` NOR `Stale` NOR `Indexing`" and said it
    // would delete itself in the commit that added the substrate. This is that
    // commit — so the assertion INVERTS rather than disappearing, and the pair
    // records that the two states were withheld deliberately and then earned.
    renderInventory({
      rows: [
        ROW('r1', 'a', ['Atlas'], 'indexed'),
        ROW('r2', 'b', ['Atlas'], 'stale'),
        ROW('r3', 'c', ['Atlas'], 'indexing'),
        ROW('r4', 'd', [], 'never'),
      ],
    });
    expect(screen.getByText('Indexed')).toBeTruthy();
    expect(screen.getByText('Stale')).toBeTruthy();
    expect(screen.getByText('Indexing…')).toBeTruthy();
    expect(screen.getByText('Never indexed')).toBeTruthy();
  });

  it('⚠️ the NULL-HEAD repository makes NO currency claim (MOTIR-4817)', () => {
    // The bug this replaces: `indexed` rendered as `Current`, on the reasoning
    // that the state MEANS "the graph matches the head, as last observed". That
    // holds only when both shas are KNOWN — and `defaultBranchHeadSha` is null
    // until somebody pushes, with the push webhook its only writer, so a
    // repository nobody pushes never acquires a head and claimed `Current` for
    // ever. The state is derived HERE rather than hard-coded, so this case is
    // wired to the derivation the row actually reads: if the arm ever stopped
    // falling through to `indexed`, this test would be measuring nothing.
    const nullHead = deriveCodeGraphIndexState({
      hasSucceededIndex: true,
      defaultBranchHeadSha: null,
      indexedHeadSha: 'abc123',
      hasRunningIndex: false,
    });
    expect(nullHead).toBe('indexed');

    renderInventory({ rows: [ROW('r1', 'quiet-repo', ['Atlas'], nullHead)] });

    expect(screen.getByText('Indexed')).toBeTruthy();
    // The claim the label may not make. `Stale` is what carries drift, and this
    // row has no evidence either way — which is exactly why it may not say the
    // graph is up to date.
    expect(screen.queryByText('Current')).toBeNull();
  });
});

describe('the DISCONNECT dialog', () => {
  it('names every affected project, and interpolates the window', () => {
    renderInventory();
    fireEvent.click(screen.getAllByRole('button', { name: /Disconnect/ })[0]!);

    expect(screen.getByText('3 projects lose this repository.')).toBeTruthy();
    const body = screen.getByText(/The code index Motir built from it is kept/);
    expect(body.textContent).toContain(String(CODE_GRAPH_RETENTION_WINDOW_DAYS));
  });

  it('⚠️ discloses the permissive default ONCE, instead of naming projects that never chose (MOTIR-4821)', () => {
    // The list names projects that CHOSE this repository — a link, or work that
    // names it. A project with no repositories of its own can still REACH it
    // through the scope ladder's first rung, and that is a property of the
    // organisation rather than of any one project. Naming those projects
    // individually is the over-report this line replaces: the dialogue warned
    // that a scratch project which had never touched the repository would lose
    // it, on the disclosure a DESTRUCTIVE act rests on.
    renderInventory();
    fireEvent.click(screen.getAllByRole('button', { name: /Disconnect/ })[0]!);

    expect(screen.getByText(/no repositories of its own can also reach this one/)).toBeTruthy();
  });

  it('⚠️ makes NO permanence claim — re-adding inside the window cancels it', () => {
    // The shipped copy already promises that, so "this cannot be undone" would be
    // FALSE — and false in the direction that teaches people to click through
    // warnings.
    renderInventory();
    fireEvent.click(screen.getAllByRole('button', { name: /Disconnect/ })[0]!);
    const body = screen.getByText(/The code index Motir built from it is kept/);
    expect(body.textContent).toMatch(/cancels the removal/);
    expect(document.body.textContent).not.toMatch(/cannot be undone|permanent(ly)? delete/i);
  });

  it('⚠️ GITHUB discloses BEFORE the link-out — the primary leaves the app', () => {
    // Motir cannot remove a GitHub repository; selection is the App's install
    // screen. Once the admin is on github.com there is no dialog left to show
    // them, so the org-wide consequence is stated on the way OUT.
    renderInventory();
    fireEvent.click(screen.getAllByRole('button', { name: /Disconnect/ })[0]!);
    const go = screen.getByRole('link', { name: /Continue on GitHub/ });
    expect(go.getAttribute('href')).toContain('github.com');
  });

  it('⚠️ GITLAB is an in-app confirm — no link-out, and it calls through', () => {
    const { onDisconnect } = renderInventory({ rows: [ROWS[1]!] });
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }));
    expect(screen.queryByRole('link', { name: /Continue on GitHub/ })).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'Disconnect' }).at(-1)!);
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('the row action names the ACT and a second line names the VENUE', () => {
    // `Remove on GitHub` read as "delete the repository FROM GitHub" — the one act
    // Motir cannot perform and must never appear to offer. The act is identical on
    // both providers; only the venue differs.
    renderInventory();
    expect(screen.getAllByText('happens on GitHub').length).toBeGreaterThan(0);
    expect(screen.getByText('happens here')).toBeTruthy();
  });
});

describe('⚠️ reading is org MEMBERSHIP; writing is org ADMIN', () => {
  it('a plain member sees the inventory and NO destructive control', () => {
    // §6 of `organization-tier.md` forbids a relocation that narrows an audience,
    // and `/settings/workspace/github` checked no role at all. Absent, not
    // disabled — an entry point is a promise about a room.
    renderInventory({ canDisconnect: false });
    expect(screen.getByText('motir-core')).toBeTruthy();
    expect(screen.getByText('Used by 3 projects')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
  });
});

describe('the page`s own contracts', () => {
  it('composes the SHARED shell rather than re-specifying it', () => {
    expect(PAGE).toContain('GitSettingsShell');
    expect(PAGE).toContain('GitConnectBanner');
  });

  it('⚠️ carries NO identity card — the member`s credential moved to the ACCOUNT tier', () => {
    // Drawing a personal credential on the ORGANISATION's page is this story's own
    // tier confusion pointed the other way (MOTIR-4682 owns it).
    expect(PAGE).not.toContain('githubIdentityService');
  });

  it('⚠️ resolves the organisation NAME and the INVENTORY from the SAME workspace (MOTIR-4801)', () => {
    // The heading and the rows below it are two halves of one page, and they used
    // to answer to different subjects: `resolveActiveOrganization(userId, null)`
    // for the name (the actor's FIRST org membership) against
    // `listInventory(ctx)` for the rows (the org that owns `ctx.workspaceId`).
    // For a member of two organisations that draws one tenant's name over
    // another tenant's repositories, each with a `Disconnect` button.
    expect(PAGE).toContain('resolveWorkspaceOrganization(ctx.userId, ctx.workspaceId)');
    expect(PAGE).toContain('organizationRepoService.listInventory(ctx)');
    expect(PAGE).not.toContain('resolveActiveOrganization(');
  });

  it('⚠️ reads the CONNECTION at the organisation tier too (MOTIR-4836)', () => {
    // The test above pinned the NAME and the INVENTORY to one subject; the
    // connection card was the third half and it answered to a different tier
    // entirely. `getWorkspaceInstallation` is `findByWorkspaceId` — so from a
    // SIBLING workspace of the installing one, this card found nothing and
    // offered `Connect GitHub` for an account that is already installed, while
    // the inventory directly below it listed that same organisation's
    // repositories. One page, one request, two tiers.
    //
    // Pinned by NAME in both directions, because the drift is invisible: the
    // wrong read returns a plausible null rather than raising, and every other
    // signal on the page stays green.
    expect(PAGE).toContain('githubInstallationService.listOrganizationInstallations');
    expect(PAGE).not.toContain('getWorkspaceInstallation');
  });

  it('⚠️ RENDERS the connection set — it does not pick `rows[0]` (MOTIR-4836)', () => {
    // Two workspaces of one organisation may each install the App on a
    // DIFFERENT GitHub account, and this card is singular. The disposition is to
    // MAP rather than to choose: for N = 1 — the state Panel 2 of
    // `design/github/design-notes.md` draws, and every organisation on the
    // deployment today — the output is the single row it replaces; for N > 1 the
    // page states every connection. No new element is drawn.
    expect(PAGE).toContain('installations.map(');
    // The one affordance that cannot be repeated is supplied only when there IS
    // exactly one connection to manage, and is otherwise the null the GitLab arm
    // already renders.
    expect(PAGE).toContain('installations.length === 1');
  });

  it('⚠️ adds no route-level loading.tsx — the boundary is IN the page', () => {
    // `settings/organization/billing` `notFound()`s on a self-host build; a
    // route-level boundary in this tree flushes the head and turns that 404 into a
    // 200. The in-page `<Suspense>` after the gate streams without touching it.
    expect(PAGE).toContain('<Suspense');
  });
});

describe('the old addresses keep working — permanently', () => {
  it('both workspace git routes redirect to the organisation`s', () => {
    const rules = [...SETTINGS_REDIRECTS];
    const github = rules.find((r) => r.source === '/settings/workspace/github');
    const gitlab = rules.find((r) => r.source === '/settings/workspace/gitlab');

    expect(github?.destination).toBe('/settings/organization/git');
    expect(github?.permanent).toBe(true);
    // The GitLab arm keeps its provider through the search param: the inventory
    // spans BOTH providers, so the Segmented switches the connection card rather
    // than the page.
    expect(gitlab?.destination).toBe('/settings/organization/git?provider=gitlab');
    expect(gitlab?.permanent).toBe(true);
  });
});
