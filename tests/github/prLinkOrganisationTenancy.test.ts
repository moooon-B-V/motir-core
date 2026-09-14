import { Prisma } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { repoFileReadService } from '@/lib/services/repoFileReadService';
import { githubCodeScanningProxyService } from '@/lib/services/githubCodeScanningProxyService';
import { listConnectedRepoNames } from '@/lib/workItems/targetRepo';
import {
  GithubNotConnectedError,
  GithubPullRequestNotFoundError,
  GithubRepoNotFoundError,
} from '@/lib/github/errors';
import { UnknownTargetRepoError } from '@/lib/workItems/errors';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { deliveredItemIds } from '../helpers/prLink';

// THE FOURTH HOP — MOTIR-5152. `github_repo` read under a WORKSPACE context.
//
// MOTIR-4669 moved a repository's tenancy to the ORGANISATION and MOTIR-4649
// implemented it the cheap way: a second RLS read arm rather than a re-tenanted
// column, so `GithubRepo.workspaceId` stays the repository's home and the READ
// widens. That is what made the remaining defect invisible — the column a reader
// greps still says `workspaceId`, so a call site asking the workspace for
// repositories looks correct at every level except the one that matters.
//
// Three sweeps closed three hops (MOTIR-4836 the connection card, MOTIR-4838 its
// two installation siblings, MOTIR-4835 / MOTIR-4839 the service-context
// `project_repository` reads). Each was scoped to a SYMBOL and complete against
// it; this hop shared a symbol with none of them, so none of them reached it.
//
// What a person saw, in any workspace but the one the App was installed from:
//
//   1. The PR-link picker refused outright — "GitHub isn't connected for this
//      workspace" — on a page whose org-tier sibling was listing seven
//      repositories at that moment.
//   2. And the repo-straddle advisory was SILENTLY OFF. `listConnectedRepoNames`
//      returned nothing, so `likely-repo-straddle`'s candidate set was empty and
//      the check could not fire — a guard that reports nothing and a guard that
//      finds nothing are the same observation from outside.
//
//      ⚠️ The card said something else here — that every `targetRepo` pin was
//      invalid — and that is FALSE; see the SITE 2 block below for the dates.
//      The pin has been the PROJECT LINK's business since MOTIR-4955.
//
// ⚠️ THE FIXTURE IS THE WHOLE POINT, exactly as in
// `projectStateOrganisationTenancy.test.ts`: ONE ORGANISATION, TWO WORKSPACES.
// With a single workspace `workspace_id = app.workspace_id` and the organisation
// tier name the same rows, so a single-workspace fixture passes with the bug and
// without it — which is precisely why nothing that existed before caught this.
//
// ⚠️ AND THE CONTROL ORGANISATION IS NOT DECORATION. A reader that happens to see
// the whole population cannot distinguish a scoped read from an unscoped one.
// Org two holds repositories and pull requests of its own, so an empty result
// for it can never be mistaken for an empty table, and every assertion compares
// row IDENTITY rather than a count.
//
// Real Postgres, no mocks, through the real webhook + service paths (the repo
// convention).

const PASSWORD = 'hunter2hunter2';

const CORE = {
  providerRepoId: '51521',
  owner: 'moooon',
  name: 'motir-core',
  defaultBranch: 'main',
  archived: false,
};

const AI = {
  providerRepoId: '51522',
  owner: 'moooon',
  name: 'motir-ai',
  defaultBranch: 'main',
  archived: false,
};

/** Organisation TWO's own repository — what makes its empty results meaningful. */
const RIVAL = {
  providerRepoId: '51523',
  owner: 'zeta-labs',
  name: 'widgets',
  defaultBranch: 'main',
  archived: false,
};

interface OrgFixture {
  userId: string;
  organizationId: string;
  /** The workspace the App was installed FROM. */
  installingWorkspaceId: string;
  /** Its SIBLING in the same organisation — it connects nothing itself. */
  siblingWorkspaceId: string;
}

/** One organisation, two workspaces, one owner who is a member of both. */
async function makeOrgWithTwoWorkspaces(email: string, name: string): Promise<OrgFixture> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace: first } = await workspacesService.createWorkspace({
    name,
    ownerUserId: user.id,
  });
  const { workspace: second } = await workspacesService.createWorkspace({
    name: `${name} Sibling`,
    ownerUserId: user.id,
    // The one argument that makes this fixture different from every other one in
    // the suite — the second workspace joins the FIRST's organisation.
    organizationId: first.organizationId,
  });
  return {
    userId: user.id,
    organizationId: first.organizationId,
    installingWorkspaceId: first.id,
    siblingWorkspaceId: second.id,
  };
}

function prEvent(opts: {
  installationId: string;
  repoProviderId: string;
  number: number;
  headBranch: string;
  title: string;
  accountLogin: string;
}) {
  return {
    action: 'opened',
    installation: {
      id: opts.installationId,
      account: { login: opts.accountLogin, type: 'Organization' },
    },
    repository: { id: Number(opts.repoProviderId) },
    pull_request: {
      number: opts.number,
      state: 'open',
      merged: false,
      title: opts.title,
      head: { ref: opts.headBranch },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
}

/** Ingest a PR through the REAL webhook and return its internal row id. */
async function ingestPr(opts: {
  installationId: string;
  repoProviderId: string;
  number: number;
  headBranch: string;
  title: string;
  accountLogin: string;
}): Promise<string> {
  await githubWebhookService.handleEvent('pull_request', prEvent(opts));
  const row = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: opts.number } });
  return row.id;
}

const INST_ONE = 'inst-5152-moooon';
const INST_TWO = 'inst-5152-zeta';

let one: OrgFixture;
let two: OrgFixture;
/** A project in org ONE's SIBLING workspace — the workspace that could see nothing. */
let sibling: { ctx: ServiceContext; projectId: string };
/** A project in org TWO's sibling workspace — the isolation control. */
let rival: { ctx: ServiceContext; projectId: string };
/** The `motir-core` pull request, ingested into org ONE. */
let corePrId: string;
/** Org TWO's own pull request. */
let rivalPrId: string;

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();

  one = await makeOrgWithTwoWorkspaces('pr-link-5152-one@example.com', 'Moooon');
  await githubInstallationService.persistInstallation({
    workspaceId: one.installingWorkspaceId,
    installation: {
      installationId: INST_ONE,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [CORE, AI],
  });

  two = await makeOrgWithTwoWorkspaces('pr-link-5152-two@example.com', 'Zeta');
  await githubInstallationService.persistInstallation({
    workspaceId: two.installingWorkspaceId,
    installation: {
      installationId: INST_TWO,
      accountLogin: 'zeta-labs',
      accountType: 'Organization',
    },
    repos: [RIVAL],
  });

  const oneProject = await projectsService.createProject({
    workspaceId: one.siblingWorkspaceId,
    actorUserId: one.userId,
    name: 'Sibling',
    identifier: 'SIB',
  });
  sibling = {
    ctx: { userId: one.userId, workspaceId: one.siblingWorkspaceId },
    projectId: oneProject.id,
  };

  const twoProject = await projectsService.createProject({
    workspaceId: two.siblingWorkspaceId,
    actorUserId: two.userId,
    name: 'Rival',
    identifier: 'RIV',
  });
  rival = {
    ctx: { userId: two.userId, workspaceId: two.siblingWorkspaceId },
    projectId: twoProject.id,
  };

  corePrId = await ingestPr({
    installationId: INST_ONE,
    repoProviderId: CORE.providerRepoId,
    number: 4101,
    headBranch: 'subtask/rate-limit',
    title: 'Rate-limit the API',
    accountLogin: 'moooon',
  });
  rivalPrId = await ingestPr({
    installationId: INST_TWO,
    repoProviderId: RIVAL.providerRepoId,
    number: 4202,
    headBranch: 'subtask/rate-limit-rival',
    title: 'Rate-limit the widgets',
    accountLogin: 'zeta-labs',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A task in the sibling workspace's project — the card the picker is opened on. */
async function siblingItem(title = 'Link me') {
  return workItemsService.createWorkItem(
    { projectId: sibling.projectId, kind: 'task', title },
    sibling.ctx,
  );
}

/**
 * Run `fn` in a transaction bound to the given GUCs AS THE `motir_app` ROLE.
 *
 * CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as a superuser with
 * BYPASSRLS, under which RLS is inert regardless of FORCE ROW LEVEL SECURITY.
 * Without the role switch the repository-layer assertions below would be
 * measuring a Prisma `where` and calling it a policy.
 */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; organizationId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.organizationId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${ctx.organizationId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

// ── SITE 1 · `githubPullRequestService.searchLinkCandidates` — the banner ────

describe('the PR-link picker, from a workspace that did NOT install the App', () => {
  it('⚠️ offers the ORGANISATION`s pull requests — the defect, stated as what is now false', async () => {
    const item = await siblingItem();

    // THIS IS THE REPRODUCTION. Before this card the connectivity gate read
    // `listByWorkspace(ctx.workspaceId)`, which returned zero rows here, and the
    // zero became `GithubNotConnectedError` — the rose banner reporting a
    // disconnected organisation that was connected.
    const results = await githubPullRequestService.searchLinkCandidates(
      item.id,
      'rate',
      sibling.ctx,
    );

    expect(results.map((r) => r.id)).toEqual([corePrId]);
  });

  it('raises no `GithubNotConnectedError` in that state', async () => {
    const item = await siblingItem();
    await expect(
      githubPullRequestService.searchLinkCandidates(item.id, 'rate', sibling.ctx),
    ).resolves.toBeInstanceOf(Array);
  });

  it('still raises it for an organisation with NO connection at all — the control arm', async () => {
    // The banner is not retired, only re-aimed. A tenant that genuinely has no
    // connection must still be told so, or the fix would have replaced a false
    // negative with a silent empty list.
    const bare = await makeOrgWithTwoWorkspaces('pr-link-5152-bare@example.com', 'Bare');
    const project = await projectsService.createProject({
      workspaceId: bare.siblingWorkspaceId,
      actorUserId: bare.userId,
      name: 'Bare',
      identifier: 'BARE',
    });
    const ctx = { userId: bare.userId, workspaceId: bare.siblingWorkspaceId };
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Nothing connected' },
      ctx,
    );

    await expect(
      githubPullRequestService.searchLinkCandidates(item.id, 'rate', ctx),
    ).rejects.toBeInstanceOf(GithubNotConnectedError);
  });

  it('never offers a DIFFERENT organisation`s pull request — and org two`s own row proves the table is not empty', async () => {
    const item = await siblingItem();

    // Both pull requests match the query "rate"; only one is org one's. An
    // assertion on length alone would pass on the wrong row.
    const results = await githubPullRequestService.searchLinkCandidates(
      item.id,
      'rate',
      sibling.ctx,
    );

    expect(results.map((r) => r.id)).toEqual([corePrId]);
    expect(results.map((r) => r.id)).not.toContain(rivalPrId);

    // …and the mirror, from org two's side: it sees its own and not org one's.
    const rivalItem = await workItemsService.createWorkItem(
      { projectId: rival.projectId, kind: 'task', title: 'Rival card' },
      rival.ctx,
    );
    const rivalResults = await githubPullRequestService.searchLinkCandidates(
      rivalItem.id,
      'rate',
      rival.ctx,
    );
    expect(rivalResults.map((r) => r.id)).toEqual([rivalPrId]);
  });
});

// ── SITE 1b · the candidate read's OWN tenant gate, at the repository layer ──

describe('githubPullRequestRepository.searchCandidates — the tenant gate under `motir_app`', () => {
  it('admits a SIBLING workspace`s reader to the organisation`s pull request', async () => {
    // The gate and the read behind it had to move together: widening the gate
    // alone would have got the caller past the banner and then found nothing,
    // because this `where` was scoped the same way.
    const found = await asAppRole(
      {
        userId: one.userId,
        workspaceId: one.siblingWorkspaceId,
        organizationId: one.organizationId,
      },
      (tx) => githubPullRequestRepository.searchCandidates(one.organizationId, 'rate', 10, tx),
    );

    expect(found.map((r) => r.id)).toEqual([corePrId]);
  });

  it('refuses ANOTHER organisation`s pull request — asserted under the role, so the RLS arm is live', async () => {
    // Asking for org two's rows AS org one's reader. Two things refuse this and
    // both are meant to: the Prisma `where` on `organization_id`, and
    // `github_pull_request_org_read`, which resolves the caller's organisation
    // from the bound workspace. Under the superuser the second is inert, which
    // is why this runs as `motir_app`.
    const found = await asAppRole(
      {
        userId: one.userId,
        workspaceId: one.siblingWorkspaceId,
        organizationId: one.organizationId,
      },
      (tx) => githubPullRequestRepository.searchCandidates(two.organizationId, 'rate', 10, tx),
    );

    expect(found).toEqual([]);

    // And org two's own reader DOES see it — so the empty result above is a
    // scoped read, not an empty table.
    const theirs = await asAppRole(
      {
        userId: two.userId,
        workspaceId: two.siblingWorkspaceId,
        organizationId: two.organizationId,
      },
      (tx) => githubPullRequestRepository.searchCandidates(two.organizationId, 'rate', 10, tx),
    );
    expect(theirs.map((r) => r.id)).toEqual([rivalPrId]);
  });
});

// ── SITE 1c · the link a candidate leads to ─────────────────────────────────

describe('linking a candidate the widened picker offered', () => {
  it('LINKS an organisation`s pull request from the sibling workspace', async () => {
    // Without this arm the card would have shipped a list whose every row
    // answers "that pull request could not be found" when you click it:
    // `linkPullRequest`'s gate read `pr.repo.workspaceId !== ctx.workspaceId`,
    // which is the tier a repository is connected FROM.
    const item = await siblingItem();

    await githubPullRequestService.linkPullRequest(item.id, corePrId, sibling.ctx);

    expect(await deliveredItemIds(corePrId)).toEqual([item.id]);
  });

  it('UNLINKS it again — a link you can make and cannot remove is the worse trap', async () => {
    const item = await siblingItem();
    await githubPullRequestService.linkPullRequest(item.id, corePrId, sibling.ctx);

    const result = await githubPullRequestService.unlinkPullRequest(item.id, corePrId, sibling.ctx);

    expect(result).toEqual({ removed: true });
    expect(await deliveredItemIds(corePrId)).toEqual([]);
  });

  it('still refuses a DIFFERENT organisation`s pull request, in both directions', async () => {
    const item = await siblingItem();

    await expect(
      githubPullRequestService.linkPullRequest(item.id, rivalPrId, sibling.ctx),
    ).rejects.toBeInstanceOf(GithubPullRequestNotFoundError);
    await expect(
      githubPullRequestService.unlinkPullRequest(item.id, rivalPrId, sibling.ctx),
    ).rejects.toBeInstanceOf(GithubPullRequestNotFoundError);
  });
});

// ── SITE 2 · `listConnectedRepoNames` — the organisation's connected set ────
//
// ⚠️ THE CARD'S SECOND SYMPTOM IS FALSIFIED, AND THIS BLOCK IS WHERE IT IS
// RECORDED RATHER THAN QUIETLY DROPPED (MOTIR-5152).
//
// MOTIR-5152 asserted that past the picker's banner "every `targetRepo` pin is
// invalid ... because the validated domain is empty". That was true of this
// function's OWN doc comment and false of the product, by one day:
// **MOTIR-4955** (`d2d88fc1b`, merged 2026-09-10T08:45:39Z) made the PROJECT's
// repository set the isolation boundary, so a pin is validated against
// `projectRepoSetService.getRepoNameDomains` through `resolveEffectiveRepoDomain`
// — which, in its own words, "never inherits the workspace's connected
// repositories". The card was created 2026-09-11T13:41:08Z, twenty-nine hours
// later, and read the stale comment as a live symptom.
//
// So an UNLINKED repository is rejected in EVERY workspace, the installing one
// included, and that is the isolation MOTIR-4955 intends — not this defect. The
// assertions below pin BOTH halves, because a falsified premise silently dropped
// and a falsified premise corrected look identical in a diff.

describe('the organisation`s connected set, from a workspace that did NOT install the App', () => {
  it('⚠️ lists the ORGANISATION`s repositories — the defect, stated as what is now false', async () => {
    // Before this card the list came back EMPTY here, with the connection
    // plainly present one tier up.
    const names = await listConnectedRepoNames(sibling.ctx);

    expect(names.map((n) => n.name).sort()).toEqual(['motir-ai', 'motir-core']);
    expect(names.map((n) => n.repoRef).sort()).toEqual(['moooon/motir-ai', 'moooon/motir-core']);
  });

  it('never lists ANOTHER organisation`s repository — and org two`s own row proves the read is scoped', async () => {
    expect((await listConnectedRepoNames(sibling.ctx)).map((n) => n.name)).not.toContain('widgets');

    expect(
      (
        await listConnectedRepoNames({
          userId: two.userId,
          workspaceId: two.siblingWorkspaceId,
        })
      ).map((n) => n.name),
    ).toEqual(['widgets']);
  });

  it('is empty for an organisation with no connection at all — the honest outcome, kept', async () => {
    const bare = await makeOrgWithTwoWorkspaces('pr-link-5152-bare-domain@example.com', 'BareDom');

    expect(
      await listConnectedRepoNames({
        userId: bare.userId,
        workspaceId: bare.siblingWorkspaceId,
      }),
    ).toEqual([]);
  });

  it('⚠️ does NOT decide a `targetRepo` pin — the PROJECT LINK does (MOTIR-4955)', async () => {
    // The card's falsified claim, pinned as what is actually true. The
    // organisation has `motir-core` connected and this list now says so, and the
    // pin is STILL rejected, because the project has linked nothing. Without
    // this assertion the correction lives only in a commit message.
    expect((await listConnectedRepoNames(sibling.ctx)).map((n) => n.name)).toContain('motir-core');

    await expect(
      workItemsService.createWorkItem(
        {
          projectId: sibling.projectId,
          kind: 'task',
          title: 'Pinned to an unlinked organisation repository',
          targetRepo: 'motir-core',
        },
        sibling.ctx,
      ),
    ).rejects.toBeInstanceOf(UnknownTargetRepoError);
  });

  it('…and rejects it in the INSTALLING workspace too — which is what shows the rejection is not this defect', async () => {
    // The control that settles it. If the pin were about the connected set, this
    // project — in the very workspace the App was installed from — would accept
    // it. It does not: no project link, no pin, anywhere.
    const installingProject = await projectsService.createProject({
      workspaceId: one.installingWorkspaceId,
      actorUserId: one.userId,
      name: 'Installing',
      identifier: 'INST',
    });

    await expect(
      workItemsService.createWorkItem(
        {
          projectId: installingProject.id,
          kind: 'task',
          title: 'Pinned from the installing workspace',
          targetRepo: 'motir-core',
        },
        { userId: one.userId, workspaceId: one.installingWorkspaceId },
      ),
    ).rejects.toBeInstanceOf(UnknownTargetRepoError);
  });
});

// ── THE INVARIANT MOTIR-4649 DREW · the READ widened, the WRITE did not ──────

describe('no write path is widened — the `FOR ALL` policies are untouched', () => {
  it('a sibling-workspace actor cannot UPDATE an organisation repository it did not connect', async () => {
    const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { name: 'motir-core' } });

    // `github_repo_org_read` is `FOR SELECT` and nothing else, deliberately:
    // MOTIR-4677 kept the `FOR ALL` policy exactly as it was because DELETE is
    // authorised by `USING` alone, so a widened `FOR ALL` would have handed W2
    // the power to delete W1's repository row. `updateMany` reports 0 rows
    // touched rather than raising — the row is invisible to the write arm.
    const touched = await asAppRole(
      {
        userId: one.userId,
        workspaceId: one.siblingWorkspaceId,
        organizationId: one.organizationId,
      },
      (tx) => tx.githubRepo.updateMany({ where: { id: repo.id }, data: { archived: true } }),
    );

    expect(touched.count).toBe(0);
    // …and the row is genuinely unchanged, read back past RLS.
    const after = await adminDb.githubRepo.findUniqueOrThrow({ where: { id: repo.id } });
    expect(after.archived).toBe(false);
  });

  it('…nor DELETE it — the power the `FOR SELECT` shape exists to withhold', async () => {
    const repo = await adminDb.githubRepo.findFirstOrThrow({ where: { name: 'motir-core' } });

    const deleted = await asAppRole(
      {
        userId: one.userId,
        workspaceId: one.siblingWorkspaceId,
        organizationId: one.organizationId,
      },
      (tx) => tx.githubRepo.deleteMany({ where: { id: repo.id } }),
    );

    expect(deleted.count).toBe(0);
    expect(await adminDb.githubRepo.findUnique({ where: { id: repo.id } })).not.toBeNull();
  });

  it('…nor CREATE one owned by the installing workspace', async () => {
    const installation = await adminDb.githubInstallation.findFirstOrThrow({
      where: { installationId: INST_ONE },
    });

    // The write arm gates on `workspace_id`, which this actor's context is not.
    await expect(
      asAppRole(
        {
          userId: one.userId,
          workspaceId: one.siblingWorkspaceId,
          organizationId: one.organizationId,
        },
        (tx) =>
          tx.githubRepo.create({
            data: {
              installationId: installation.id,
              workspaceId: one.installingWorkspaceId,
              organizationId: one.organizationId,
              repoId: '5152-forged',
              owner: 'moooon',
              name: 'forged',
              defaultBranch: 'main',
            },
          }),
      ),
    ).rejects.toThrow();

    expect(await adminDb.githubRepo.findFirst({ where: { name: 'forged' } })).toBeNull();
  });
});

// ── WHY NOTHING BINDS `app.organization_id` — the measurement ───────────────
//
// The service methods above read the organisation's rows under a plain
// `withWorkspaceContext` / `withWorkspaceServiceContext` and bind NO org GUC.
// That is a deliberate choice and this block is its evidence: the org read arms
// resolve the organisation from the bound WORKSPACE via
// `app_caller_organization_id()`, exactly as `20260905214500_github_org_read_arms`
// says they were designed to ("a policy that only compared organization_id to
// that GUC would therefore admit nothing on the ordinary request path, which is
// every path this story is about").
//
// Binding one anyway would be harmless to READ and expensive to OWN: it would
// put these transactions' workspace-keyed reads (`work_item`,
// `work_item_delivery`) into the population swept by
// `tests/rls/org-context-arm-guard.test.ts`, whose three dispositions are bind
// the right thing / arm the table / adjudicate — and the honest answer for them
// is none of those, because they are not org-spanning reads at all.
//
// Under `motir_app`, so the arm is live rather than bypassed.

describe('the org read arm under a WORKSPACE-only context', () => {
  it('admits the organisation`s repositories with NO app.organization_id bound', async () => {
    const seen = await asAppRole(
      { userId: one.userId, workspaceId: one.siblingWorkspaceId },
      (tx) => tx.githubRepo.findMany({ where: { organizationId: one.organizationId } }),
    );
    expect(seen.map((r) => r.name).sort()).toEqual(['motir-ai', 'motir-core']);
  });

  it('admits the organisation`s pull requests with NO app.organization_id bound', async () => {
    const seen = await asAppRole(
      { userId: one.userId, workspaceId: one.siblingWorkspaceId },
      (tx) => tx.githubPullRequest.findMany({}),
    );
    expect(seen.map((r) => r.id)).toEqual([corePrId]);
  });

  it('and a USERLESS workspace-service context resolves it too', async () => {
    const seen = await asAppRole({ workspaceId: one.siblingWorkspaceId }, (tx) =>
      tx.githubRepo.findMany({ where: { organizationId: one.organizationId } }),
    );
    expect(seen.map((r) => r.name).sort()).toEqual(['motir-ai', 'motir-core']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// THE FIFTH HOP — MOTIR-5188. The same question, asked of a DIFFERENT method.
//
// MOTIR-5152 enumerated the callers of `githubRepoRepository.listByWorkspace`
// and fixed both. Its CLAIM was about every caller asking the WORKSPACE for the
// organisation's repositories, which is a larger set:
// `findConnectedByWorkspaceAndName` asks the identical question of the
// identical column and shares no symbol with that grep. It had four callers:
//
//   * `linkPullRequestByCoordinates`   — `link_pull_request` over the MCP
//   * `unlinkPullRequestByCoordinates` — `unlink_pull_request`
//   * `repoFileReadService.readFile`   — answered `repo_not_connected`
//   * `githubCodeScanningProxyService` — returned null, and degraded
//
// The first two RAISED `GithubRepoNotFoundError` in every workspace but the
// installing one. The other two failed SILENTLY, with an answer
// indistinguishable from a repository that genuinely is not connected. All four
// now resolve through `findConnectedByOrganizationAndName`; the workspace-keyed
// method stays, because MOTIR-1931's question is still a real one.
// ════════════════════════════════════════════════════════════════════════════

const FILE_TEXT = 'export const answer = 5188;\n';

/** The GitHub App env + a fetch mock for the token mint, a file read and the
 *  code-scanning list. Returns the mock so a test can read which URLs it saw. */
function stubGithub(): ReturnType<typeof vi.fn> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (String(url).endsWith('/access_tokens')) {
      return json({
        token: 'ghs_5188',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (String(url).includes('/contents/')) return new Response(FILE_TEXT, { status: 200 });
    if (String(url).includes('/code-scanning/analyses')) {
      return json([{ id: 42, tool: { name: 'CodeQL' }, created_at: '2026-09-01T00:00:00Z' }]);
    }
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// ── SITE 3 · `link_pull_request` / `unlink_pull_request` by coordinates ─────

describe('linking by COORDINATES, from a workspace that did NOT install the App', () => {
  it('⚠️ LINKS `moooon/motir-core#4101` — the defect, stated as what is now false', async () => {
    // THIS IS THE REPRODUCTION. The repository read asked the WORKSPACE, found
    // nothing in the sibling, and raised `GithubRepoNotFoundError` — so the one
    // door an agent has for linking a pull request was shut here.
    const item = await siblingItem();

    const { created } = await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: item.id,
        projectId: sibling.projectId,
        owner: 'moooon',
        name: 'motir-core',
        number: 4101,
        headRef: 'subtask/rate-limit',
        baseRef: 'main',
        title: 'Rate-limit the API',
      },
      sibling.ctx,
    );

    // The EXISTING row, not a second one: the read resolved the repository the
    // webhook ingested the pull request under.
    expect(created).toBe(false);
    expect(await deliveredItemIds(corePrId)).toEqual([item.id]);
  });

  it('UNLINKS it again by the same coordinates', async () => {
    const item = await siblingItem();
    await githubPullRequestService.linkPullRequest(item.id, corePrId, sibling.ctx);

    const result = await githubPullRequestService.unlinkPullRequestByCoordinates(
      {
        workItemId: item.id,
        projectId: sibling.projectId,
        owner: 'moooon',
        name: 'motir-core',
        number: 4101,
      },
      sibling.ctx,
    );

    expect(result).toEqual({ removed: true, pullRequestId: corePrId });
    expect(await deliveredItemIds(corePrId)).toEqual([]);
  });

  it('still raises `GithubRepoNotFoundError` for a DIFFERENT organisation`s repository, in both directions', async () => {
    const item = await siblingItem();
    const coords = { owner: 'zeta-labs', name: 'widgets', number: 4202 };

    await expect(
      githubPullRequestService.linkPullRequestByCoordinates(
        {
          workItemId: item.id,
          projectId: sibling.projectId,
          ...coords,
          headRef: 'subtask/rate-limit-rival',
          baseRef: 'main',
          title: null,
        },
        sibling.ctx,
      ),
    ).rejects.toBeInstanceOf(GithubRepoNotFoundError);
    await expect(
      githubPullRequestService.unlinkPullRequestByCoordinates(
        { workItemId: item.id, projectId: sibling.projectId, ...coords },
        sibling.ctx,
      ),
    ).rejects.toBeInstanceOf(GithubRepoNotFoundError);

    // …and org two's own reader links it — so the refusal above is a scoped
    // read, not a missing row.
    const rivalItem = await workItemsService.createWorkItem(
      { projectId: rival.projectId, kind: 'task', title: 'Rival card' },
      rival.ctx,
    );
    await githubPullRequestService.linkPullRequestByCoordinates(
      {
        workItemId: rivalItem.id,
        projectId: rival.projectId,
        ...coords,
        headRef: 'subtask/rate-limit-rival',
        baseRef: 'main',
        title: null,
      },
      rival.ctx,
    );
    expect(await deliveredItemIds(rivalPrId)).toEqual([rivalItem.id]);
  });
});

// ── SITE 4 · `repoFileReadService` — the silent `repo_not_connected` ────────

describe('reading a file, from a workspace that did NOT install the App', () => {
  it('⚠️ returns the file — not `repo_not_connected`, which was a false reason', async () => {
    stubGithub();

    const result = await repoFileReadService.readFile(sibling.ctx, 'moooon/motir-core', 'lib/x.ts');

    expect(result).toEqual({
      outcome: 'found',
      path: 'lib/x.ts',
      ref: 'main',
      text: FILE_TEXT,
      bytes: FILE_TEXT.length,
    });
  });

  it('still answers `repo_not_connected` for another organisation`s repository', async () => {
    const fetchMock = stubGithub();

    expect(
      await repoFileReadService.readFile(sibling.ctx, 'zeta-labs/widgets', 'lib/x.ts'),
    ).toEqual({ outcome: 'repo_not_connected', repoRef: 'zeta-labs/widgets' });
    // Refused before any credential was minted for it.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── SITE 5 · the code-scanning proxy — the silent `null` ────────────────────

describe('the code-scanning proxy, from a workspace that did NOT install the App', () => {
  it('⚠️ resolves org one`s repository and mints ITS installation`s token', async () => {
    const fetchMock = stubGithub();

    const analyses = await githubCodeScanningProxyService.listAnalyses(
      sibling.ctx,
      'moooon/motir-core',
    );

    expect(analyses).not.toBeNull();
    // The assertion is about WHICH row resolved: the mint names org one's
    // installation, and the read names the stored coordinates.
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes(`/app/installations/${INST_ONE}/access_tokens`))).toBe(true);
    expect(urls.some((u) => u.includes('/repos/moooon/motir-core/code-scanning/analyses'))).toBe(
      true,
    );
  });

  it('still degrades to null for another organisation`s repository, minting nothing', async () => {
    const fetchMock = stubGithub();

    expect(
      await githubCodeScanningProxyService.listAnalyses(sibling.ctx, 'zeta-labs/widgets'),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── The READ itself, at the repository layer under `motir_app` ──────────────

describe('githubRepoRepository.findConnectedByOrganizationAndName — under `motir_app`', () => {
  const siblingReader = () => ({
    userId: one.userId,
    workspaceId: one.siblingWorkspaceId,
  });

  it('admits the organisation`s repository to a SIBLING workspace, case-insensitively, with its installation', async () => {
    // No `app.organization_id` bound — the ordinary request path. What admits
    // the row is `github_repo_org_read`, and what admits the include is
    // `github_installation_org_read`; under the superuser both would be inert.
    const found = await asAppRole(siblingReader(), (tx) =>
      githubRepoRepository.findConnectedByOrganizationAndName(
        one.organizationId,
        'MOOOON',
        'Motir-Core',
        tx,
      ),
    );

    expect(found?.name).toBe('motir-core');
    expect(found?.organizationId).toBe(one.organizationId);
    expect(found?.installation.installationId).toBe(INST_ONE);
  });

  it('refuses ANOTHER organisation`s repository — and org two`s own reader proves the row exists', async () => {
    expect(
      await asAppRole(siblingReader(), (tx) =>
        githubRepoRepository.findConnectedByOrganizationAndName(
          two.organizationId,
          'zeta-labs',
          'widgets',
          tx,
        ),
      ),
    ).toBeNull();

    const theirs = await asAppRole(
      { userId: two.userId, workspaceId: two.siblingWorkspaceId },
      (tx) =>
        githubRepoRepository.findConnectedByOrganizationAndName(
          two.organizationId,
          'zeta-labs',
          'widgets',
          tx,
        ),
    );
    expect(theirs?.name).toBe('widgets');
  });

  it('⚠️ the RLS arm refuses on its own — asking for org two`s row BY org two`s id, as org one`s reader', async () => {
    // The `where` alone would admit this: the organisation id matches the row.
    // Only the policy refuses it, which is what this block exists to measure.
    const found = await asAppRole(siblingReader(), (tx) =>
      tx.githubRepo.findFirst({ where: { organizationId: two.organizationId } }),
    );
    expect(found).toBeNull();
  });

  it('leaves `findConnectedByWorkspaceAndName` answering the WORKSPACE question', async () => {
    // MOTIR-1931's tenancy invariant: which repositories were connected FROM
    // this workspace. Not widened in place — the sibling still gets nothing.
    expect(
      await asAppRole(siblingReader(), (tx) =>
        githubRepoRepository.findConnectedByWorkspaceAndName(
          one.siblingWorkspaceId,
          'moooon',
          'motir-core',
          tx,
        ),
      ),
    ).toBeNull();
    expect(
      (
        await asAppRole({ userId: one.userId, workspaceId: one.installingWorkspaceId }, (tx) =>
          githubRepoRepository.findConnectedByWorkspaceAndName(
            one.installingWorkspaceId,
            'moooon',
            'motir-core',
            tx,
          ),
        )
      )?.name,
    ).toBe('motir-core');
  });
});

describe('no write path is widened — the OTHER direction', () => {
  it('the INSTALLING workspace cannot update or delete a repository row the SIBLING owns', async () => {
    // The block above asserts sibling → installing. This is installing →
    // sibling, so the invariant is pinned both ways: the `FOR ALL` write arm
    // keys on the row's own `workspace_id`, whichever workspace that is.
    const installation = await adminDb.githubInstallation.findFirstOrThrow({
      where: { installationId: INST_ONE },
    });
    const owned = await adminDb.githubRepo.create({
      data: {
        installationId: installation.id,
        workspaceId: one.siblingWorkspaceId,
        organizationId: one.organizationId,
        repoId: '5188-sibling-owned',
        owner: 'moooon',
        name: 'sibling-owned',
        defaultBranch: 'main',
      },
    });
    const installingWriter = {
      userId: one.userId,
      workspaceId: one.installingWorkspaceId,
      organizationId: one.organizationId,
    };

    const touched = await asAppRole(installingWriter, (tx) =>
      tx.githubRepo.updateMany({ where: { id: owned.id }, data: { archived: true } }),
    );
    const deleted = await asAppRole(installingWriter, (tx) =>
      tx.githubRepo.deleteMany({ where: { id: owned.id } }),
    );

    expect(touched.count).toBe(0);
    expect(deleted.count).toBe(0);
    const after = await adminDb.githubRepo.findUniqueOrThrow({ where: { id: owned.id } });
    expect(after.archived).toBe(false);
  });
});
