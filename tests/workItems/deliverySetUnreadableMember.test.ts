import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPr } from '../helpers/prLink';
import { randomToken } from '../helpers/random';

// A DELIVERY whose pull request the reader cannot see (Bug MOTIR-8215).
//
// Production threw `TypeError: Cannot read properties of null (reading
// 'checkRuns')` out of `toWorkItemDeliveryDto`, on the peek, the item page and
// the approval-gate overlay alike — every read surface goes through
// `listDeliverySet`. The delivery row is keyed on the CARD's workspace, while the
// pull request and the repository are read through `github_repo`'s policies,
// which admit the reader's organisation. So when the repository row stops
// belonging to that organisation the delivery row stays visible and the
// relation it joins comes back NULL — a `null` the generated type says cannot
// happen.
//
// The state used to arise from a shipped path: `persistInstallation` re-stamped
// a repository's tenancy when a second organisation connected the same
// installation. That path is gone — a repository belongs to ONE organisation and
// is never re-stamped (MOTIR-8218 / MOTIR-8219) — so the state is now written by
// hand: the pull request is re-homed onto another organisation's repository. The
// read stays defensive, because a NULL join is still what the reader would get.

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

const INSTALLATION = { accountLogin: 'moooon', accountType: 'Organization' };

function repo(providerRepoId: string, name: string) {
  return {
    providerRepoId,
    owner: 'moooon',
    name,
    defaultBranch: 'main',
    archived: false,
  };
}

/** Move pull request `number` on `providerRepoId` onto `to`'s copy of a repository. */
async function rehomePullRequest(
  number: number,
  providerRepoId: string,
  to: WorkItemFixture,
  toProviderRepoId: string,
): Promise<void> {
  const target = await adminDb.githubRepo.findFirstOrThrow({
    where: { repoId: toProviderRepoId, workspaceId: to.workspaceId },
  });
  await adminDb.githubPullRequest.updateMany({
    where: { number, repo: { repoId: providerRepoId } },
    data: { repoId: target.id },
  });
}

async function connect(
  fx: WorkItemFixture,
  installationId: string,
  repos: ReturnType<typeof repo>[],
): Promise<void> {
  await githubInstallationService.persistInstallation({
    workspaceId: fx.workspaceId,
    installation: { installationId, ...INSTALLATION },
    repos,
  });
}

describe('a delivery whose pull request the reader cannot see', () => {
  it('reads the rest of the delivery set instead of throwing', async () => {
    const ours = await makeWorkItemFixture({ name: 'Ours' });
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THEM' });
    expect(theirs.workspace.organizationId).not.toBe(ours.workspace.organizationId);

    const installationId = `inst-${randomToken(6)}`;
    const shared = repo(`r-${randomToken(6)}`, 'motir-core');
    const kept = repo(`r-${randomToken(6)}`, 'motir-ai');
    // Two installations, as before: the read is per repository.
    const ownInstallationId = `inst-${randomToken(6)}`;
    await connect(ours, installationId, [shared]);
    await connect(ours, ownInstallationId, [kept]);

    const card = await createTestWorkItem(ours, { kind: 'task', title: 'delivered twice' });
    for (const [name, number] of [
      ['motir-core', 41],
      ['motir-ai', 42],
    ] as const) {
      await linkPr(
        {
          workItemId: card.id,
          projectId: ours.projectId,
          owner: 'moooon',
          name,
          number,
          headRef: `subtask/PROD-1-${name}`,
        },
        ours.ctx,
      );
    }
    expect(await workItemsService.listDeliverySet(card.id, ours.ctx)).toHaveLength(2);

    // The pull request now lives on another organisation's repository.
    const elsewhere = repo(`r-${randomToken(6)}`, 'motir-core');
    await connect(theirs, `inst-${randomToken(6)}`, [elsewhere]);
    await rehomePullRequest(41, shared.providerRepoId, theirs, elsewhere.providerRepoId);

    const set = await workItemsService.listDeliverySet(card.id, ours.ctx);
    expect(set.map((d) => d.pullRequest.number)).toEqual([42]);

    // The delivery row itself is untouched: what changed is what this reader
    // may see, and the read reports that rather than deleting anything.
    expect(await adminDb.workItemDelivery.count({ where: { workItemId: card.id } })).toBe(2);
  });

  it('answers the whole delivery VIEW — repositories and set — for the card', async () => {
    const ours = await makeWorkItemFixture({ name: 'Ours' });
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THEM' });
    const installationId = `inst-${randomToken(6)}`;
    const shared = repo(`r-${randomToken(6)}`, 'motir-core');
    await connect(ours, installationId, [shared]);

    const card = await createTestWorkItem(ours, { kind: 'task', title: 'delivered once' });
    await linkPr(
      {
        workItemId: card.id,
        projectId: ours.projectId,
        owner: 'moooon',
        name: 'motir-core',
        number: 7,
        headRef: 'subtask/PROD-1-core',
      },
      ours.ctx,
    );
    const elsewhere = repo(`r-${randomToken(6)}`, 'motir-core');
    await connect(theirs, `inst-${randomToken(6)}`, [elsewhere]);
    await rehomePullRequest(7, shared.providerRepoId, theirs, elsewhere.providerRepoId);

    const view = await workItemsService.getDeliveryView(card.id, [], ours.ctx);
    expect(view.deliveries).toEqual([]);
  });
});
