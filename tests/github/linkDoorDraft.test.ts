import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkWorkspaceReposToProject } from '../helpers/projectRepoLink';
import { deliveredItemIds, linkPr } from '../helpers/prLink';

// MOTIR-5002 — THE LINK DOOR CAN SEE A DRAFT TOO.
//
// MOTIR-4968 taught the SEAM about drafts and closed the WEBHOOK door: an open
// draft maps to no lifecycle, so its `opened` delivery records the pull request
// and transitions nothing. There is a second door onto the same transition and it
// did not go through the seam at all. `resyncLinkedPullRequest` runs when
// `link_pull_request` attaches a card to a pull request whose row PRE-EXISTED the
// link, and it synthesized its change request from that row — which modelled
// draft-ness nowhere — so it pinned `draft: false` and passed `'implemented'` as a
// LITERAL. The card reached `implemented` on a pull request explicitly not offered
// for review: the same false assertion MOTIR-4968 removed, arriving through the
// link.
//
// This card persists draft-ness on the mirror row (nullable, never backfilled) and
// routes the resync through `changeRequestLifecycle`. What is asserted here:
//
//   1. a linked OPEN DRAFT whose row pre-existed transitions nothing;
//   2. a linked OPEN READY pull request still reaches `implemented` — the
//      resync's whole feature, and the criterion option (c) alone would fail;
//   3. a row whose draft-ness is UNKNOWN (null) DECLINES rather than guessing;
//   4. a draft is still an OPEN LINKED pull request to the completion gates — the
//      property option (a) must not break;
//   5. the resync passes no lifecycle it cannot justify — read off the SOURCE,
//      because a literal that happens to agree with the seam is a behaviour test's
//      blind spot.
//
// Real Postgres, the real webhook service, the real link service, the real
// provider seam — no mocks, the motir-core convention, matching the
// `changeRequest*` suites next door.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-link-door-draft';

interface RepoSpec {
  name: string;
  providerRepoId: string;
  defaultBranch: string;
}

const CORE: RepoSpec = { name: 'motir-core', providerRepoId: '9502', defaultBranch: 'main' };
const AI: RepoSpec = { name: 'motir-ai', providerRepoId: '9503', defaultBranch: 'trunk' };

interface ServiceCtx {
  userId: string;
  workspaceId: string;
}

/** A workspace + project + a mirrored installation carrying every repo in
 *  `repos`, each also linked to the project so a repository SET can name it. */
async function makeProject(email: string, repos: RepoSpec[]) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: repos.map((r) => ({
      providerRepoId: r.providerRepoId,
      owner: 'moooon',
      name: r.name,
      defaultBranch: r.defaultBranch,
      archived: false,
    })),
  });
  await linkWorkspaceReposToProject({
    workspaceId: workspace.id,
    projectId: project.id,
    names: repos.map((r) => r.name),
  });
  const ctx: ServiceCtx = { userId: user.id, workspaceId: workspace.id };
  return { user, workspace, project, ctx };
}

/** A LEAF card at `in_progress` — where a run's own claim leaves it, so that
 *  `→ implemented` is a legal edge. */
async function makeLeaf(email: string, targetRepos: string[] = []) {
  const base = await makeProject(email, [CORE]);
  const item = await workItemsService.createWorkItem(
    {
      projectId: base.project.id,
      kind: 'task',
      title: 'A tracked change',
      ...(targetRepos.length > 0 ? { targetRepos } : {}),
    },
    base.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', base.ctx);
  return { ...base, item };
}

/** A GitHub `pull_request` delivery body. `draft` defaults to FALSE, exactly as
 *  the payload's own field does, so a test opts INTO a draft. */
function prPayload(opts: {
  action: string;
  identifier: string;
  repo?: RepoSpec;
  number?: number;
  baseRef?: string;
  state?: 'open' | 'closed';
  merged?: boolean;
  draft?: boolean;
}) {
  const repo = opts.repo ?? CORE;
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(repo.providerRepoId) },
    pull_request: {
      number: opts.number ?? 7,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      draft: opts.draft ?? false,
      title: `Some change (${opts.identifier})`,
      head: { ref: `subtask/${opts.identifier}-a-change` },
      base: { ref: opts.baseRef ?? repo.defaultBranch },
      user: { id: 4242 },
    },
  };
}

const deliver = (body: ReturnType<typeof prPayload>) =>
  githubWebhookService.handleEvent('pull_request', body);

/** The link `link_pull_request` writes — the same service method the MCP tool
 *  calls. It is never told whether the pull request is a draft. */
async function linkFor(
  s: { item: { id: string; identifier: string }; project: { id: string }; ctx: ServiceCtx },
  opts: { number?: number; repo?: RepoSpec; workItemId?: string } = {},
) {
  const repo = opts.repo ?? CORE;
  return linkPr(
    {
      workItemId: opts.workItemId ?? s.item.id,
      projectId: s.project.id,
      owner: 'moooon',
      name: repo.name,
      number: opts.number ?? 7,
      headRef: `subtask/${s.item.identifier}-a-change`,
      baseRef: repo.defaultBranch,
      title: `Some change (${s.item.identifier})`,
    },
    s.ctx,
  );
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

/** The status hops on the append-only revision trail, oldest first. The ABSENCE of
 *  a hop is the proof nothing moved — a status read alone cannot tell "never
 *  transitioned" from "transitioned and back". */
async function statusHops(workItemId: string): Promise<string[]> {
  const rows = await adminDb.workItemRevision.findMany({
    where: { workItemId },
    orderBy: { changedAt: 'asc' },
  });
  return rows
    .map((r) => (r.diff as { status?: { to?: string } } | null)?.status?.to)
    .filter((to): to is string => typeof to === 'string');
}

async function prRow(number: number) {
  return adminDb.githubPullRequest.findFirstOrThrow({ where: { number } });
}

async function commentCount(workItemId: string): Promise<number> {
  return adminDb.comment.count({ where: { workItemId } });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('linking a card to an OPEN DRAFT transitions nothing', () => {
  it('the delivery lands first, the link finds a draft, and the card does not move', async () => {
    // The window the card names: a delivery that arrives BEFORE the link. It
    // correctly moves nothing (no link yet) and its row is what the resync will
    // later read — which is the only reason the resync exists.
    const s = await makeLeaf('link-draft@example.com');

    const opened = await deliver(
      prPayload({ action: 'opened', identifier: s.item.identifier, draft: true }),
    );
    expect(opened).toMatchObject({ outcome: 'no_work_item' });

    // The row records the draft — the fact MOTIR-4968 read off the payload and
    // then dropped, and the one this card persists.
    expect(await prRow(7)).toMatchObject({ state: 'open', merged: false, draft: true });

    // THE LINK — the second door. Before this card it flipped the card to
    // `implemented` on a pull request explicitly not offered for review.
    await linkFor(s);

    expect(await statusOf(s.item.id)).toBe('in_progress');
    // Creation, then the claim — and nothing since. The trail is what separates
    // "never transitioned" from "transitioned and back", which a status read
    // cannot.
    expect(await statusHops(s.item.id)).toEqual(['todo', 'in_progress']);
    expect(await commentCount(s.item.id)).toBe(0);
    // ⚠️ AND THE LINK ITSELF STILL LANDED. What is skipped is the TRANSITION, not
    // the association: a link that recorded nothing would take the merge with it.
    expect(await deliveredItemIds((await prRow(7)).id)).toEqual([s.item.id]);
  });

  it('`ready_for_review` then moves it, and a later re-link agrees', async () => {
    const s = await makeLeaf('link-draft-ready@example.com');
    await deliver(prPayload({ action: 'opened', identifier: s.item.identifier, draft: true }));
    await linkFor(s);
    expect(await statusOf(s.item.id)).toBe('in_progress');

    // The moment that actually means `implemented`. The row's `draft` flips with
    // it — the sync writes the column on EVERY delivery, not only the draft ones,
    // or the row would keep asserting a draft-ness the host had retracted.
    const ready = await deliver(
      prPayload({ action: 'ready_for_review', identifier: s.item.identifier, draft: false }),
    );
    expect(ready).toMatchObject({ outcome: 'transitioned', toStatus: 'implemented' });
    expect(await prRow(7)).toMatchObject({ draft: false });

    // A SECOND card linked to the same pull request now resyncs on a row that
    // says ready — the other half of the flip, through the door this card is about.
    const second = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A sibling on the same PR' },
      s.ctx,
    );
    await workItemsService.updateStatus(second.id, 'in_progress', s.ctx);
    await linkFor(s, { workItemId: second.id });
    expect(await statusOf(second.id)).toBe('implemented');
  });
});

describe('linking a card to an OPEN READY pull request still reaches implemented', () => {
  // The resync's whole feature, and the criterion option (c) — "do not resync a
  // pull request whose draft-ness is unknown" — would have failed by giving it up
  // for every pull request rather than for the rows that genuinely do not know.
  it('the delivery lands first with no link; the link catches the card up', async () => {
    const s = await makeLeaf('link-ready@example.com');

    const opened = await deliver(prPayload({ action: 'opened', identifier: s.item.identifier }));
    expect(opened).toMatchObject({ outcome: 'no_work_item' });
    expect(await prRow(7)).toMatchObject({ draft: false });
    expect(await statusOf(s.item.id)).toBe('in_progress');

    await linkFor(s);

    expect(await statusOf(s.item.id)).toBe('implemented');
    expect(await statusHops(s.item.id)).toEqual(['todo', 'in_progress', 'implemented']);
  });
});

describe('a row whose draft-ness is UNKNOWN declines rather than guessing', () => {
  // The column is nullable and NEVER backfilled, so null means UNKNOWN: a row
  // mirrored before it existed, or — the live case asserted here — a placeholder
  // the link door's own create arm wrote, because `link_pull_request` is told the
  // refs and the title and is never asked about draft-ness.
  it('a placeholder row written by an earlier link moves no later-linked card', async () => {
    const s = await makeLeaf('link-unknown@example.com');

    // A run that links the moment `gh pr create --draft` returns, ahead of the
    // delivery. This arm CREATES the row, so there is nothing to resync — and the
    // row must not claim to know.
    const first = await linkFor(s);
    expect(first).toMatchObject({ created: true });
    expect((await prRow(7)).draft).toBeNull();
    expect(await statusOf(s.item.id)).toBe('in_progress');

    // A second card linked to that same pull request BEFORE any delivery. The row
    // now pre-exists, so the resync runs — on a row that cannot say whether the
    // pull request is offered for review. Reading null as `false` here is the
    // defect with a different author.
    const second = await workItemsService.createWorkItem(
      { projectId: s.project.id, kind: 'task', title: 'A sibling on the same PR' },
      s.ctx,
    );
    await workItemsService.updateStatus(second.id, 'in_progress', s.ctx);
    const link = await linkFor(s, { workItemId: second.id });

    expect(link).toMatchObject({ created: false });
    expect(await statusOf(second.id)).toBe('in_progress');
    expect(await statusHops(second.id)).toEqual(['todo', 'in_progress']);
    // Declining costs nothing where it fires: both cards are linked, and the
    // delivery still to come transitions them itself.
    expect(await deliveredItemIds((await prRow(7)).id)).toEqual([s.item.id, second.id]);

    const opened = await deliver(
      prPayload({ action: 'opened', identifier: s.item.identifier, draft: false }),
    );
    expect(opened).toMatchObject({ outcome: 'delivery_applied' });
    expect(await statusOf(s.item.id)).toBe('implemented');
    expect(await statusOf(second.id)).toBe('implemented');
  });
});

describe('a DRAFT is still an OPEN LINKED pull request to the completion gates', () => {
  // The property option (a) must not break, and the reason `github_pull_request`
  // deliberately modelled draft-ness nowhere before this card: a draft has to keep
  // counting as OPEN, or the hold that keeps a multi-repository card alive while
  // one repository's chain is stopped stops holding.
  it('a two-repository card whose other repository has a linked draft is HELD on the first merge', async () => {
    const base = await makeProject('link-draft-two-repos@example.com', [CORE, AI]);
    const item = await workItemsService.createWorkItem(
      {
        projectId: base.project.id,
        kind: 'task',
        title: 'A change that ships in two repositories',
        targetRepos: ['motir-core', 'motir-ai'],
      },
      base.ctx,
    );
    await workItemsService.updateStatus(item.id, 'in_progress', base.ctx);
    const s = { ...base, item };

    // A draft in each repository, each linked to the one card — the parent-run
    // shape, one repository per chain.
    for (const [repo, number] of [
      [CORE, 11],
      [AI, 12],
    ] as const) {
      await deliver(
        prPayload({ action: 'opened', identifier: item.identifier, repo, number, draft: true }),
      );
      await linkFor(s, { repo, number });
    }
    expect(await statusOf(item.id)).toBe('in_progress');

    // ⚠️ THE MECHANISM THE CRITERION NAMES, asserted directly: a DRAFT delivery is
    // counted by `countOtherOpenByWorkItem`, which keys on `state: 'open'` and
    // knows nothing about the new column. That is what makes it safe to add.
    const coreRow = await prRow(11);
    const otherOpen = await workItemDeliveryRepository.countOtherOpenByWorkItem(
      item.id,
      coreRow.id,
      adminDb,
    );
    expect(otherOpen).toBe(1);

    // motir-core's chain finishes and merges; motir-ai's is still a draft.
    await deliver(
      prPayload({
        action: 'ready_for_review',
        identifier: item.identifier,
        repo: CORE,
        number: 11,
      }),
    );
    const merged = await deliver(
      prPayload({
        action: 'closed',
        identifier: item.identifier,
        repo: CORE,
        number: 11,
        state: 'closed',
        merged: true,
      }),
    );

    // ⚠️ HELD — and NOT under the outcome name MOTIR-5002's own criterion 3
    // predicted. The card says `deferred_open_pr`; the shipped order puts
    // `deferred_incomplete_delivery_set` (MOTIR-3659) ahead of it, and that gate
    // fires on the SAME open sibling, so a card whose open sibling is LINKED can
    // no longer report the older name. The behaviour the criterion is about — the
    // draft holds the card — is exactly what this asserts; the name is recorded
    // here and amended on the card rather than quietly matched.
    expect(merged).toMatchObject({ outcome: 'deferred_incomplete_delivery_set' });
    expect(await statusOf(item.id)).not.toBe('done');
    expect(await prRow(12)).toMatchObject({ state: 'open', merged: false, draft: true });
  });
});

describe('the resync passes no lifecycle it cannot justify', () => {
  // A SOURCE read, because this is the one criterion behaviour cannot settle. The
  // literal `'implemented'` this card removes AGREES with the seam for every ready
  // pull request — which is why it survived so long — so a suite that only drives
  // the door would pass identically with the literal restored and the column
  // ignored. What is asserted is that the mapping is DECIDED in one place.
  const source = readFileSync(
    join(process.cwd(), 'lib/services/changeRequestStatusSync.ts'),
    'utf8',
  );
  const body = source.slice(source.indexOf('export async function resyncLinkedPullRequest'));

  it('routes through `changeRequestLifecycle` rather than stating a status', () => {
    expect(body).toContain('changeRequestLifecycle(');
    expect(body).not.toMatch(/syncChangeRequestStatus\(\s*cr\s*,\s*'/);
  });

  it('reads the stored draft flag and declines when it is null', () => {
    expect(body).toContain('draft: subject.draft');
    expect(body).toMatch(/if \(subject\.draft === null\) return null;/);
  });
});
