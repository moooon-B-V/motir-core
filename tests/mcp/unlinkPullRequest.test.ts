import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { runLinkPullRequest } from '@/lib/mcp/tools/linkPullRequest';
import { runUnlinkPullRequest } from '@/lib/mcp/tools/unlinkPullRequest';
import { toolPermission } from '@/lib/mcp/toolPermissions';
import { CLI_TOKEN_GRANT } from '@/lib/mcp/toolPermissions';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-3756 — the suite for `unlink_pull_request`, the correction door.
//
// ⚠️ EVERY CASE ENTERS AT `runUnlinkPullRequest`, the tool ADAPTER, for the
// reason its sibling suite gives: the coordinate parsing, the two-address
// cross-check and the typed-error mapping are things an AGENT meets, and calling
// the service directly would skip exactly the layer a caller talks to.
//
// The cases are chosen because the obvious way to write each one passes under a
// broken implementation:
//
//   1. THE MIS-LINK PATH is asserted on THREE cards at once. A test that
//      unlinks the only delivery of a pull request passes against a `deleteMany`
//      keyed on the pull request alone — which would retract the pull request
//      from every card it delivers, silently, and is precisely the failure a
//      correction door must not have.
//   2. `removed: false` is asserted to be DISTINCT from a refusal. A typo in the
//      coordinate and a link that was never made are opposite facts; reporting
//      the first as a successful nothing lets a caller believe a mis-link was
//      corrected while it stands.
//   3. THE LEGACY COLUMN is asserted UNCHANGED. Its drop is the CONTRACT card's,
//      and clearing it here would take a delivery's status sync away from a card
//      whose OTHER links are perfectly good.
//   4. THE PERMISSION is asserted to be the SAME KEY the link tool declares, off
//      the constant rather than by re-stating it — a correction door a token
//      cannot reach while it CAN reach the door that creates the mistake is
//      strictly worse than no door at all.

const PASSWORD = 'hunter2hunter2';
const OWNER = 'moooon';
const INST = 'inst-unlink-pr';

interface Scenario {
  ctx: ServiceContext;
  projectId: string;
  workspaceId: string;
  repo: string;
  repoRowId: string;
}

/** A tenant with ONE repo, behind an installation bound to NO workspace — the
 *  shared provisioning shape (MOTIR-1931), so the tenancy under test is the repo
 *  row's own `workspace_id` and never a join through its installation. */
async function makeScenario(opts: {
  email: string;
  identifier: string;
  repoName: string;
  repoHostId: string;
}): Promise<Scenario> {
  const user = await usersService.createUser({
    email: opts.email,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${opts.identifier}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: `Project ${opts.identifier}`,
    identifier: opts.identifier,
  });
  const installation = await adminDb.githubInstallation.upsert({
    where: { installationId: `${INST}-${opts.identifier}` },
    create: {
      installationId: `${INST}-${opts.identifier}`,
      workspaceId: null,
      accountLogin: OWNER,
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: installation.id,
      workspaceId: workspace.id,
      repoId: opts.repoHostId,
      owner: OWNER,
      name: opts.repoName,
      defaultBranch: 'main',
      archived: false,
      provider: 'github',
    },
  });
  return {
    ctx: { userId: user.id, workspaceId: workspace.id },
    projectId: project.id,
    workspaceId: workspace.id,
    repo: `${OWNER}/${opts.repoName}`,
    repoRowId: repo.id,
  };
}

async function makeItem(s: Scenario, title: string): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: s.projectId, kind: 'task', title },
    s.ctx,
  );
  return { id: item.id, identifier: item.identifier };
}

function structured(res: CallToolResult): Record<string, unknown> {
  return (res.structuredContent ?? {}) as Record<string, unknown>;
}

function text(res: CallToolResult): string {
  return (res.content ?? []).map((c) => (c as { text?: string }).text ?? '').join('\n');
}

/** `link_pull_request` through its own tool adapter — the door that MAKES the
 *  mistake this suite corrects, so the fixture uses it rather than writing rows. */
async function link(s: Scenario, key: string, number: number): Promise<CallToolResult> {
  return runLinkPullRequest(
    {
      key,
      repository: s.repo,
      number,
      headRef: 'motir/auto-run-1',
      baseRef: 'main',
      title: 'A session run',
    },
    s.ctx,
  );
}

/** Every card a pull request delivers, read back through the repository. */
async function deliveredCards(s: Scenario, number: number): Promise<string[]> {
  const pr = await adminDb.githubPullRequest.findFirstOrThrow({
    where: { repoId: s.repoRowId, number },
  });
  const rows = await withWorkspaceContext(s.ctx, (tx) =>
    workItemDeliveryRepository.listByPullRequest(pr.id, tx),
  );
  return rows.map((r) => r.workItemId);
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('block 1 — the mis-link-then-correct path removes EXACTLY ONE delivery', () => {
  it('takes the pull request off the wrong card and leaves every other card it delivers', async () => {
    const s = await makeScenario({
      email: 'unlink-one@example.com',
      identifier: 'UNL',
      repoName: 'core',
      repoHostId: '9701',
    });
    const wrong = await makeItem(s, 'The card the run linked by mistake');
    const right = await makeItem(s, 'The card it actually delivers');
    const bystander = await makeItem(s, 'Another card on the same run');

    await link(s, wrong.identifier, 900);
    await link(s, bystander.identifier, 900);
    // The "correction" that is not one: linking the right card ADDS a row and the
    // mistaken one stays. This is the whole reason the tool exists.
    await link(s, right.identifier, 900);
    expect((await deliveredCards(s, 900)).sort()).toEqual(
      [wrong.id, bystander.id, right.id].sort(),
    );

    const res = await runUnlinkPullRequest(
      { key: wrong.identifier, repository: s.repo, number: 900 },
      s.ctx,
    );

    expect(res.isError).toBeFalsy();
    expect(structured(res)).toMatchObject({
      key: wrong.identifier,
      removed: true,
      pullRequest: `${s.repo}#900`,
    });
    expect(text(res)).toContain('Unlinked');
    // ONE row gone; the other two untouched. Asserted as a SET rather than a
    // count, because a `deleteMany` keyed on the pull request alone would leave a
    // correct-looking count of zero and retract it from everybody.
    expect((await deliveredCards(s, 900)).sort()).toEqual([bystander.id, right.id].sort());
  });

  it('takes ONE pull request off a card delivered by two, leaving the other', async () => {
    const s = await makeScenario({
      email: 'unlink-multi-pr@example.com',
      identifier: 'UNM',
      repoName: 'core',
      repoHostId: '9702',
    });
    const card = await makeItem(s, 'A card delivered by two pull requests');
    await link(s, card.identifier, 910);
    await link(s, card.identifier, 911);

    await runUnlinkPullRequest({ key: card.identifier, repository: s.repo, number: 910 }, s.ctx);

    expect(await deliveredCards(s, 910)).toEqual([]);
    expect(await deliveredCards(s, 911)).toEqual([card.id]);
  });
});

describe('block 2 — `removed: false` is an ANSWER; a bad coordinate is a REFUSAL', () => {
  it('answers `removed: false` when the pull request and the item both exist but were never linked', async () => {
    const s = await makeScenario({
      email: 'unlink-noop@example.com',
      identifier: 'UNN',
      repoName: 'core',
      repoHostId: '9703',
    });
    const linked = await makeItem(s, 'The card that IS linked');
    const other = await makeItem(s, 'A card that never linked it');
    await link(s, linked.identifier, 920);

    const res = await runUnlinkPullRequest(
      { key: other.identifier, repository: s.repo, number: 920 },
      s.ctx,
    );

    expect(res.isError).toBeFalsy();
    expect(structured(res).removed).toBe(false);
    expect(text(res)).toContain('nothing to remove');
    // …and the real link is untouched: a no-op must not be a retraction.
    expect(await deliveredCards(s, 920)).toEqual([linked.id]);
  });

  it('REFUSES an unknown pull-request number rather than answering `removed: false`', async () => {
    const s = await makeScenario({
      email: 'unlink-unknown-pr@example.com',
      identifier: 'UNP',
      repoName: 'core',
      repoHostId: '9704',
    });
    const card = await makeItem(s, 'A card');

    const res = await runUnlinkPullRequest(
      { key: card.identifier, repository: s.repo, number: 999 },
      s.ctx,
    );

    // The distinction this asserts: a typo and a link that was never made look
    // identical to a caller reading only `removed`, and only one of them means
    // the mis-link is corrected.
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('999');
  });

  it('REFUSES an unknown repository, with no existence leak', async () => {
    const s = await makeScenario({
      email: 'unlink-unknown-repo@example.com',
      identifier: 'UNR',
      repoName: 'core',
      repoHostId: '9705',
    });
    const card = await makeItem(s, 'A card');

    const res = await runUnlinkPullRequest(
      { key: card.identifier, repository: `${OWNER}/not-connected`, number: 1 },
      s.ctx,
    );
    expect(res.isError).toBe(true);
  });

  it('refuses an ADDRESS that is malformed or self-contradictory, before touching anything', async () => {
    const s = await makeScenario({
      email: 'unlink-address@example.com',
      identifier: 'UNA',
      repoName: 'core',
      repoHostId: '9706',
    });
    const card = await makeItem(s, 'A card');
    await link(s, card.identifier, 930);

    // No address at all.
    const none = await runUnlinkPullRequest({ key: card.identifier }, s.ctx);
    expect(none.isError).toBe(true);
    expect(text(none)).toContain('INVALID_PULL_REQUEST_REF');

    // Two addresses that DISAGREE — refused rather than resolved by preferring
    // one, because picking arbitrarily would unlink a real pull request that is
    // not the one the caller meant, under a success message.
    const conflict = await runUnlinkPullRequest(
      {
        key: card.identifier,
        repository: s.repo,
        number: 930,
        url: `https://github.com/${s.repo}/pull/931`,
      },
      s.ctx,
    );
    expect(conflict.isError).toBe(true);
    expect(text(conflict)).toContain('INVALID_PULL_REQUEST_REF');

    // Nothing was removed by either refusal.
    expect(await deliveredCards(s, 930)).toEqual([card.id]);
  });

  it('accepts the `url` form, the same one `gh pr create` prints', async () => {
    const s = await makeScenario({
      email: 'unlink-url@example.com',
      identifier: 'UNU',
      repoName: 'core',
      repoHostId: '9707',
    });
    const card = await makeItem(s, 'A card addressed by URL');
    await link(s, card.identifier, 940);

    const res = await runUnlinkPullRequest(
      { key: card.identifier, url: `https://github.com/${s.repo}/pull/940` },
      s.ctx,
    );
    expect(structured(res).removed).toBe(true);
    expect(await deliveredCards(s, 940)).toEqual([]);
  });
});

describe('block 3 — the pull-request row, and the cards that are not this one', () => {
  // The predecessor of this case was *leaves `github_pull_request.work_item_id`
  // exactly as it stands* — correct while that column existed and its drop was
  // still the CONTRACT card's. MOTIR-3757 dropped it, so what remains to assert is
  // that unlinking corrects an ASSOCIATION and touches nothing else on the row.
  it('leaves the mirrored pull request exactly as it stands', async () => {
    const s = await makeScenario({
      email: 'unlink-column@example.com',
      identifier: 'UNC',
      repoName: 'core',
      repoHostId: '9708',
    });
    const card = await makeItem(s, 'A card whose column survives');
    await link(s, card.identifier, 950);

    const before = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 950 },
    });
    expect(await deliveredCards(s, 950)).toEqual([card.id]);

    await runUnlinkPullRequest({ key: card.identifier, repository: s.repo, number: 950 }, s.ctx);

    const after = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 950 },
    });
    // The delivery is gone and the MIRROR ROW is not — `linked_manually` included,
    // which is the record that a link was once DECLARED here and survives the
    // link's removal exactly as it survived the column's drop.
    expect(await deliveredCards(s, 950)).toEqual([]);
    expect(after.linkedManually).toBe(true);
    // The pull request itself is the webhook's to describe, not the caller's.
    expect(after.state).toBe(before.state);
    expect(after.merged).toBe(before.merged);
    expect(after.title).toBe(before.title);
  });

  it('refuses an item in ANOTHER workspace as not-found, leaking nothing', async () => {
    const a = await makeScenario({
      email: 'unlink-tenant-a@example.com',
      identifier: 'UTA',
      repoName: 'core',
      repoHostId: '9709',
    });
    const b = await makeScenario({
      email: 'unlink-tenant-b@example.com',
      identifier: 'UTB',
      repoName: 'core',
      repoHostId: '9710',
    });
    const cardA = await makeItem(a, "A's card");
    await link(a, cardA.identifier, 960);

    // B asks to unlink A's card from A's repository, with B's context.
    const res = await runUnlinkPullRequest(
      { key: cardA.identifier, repository: a.repo, number: 960 },
      b.ctx,
    );
    expect(res.isError).toBe(true);
    // A's delivery is intact.
    expect(await deliveredCards(a, 960)).toEqual([cardA.id]);
  });
});

describe('block 4 — the permission is the SAME KEY the link tool declares', () => {
  it('asserts `work_item:edit`, read off the constant rather than restated', () => {
    expect(toolPermission('unlink_pull_request')).toBe(toolPermission('link_pull_request'));
    expect(toolPermission('unlink_pull_request')).toBe('work_item:edit');
  });

  it('is reachable by a CLI-minted token — the actor that makes the mistake', () => {
    // A correction door a dispatched agent cannot reach, while it CAN reach the
    // door that creates the mistake, is strictly worse than no door at all. This
    // asserts nothing is widened either: the key was already in the grant.
    expect(CLI_TOKEN_GRANT).toContain(toolPermission('unlink_pull_request'));
  });
});
