import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { runLinkPullRequest, resolveCoordinate } from '@/lib/mcp/tools/linkPullRequest';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story MOTIR-3525 · Subtask MOTIR-3528 — the suite for `link_pull_request`.
//
// Blocks 1–5 live here; block 6 (the CLI token actually REACHING the tool
// through the real transport) is `linkPullRequestTransport.test.ts`, the same
// split MOTIR-3480/-3481 used, because the two need different harnesses.
//
// ⚠️ EVERY CASE ENTERS AT `runLinkPullRequest`, the tool adapter — not at the
// service. The coordinate parsing, the two-address cross-check and the typed-
// error mapping are all things an agent meets, and calling the service directly
// would skip exactly the layer a caller talks to.
//
// The blocks are chosen because the natural way to write each one PASSES under a
// broken implementation:
//
//   1. PRE-DELIVERY — asserted on a `(repo, number)` with NO row. The picker
//      cannot reach this case at all, so it has no coverage anywhere else, and a
//      test that ingests first would pass against a tool that requires the row.
//   2. CONVERGENCE — asserted in BOTH directions on ONE delivery: the state
//      fields must MOVE and `work_item_id` must NOT. Checking either alone
//      passes against an implementation that writes everything or nothing.
//   4. IDEMPOTENCY — asserted by ROW COUNT as well as by value: a second call
//      that duplicated the row would still leave a correct-looking link.
//   5. TENANCY — asserted against a repo row whose installation names NO
//      workspace (Motir's shared provisioning shape), because that is the
//      configuration MOTIR-1931 showed the old installation-join rejected while
//      looking correct.

const PASSWORD = 'hunter2hunter2';
const OWNER = 'moooon';

interface Scenario {
  ctx: ServiceContext;
  projectId: string;
  workspaceId: string;
  /** `owner/name` of the repo connected in THIS workspace. */
  repo: string;
  repoRowId: string;
  repoHostId: string;
  installationId: string;
}

/**
 * A tenant with ONE repo, connected behind an installation bound to NO workspace
 * — Motir's shared provisioning shape (MOTIR-1931). The repo row carries its own
 * `workspace_id`, which is the tenancy the link path must read.
 */
async function makeScenario(opts: {
  email: string;
  identifier: string;
  repoName: string;
  repoHostId: string;
  installationId: string;
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
    where: { installationId: opts.installationId },
    create: {
      installationId: opts.installationId,
      // ⚠️ NULL — the whole point. The link path must resolve the repo from the
      // REPO ROW's workspace, never through here.
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
    repoHostId: opts.repoHostId,
    installationId: opts.installationId,
  };
}

async function makeItem(s: Scenario, title: string): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: s.projectId, kind: 'task', title },
    s.ctx,
  );
  return { id: item.id, identifier: item.identifier };
}

/** A `pull_request` delivery, as GitHub sends one. */
function prEvent(opts: {
  installationId: string;
  repoHostId: string;
  number: number;
  headBranch: string;
  title: string;
  baseBranch?: string;
  action?: string;
  state?: string;
  merged?: boolean;
}) {
  return {
    action: opts.action ?? 'opened',
    installation: { id: opts.installationId, account: { login: OWNER, type: 'Organization' } },
    repository: { id: Number(opts.repoHostId) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: opts.title,
      head: { ref: opts.headBranch },
      base: { ref: opts.baseBranch ?? 'main' },
      user: { id: 4242 },
    },
  };
}

function structured(res: CallToolResult): Record<string, unknown> {
  return (res.structuredContent ?? {}) as Record<string, unknown>;
}

function text(res: CallToolResult): string {
  return (res.content ?? []).map((c) => (c as { text?: string }).text ?? '').join('\n');
}

/** Call the tool the way an agent does, with the fields it holds after
 *  `gh pr create`. */
async function link(
  s: Scenario,
  args: Record<string, unknown>,
  ctx: ServiceContext = s.ctx,
): Promise<CallToolResult> {
  return runLinkPullRequest(
    {
      headRef: 'subtask/MOTIR-1-widget',
      baseRef: 'main',
      ...args,
    } as Parameters<typeof runLinkPullRequest>[0],
    ctx,
  );
}

const INST_A = 'inst-link-pr-a';
const INST_B = 'inst-link-pr-b';

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── BLOCK 1 ───────────────────────────────────────────────────────────────
describe('block 1 — the PRE-DELIVERY link: the row can be created by the call itself', () => {
  it('creates the (repo_id, number) row with the caller’s fields and linked_manually = true when no delivery has arrived', async () => {
    const s = await makeScenario({
      email: 'pre-delivery@example.com',
      identifier: 'PRE',
      repoName: 'alpha',
      repoHostId: '910001',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'Ship the linking door');

    // The precondition that makes this case the one the picker cannot reach.
    expect(await adminDb.githubPullRequest.count({ where: { repoId: s.repoRowId } })).toBe(0);

    const res = await link(s, {
      key: item.identifier,
      repository: s.repo,
      number: 42,
      headRef: 'subtask/MOTIR-3526-link',
      baseRef: 'main',
      title: 'feat(mcp): link_pull_request',
    });

    expect(res.isError).toBeFalsy();
    expect(structured(res)).toMatchObject({ key: item.identifier, created: true, movedFrom: null });

    const row = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 42 },
    });
    expect(row.workItemId).toBe(item.id);
    expect(row.linkedManually).toBe(true);
    expect(row.state).toBe('open');
    expect(row.merged).toBe(false);
    expect(row.headRef).toBe('subtask/MOTIR-3526-link');
    expect(row.baseRef).toBe('main');
    expect(row.title).toBe('feat(mcp): link_pull_request');
  });

  it('the work item’s Development read returns the link the call just declared', async () => {
    const s = await makeScenario({
      email: 'dev-read@example.com',
      identifier: 'DEV',
      repoName: 'alpha',
      repoHostId: '910002',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'Rendered on the card');
    await link(s, { key: item.identifier, url: `https://github.com/${s.repo}/pull/7` });

    // The SAME read the item page's Development section renders from.
    const created = await adminDb.workItem.findFirstOrThrow({
      where: { identifier: item.identifier },
    });
    const rendered = await workItemsService.listLinkedPullRequests(created.id, s.ctx);
    expect(rendered).toEqual([
      expect.objectContaining({ number: 7, repo: s.repo, linkedManually: true }),
    ]);
  });

  it('the URL `gh pr create` prints is accepted verbatim, and disagreeing addresses are REFUSED rather than ranked', async () => {
    const s = await makeScenario({
      email: 'address@example.com',
      identifier: 'ADR',
      repoName: 'alpha',
      repoHostId: '910003',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'Address forms');

    // Both forms, agreeing — accepted.
    const ok = await link(s, {
      key: item.identifier,
      url: `https://github.com/${s.repo}/pull/11`,
      repository: s.repo,
      number: 11,
    });
    expect(ok.isError).toBeFalsy();

    // Both forms, DISAGREEING — refused. Picking one arbitrarily would link a
    // real pull request that is not the one the caller meant, under a success.
    const clash = await link(s, {
      key: item.identifier,
      url: `https://github.com/${s.repo}/pull/11`,
      repository: s.repo,
      number: 12,
    });
    expect(clash.isError).toBe(true);
    expect(text(clash)).toContain('INVALID_PULL_REQUEST_REF');

    // Only the agreeing call wrote anything.
    expect(await adminDb.githubPullRequest.count({ where: { repoId: s.repoRowId } })).toBe(1);
  });

  it('rejects every malformed address in one hop, naming what is wrong', () => {
    // Pure, so asserted directly — these are the arms an agent self-corrects on.
    expect(resolveCoordinate({})).toMatchObject({ ok: false });
    expect(resolveCoordinate({ repository: 'acme/web' })).toMatchObject({ ok: false });
    expect(resolveCoordinate({ number: 7 })).toMatchObject({ ok: false });
    expect(resolveCoordinate({ repository: 'acme', number: 7 })).toMatchObject({ ok: false });
    expect(resolveCoordinate({ url: 'https://github.com/acme/web/issues/7' })).toMatchObject({
      ok: false,
    });
    expect(resolveCoordinate({ url: 'not a url' })).toMatchObject({ ok: false });
    // A URL with a trailing path/fragment still resolves — `gh` prints bare
    // ones, browsers copy `/files` and `#discussion_r…`.
    expect(resolveCoordinate({ url: 'https://github.com/acme/web/pull/7/files' })).toMatchObject({
      ok: true,
      owner: 'acme',
      name: 'web',
      number: 7,
    });
    // A self-hosted GitHub Enterprise host serves the same path shape.
    expect(resolveCoordinate({ url: 'https://git.acme.internal/acme/web/pull/9' })).toMatchObject({
      ok: true,
      owner: 'acme',
      name: 'web',
      number: 9,
    });
  });
});

// ── BLOCK 2 ───────────────────────────────────────────────────────────────
describe('block 2 — the webhook CONVERGES on the declared link rather than fighting it', () => {
  it('a later delivery takes the state fields and leaves work_item_id alone', async () => {
    const s = await makeScenario({
      email: 'converge@example.com',
      identifier: 'CNV',
      repoName: 'alpha',
      repoHostId: '920001',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'Converge target');

    await link(s, {
      key: item.identifier,
      repository: s.repo,
      number: 88,
      headRef: 'subtask/guessed-by-the-agent',
      baseRef: 'main',
      title: 'the agent’s title',
    });

    // A REAL delivery for the same (repo, number) — through the webhook service,
    // which is what calls `syncChangeRequestStatus`. Its branch and title name
    // NO key at all, so the parse would resolve nothing.
    //
    // `reopened` rather than `edited`: `HANDLED_PR_ACTIONS` is
    // `{opened, reopened, closed}`, so an `edited` delivery is dropped before
    // the sync and this whole assertion would be vacuous.
    await githubWebhookService.handleEvent(
      'pull_request',
      prEvent({
        installationId: s.installationId,
        repoHostId: s.repoHostId,
        number: 88,
        headBranch: 'renamed-by-github',
        baseBranch: 'main',
        title: 'the delivery’s title',
        action: 'reopened',
      }),
    );

    const row = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 88 },
    });
    // BOTH directions on ONE delivery — the state MOVED…
    expect(row.headRef).toBe('renamed-by-github');
    expect(row.title).toBe('the delivery’s title');
    expect(row.state).toBe('open');
    expect(row.merged).toBe(false);
    // …and the LINK did not.
    expect(row.workItemId).toBe(item.id);
    expect(row.linkedManually).toBe(true);
  });

  it('a merge whose branch and title name NO key still moves the card — the point of the story', async () => {
    const s = await makeScenario({
      email: 'merge-no-key@example.com',
      identifier: 'MRG',
      repoName: 'alpha',
      repoHostId: '920002',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'Closed by a nameless pull request');

    await link(s, {
      key: item.identifier,
      repository: s.repo,
      number: 99,
      headRef: 'nothing-here-names-a-card',
      baseRef: 'main',
      title: 'nor does this title',
    });
    // Walk to a status from which the merge's Done hop is workflow-legal.
    await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
    await workItemsService.updateStatus(item.id, 'implemented', s.ctx);

    await githubWebhookService.handleEvent(
      'pull_request',
      prEvent({
        installationId: s.installationId,
        repoHostId: s.repoHostId,
        number: 99,
        headBranch: 'nothing-here-names-a-card',
        baseBranch: 'main',
        title: 'nor does this title',
        action: 'closed',
        state: 'closed',
        merged: true,
      }),
    );

    const moved = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(moved.status).toBe('done');
    const row = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 99 },
    });
    expect(row.merged).toBe(true);
    expect(row.workItemId).toBe(item.id);
    expect(row.linkedManually).toBe(true);
  });
});

// ── BLOCK 3 ───────────────────────────────────────────────────────────────
describe('block 3 — the branch/title PARSE still resolves, untouched', () => {
  it('a pull request that names its key and was never linked resolves as before, linked_manually = false', async () => {
    const s = await makeScenario({
      email: 'parse-intact@example.com',
      identifier: 'PRS',
      repoName: 'alpha',
      repoHostId: '930001',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'Resolved by the parse');

    await githubWebhookService.handleEvent(
      'pull_request',
      prEvent({
        installationId: s.installationId,
        repoHostId: s.repoHostId,
        number: 5,
        headBranch: `subtask/${item.identifier}-parsed`,
        title: 'Opened by a person in a browser',
      }),
    );

    const row = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 5 },
    });
    expect(row.workItemId).toBe(item.id);
    // The discriminator: this link came from the PARSE, so it is NOT sticky —
    // which is what keeps the fallback a fallback.
    expect(row.linkedManually).toBe(false);
  });
});

// ── BLOCK 4 ───────────────────────────────────────────────────────────────
describe('block 4 — idempotency, the move, and the (repo_id, number) race', () => {
  it('a repeat call CONVERGES — same row, no duplicate', async () => {
    const s = await makeScenario({
      email: 'idempotent@example.com',
      identifier: 'IDM',
      repoName: 'alpha',
      repoHostId: '940001',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'Called twice');

    const first = await link(s, { key: item.identifier, repository: s.repo, number: 3 });
    const second = await link(s, { key: item.identifier, repository: s.repo, number: 3 });

    expect(first.isError).toBeFalsy();
    expect(second.isError).toBeFalsy();
    // The SECOND call found a row, so it created nothing — and said so.
    expect(structured(first)).toMatchObject({ created: true, movedFrom: null });
    expect(structured(second)).toMatchObject({ created: false, movedFrom: null });
    // Asserted by COUNT as well as by value: a duplicate would still leave a
    // correct-looking link on one of the two rows.
    expect(await adminDb.githubPullRequest.count({ where: { repoId: s.repoRowId } })).toBe(1);
  });

  it('a second call naming a DIFFERENT item MOVES the link, and the result says so', async () => {
    const s = await makeScenario({
      email: 'moves@example.com',
      identifier: 'MOV',
      repoName: 'alpha',
      repoHostId: '940002',
      installationId: INST_A,
    });
    const a = await makeItem(s, 'Item A');
    const b = await makeItem(s, 'Item B');

    await link(s, { key: a.identifier, repository: s.repo, number: 4 });
    const moved = await link(s, { key: b.identifier, repository: s.repo, number: 4 });

    expect(structured(moved)).toMatchObject({
      key: b.identifier,
      created: false,
      movedFrom: a.identifier,
    });
    // The human-readable half says MOVED too — an agent reading the text block
    // must not read a move as an addition either.
    expect(text(moved)).toContain('MOVED');
    const row = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 4 },
    });
    expect(row.workItemId).toBe(b.id);
    expect(row.linkedManually).toBe(true);
  });

  it('two CONCURRENT calls for the same (repo, number) converge on one row', async () => {
    const s = await makeScenario({
      email: 'race@example.com',
      identifier: 'RCE',
      repoName: 'alpha',
      repoHostId: '940003',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'Raced');

    const [one, two] = await Promise.all([
      link(s, { key: item.identifier, repository: s.repo, number: 6 }),
      link(s, { key: item.identifier, repository: s.repo, number: 6 }),
    ]);

    expect(one.isError).toBeFalsy();
    expect(two.isError).toBeFalsy();
    expect(await adminDb.githubPullRequest.count({ where: { repoId: s.repoRowId } })).toBe(1);
    const row = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 6 },
    });
    expect(row.workItemId).toBe(item.id);
    expect(row.linkedManually).toBe(true);
  });
});

// ── BLOCK 5 ───────────────────────────────────────────────────────────────
describe('block 5 — tenancy, gated on the REPO ROW and leaking no existence', () => {
  it('a repository connected in ANOTHER workspace reads as not connected here', async () => {
    const other = await makeScenario({
      email: 'tenancy-other@example.com',
      identifier: 'OTH',
      repoName: 'private-thing',
      repoHostId: '950001',
      installationId: INST_A,
    });
    const mine = await makeScenario({
      email: 'tenancy-mine@example.com',
      identifier: 'MIN',
      repoName: 'alpha',
      repoHostId: '950002',
      installationId: INST_B,
    });
    const item = await makeItem(mine, 'Mine');

    const res = await link(mine, {
      key: item.identifier,
      repository: other.repo,
      number: 1,
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('GITHUB_REPO_NOT_FOUND');
    // Nothing was written into the other tenant.
    expect(await adminDb.githubPullRequest.count({ where: { repoId: other.repoRowId } })).toBe(0);
  });

  it('an unknown repository reads EXACTLY like a cross-workspace one — no existence leak', async () => {
    const other = await makeScenario({
      email: 'leak-other@example.com',
      identifier: 'LKO',
      repoName: 'private-thing',
      repoHostId: '950003',
      installationId: INST_A,
    });
    const mine = await makeScenario({
      email: 'leak-mine@example.com',
      identifier: 'LKM',
      repoName: 'alpha',
      repoHostId: '950004',
      installationId: INST_B,
    });
    const item = await makeItem(mine, 'Mine');

    const crossWorkspace = await link(mine, {
      key: item.identifier,
      repository: other.repo,
      number: 1,
    });
    const absent = await link(mine, {
      key: item.identifier,
      repository: `${OWNER}/no-such-repository-anywhere`,
      number: 1,
    });
    // Asserted by COMPARING them: checking either alone passes against an
    // implementation that answers "forbidden" for one and "absent" for the
    // other, which is the leak.
    expect(text(crossWorkspace).replace(other.repo, 'X')).toBe(
      text(absent).replace(`${OWNER}/no-such-repository-anywhere`, 'X'),
    );
  });

  it('an item key in another workspace is refused BEFORE the repository is looked at', async () => {
    const other = await makeScenario({
      email: 'item-other@example.com',
      identifier: 'ITO',
      repoName: 'beta',
      repoHostId: '950005',
      installationId: INST_A,
    });
    const mine = await makeScenario({
      email: 'item-mine@example.com',
      identifier: 'ITM',
      repoName: 'alpha',
      repoHostId: '950006',
      installationId: INST_B,
    });
    const theirs = await makeItem(other, 'Theirs');

    const res = await link(mine, {
      key: theirs.identifier,
      repository: mine.repo,
      number: 1,
    });
    expect(res.isError).toBe(true);
    // The ITEM's not-found, not the repository's — the caller learns nothing
    // about a card in a workspace it cannot see.
    expect(text(res)).not.toContain('GITHUB_REPO_NOT_FOUND');
    expect(await adminDb.githubPullRequest.count({ where: { repoId: mine.repoRowId } })).toBe(0);
  });

  it('a repository behind an installation bound to NO workspace still resolves — the MOTIR-1931 shape', async () => {
    // Every scenario in this file is already that shape; asserting it directly
    // is what makes the rest of the suite meaningful rather than incidental.
    const s = await makeScenario({
      email: 'provisioned@example.com',
      identifier: 'PRV',
      repoName: 'alpha',
      repoHostId: '950007',
      installationId: INST_A,
    });
    const installation = await adminDb.githubInstallation.findFirstOrThrow({
      where: { installationId: INST_A },
    });
    expect(installation.workspaceId).toBeNull();

    const item = await makeItem(s, 'On a created repo');
    const res = await link(s, { key: item.identifier, repository: s.repo, number: 2 });
    expect(res.isError).toBeFalsy();
  });
});

// ── The service seam, direct ──────────────────────────────────────────────
describe('githubPullRequestService.linkPullRequestByCoordinates — the picker is untouched', () => {
  it('the existing picker path still links an ingested pull request', async () => {
    const s = await makeScenario({
      email: 'picker-intact@example.com',
      identifier: 'PIK',
      repoName: 'alpha',
      repoHostId: '960001',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'Picked by a human');
    await githubWebhookService.handleEvent(
      'pull_request',
      prEvent({
        installationId: s.installationId,
        repoHostId: s.repoHostId,
        number: 70,
        headBranch: 'feature/no-key',
        title: 'Unnamed',
      }),
    );
    const row = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 70 },
    });

    const dto = await githubPullRequestService.linkPullRequest(item.id, row.id, s.ctx);
    expect(dto).toMatchObject({ number: 70, repo: s.repo, linkedManually: true });
  });
});

// ── BLOCK 7 ───────────────────────────────────────────────────────────────
// The DELIVERY LINK the call now writes beside the FK (Story MOTIR-3655 ·
// MOTIR-3658, ADR `docs/decisions/work-item-delivery-links.md`).
//
// This is the EXPAND window, so BOTH are written — and the two disagree about a
// re-link ON PURPOSE. The FK is singular, so a re-link MOVES it (block 4 pins
// that, unchanged). The table ADDS, because one pull request delivering several
// cards is a real shape the column could never express. Every test below asserts
// the divergence rather than papering over it, because a reader who finds only
// one of the two would reasonably conclude the other is a bug.
describe('block 7 — the DELIVERY LINK, written beside the FK', () => {
  async function deliveries(s: Scenario, workItemId: string) {
    return withWorkspaceContext(s.ctx, (tx) =>
      workItemDeliveryRepository.listByWorkItem(workItemId, tx),
    );
  }

  it('a link writes a delivery row carrying the pull request AND its repository', async () => {
    const s = await makeScenario({
      email: 'delivery-one@example.com',
      identifier: 'DL1',
      repoName: 'alpha',
      repoHostId: '941001',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'Delivered once');

    await link(s, { key: item.identifier, repository: s.repo, number: 11 });

    const set = await deliveries(s, item.id);
    expect(set).toHaveLength(1);
    // The repository is on the ROW, so the completion gate can compare this
    // member's merge against ITS default branch without a join per member.
    expect(set[0]?.repoId).toBe(s.repoRowId);
    expect(set[0]?.pullRequest.number).toBe(11);
  });

  it('a SECOND pull request for the same card ADDS a member — the shape the story exists for', async () => {
    const s = await makeScenario({
      email: 'delivery-two@example.com',
      identifier: 'DL2',
      repoName: 'alpha',
      repoHostId: '941002',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'Two deliveries');

    await link(s, { key: item.identifier, repository: s.repo, number: 21 });
    await link(s, { key: item.identifier, repository: s.repo, number: 22 });

    const set = await deliveries(s, item.id);
    expect(set).toHaveLength(2);
    expect(new Set(set.map((d) => d.pullRequest.number))).toEqual(new Set([21, 22]));
  });

  it('ONE pull request linked to a second card DELIVERS BOTH — where the table and the FK part company', async () => {
    const s = await makeScenario({
      email: 'delivery-both@example.com',
      identifier: 'DLB',
      repoName: 'alpha',
      repoHostId: '941003',
      installationId: INST_A,
    });
    const a = await makeItem(s, 'Item A');
    const b = await makeItem(s, 'Item B');

    await link(s, { key: a.identifier, repository: s.repo, number: 31 });
    const moved = await link(s, { key: b.identifier, repository: s.repo, number: 31 });

    // The FK MOVED, and the tool still says so — block 4's contract is untouched.
    expect(structured(moved)).toMatchObject({ movedFrom: a.identifier });
    const row = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 31 },
    });
    expect(row.workItemId).toBe(b.id);

    // The TABLE kept both, which is the answer the column could not give: this
    // pull request delivers two cards, exactly as a `motir auto` one does.
    const prRow = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 31 },
    });
    const delivered = await withWorkspaceContext(s.ctx, (tx) =>
      workItemDeliveryRepository.listByPullRequest(prRow.id, tx),
    );
    expect(new Set(delivered.map((d) => d.workItemId))).toEqual(new Set([a.id, b.id]));
  });

  it('a repeat link writes no second row — a redelivery and an agent retry are no-ops', async () => {
    const s = await makeScenario({
      email: 'delivery-idem@example.com',
      identifier: 'DLI',
      repoName: 'alpha',
      repoHostId: '941004',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'Linked twice');

    await link(s, { key: item.identifier, repository: s.repo, number: 41 });
    await link(s, { key: item.identifier, repository: s.repo, number: 41 });
    await link(s, { key: item.identifier, repository: s.repo, number: 41 });

    expect(await deliveries(s, item.id)).toHaveLength(1);
  });

  it('unlink removes ONE member and leaves the others and the FK alone', async () => {
    const s = await makeScenario({
      email: 'delivery-unlink@example.com',
      identifier: 'DLU',
      repoName: 'alpha',
      repoHostId: '941005',
      installationId: INST_A,
    });
    const item = await makeItem(s, 'One wrong link');

    await link(s, { key: item.identifier, repository: s.repo, number: 51 });
    await link(s, { key: item.identifier, repository: s.repo, number: 52 });
    const wrong = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 51 },
    });

    const first = await githubPullRequestService.unlinkPullRequest(item.id, wrong.id, s.ctx);
    // A second call has nothing to remove and says so rather than reporting a
    // success that did nothing.
    const second = await githubPullRequestService.unlinkPullRequest(item.id, wrong.id, s.ctx);

    expect(first).toEqual({ removed: true });
    expect(second).toEqual({ removed: false });

    const set = await deliveries(s, item.id);
    expect(set).toHaveLength(1);
    expect(set[0]?.pullRequest.number).toBe(52);

    // The legacy column is DELIBERATELY untouched: its readers have not moved
    // yet, and clearing it would take a delivery's status sync away from a card
    // whose other links are perfectly good.
    const stillLinked = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { repoId: s.repoRowId, number: 51 },
    });
    expect(stillLinked.workItemId).toBe(item.id);
  });
});
