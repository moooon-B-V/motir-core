import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { deliveredItemIds, linkPr } from '../helpers/prLink';

// MOTIR-4968 — THE STATUS MACHINE CAN SEE A DRAFT.
//
// The seam's normalized shape carried `state: 'open' | 'closed'` and `merged`, and
// GitHub reports a DRAFT pull request as `state: 'open'`. So the machine did the
// right thing at the wrong moment and nothing at the right one:
//
//   • a draft that OPENED flipped its card to `implemented` — asserting that code
//     is ready for review about a pull request whose author has explicitly said it
//     is not;
//   • `ready_for_review`, the moment that actually means it, was not in
//     `HANDLED_PR_ACTIONS` at all, so nothing happened then.
//
// Both are the same root cause and both are fixed here. Real Postgres, the real
// webhook service, the real provider seam — no mocks, the motir-core convention,
// matching the `changeRequest*Gate` suites next door.
//
// ⚠️ ONE CLAIM IN THE ORIGINATING CARD IS FALSE, and it is recorded here rather
// than quietly dropped. The card says a draft's `opened` delivery against a
// container "posts a refusal note … once per run per repository". It does not, and
// it never did: `reportTransitionRefusal` posts a note for `missing_artifact_evidence`
// ONLY, and every other note site in `changeRequestStatusSync` is guarded on
// `lifecycle === 'done'` — which an `opened` delivery never is. The hold was
// already silent. So the `posts no refusal note` assertions below are REGRESSION
// guards on a property that already held, not proof of a fix; what this card
// actually removes is the spurious `open_children` REFUSAL itself, which is
// asserted directly.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-draft-lifecycle';
const REPO_PROVIDER_ID = '9468';

interface ServiceCtx {
  userId: string;
  workspaceId: string;
}

/** A workspace + project + a mirrored installation and repo. */
async function makeProject(email: string) {
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
    repos: [
      {
        providerRepoId: REPO_PROVIDER_ID,
        owner: 'moooon',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  const ctx: ServiceCtx = { userId: user.id, workspaceId: workspace.id };
  return { user, workspace, project, ctx };
}

/** A LEAF card at `in_progress` — where a run's own claim leaves it, so that
 *  `→ implemented` is a legal edge. */
async function makeLeaf(email: string) {
  const base = await makeProject(email);
  const item = await workItemsService.createWorkItem(
    { projectId: base.project.id, kind: 'task', title: 'A tracked change' },
    base.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', base.ctx);
  return { ...base, item };
}

/** A CONTAINER (a story) with two children — the parent-run shape. `childStatus`
 *  says whether the children have LANDED: `implemented` clears the
 *  container-completeness gate, `todo` is a chain that has not landed yet. */
async function makeContainer(email: string, childStatus: 'todo' | 'implemented') {
  const base = await makeProject(email);
  const story = await workItemsService.createWorkItem(
    { projectId: base.project.id, kind: 'story', title: 'A story a run is executing' },
    base.ctx,
  );
  for (const title of ['First child', 'Second child']) {
    const child = await workItemsService.createWorkItem(
      { projectId: base.project.id, kind: 'subtask', title, parentId: story.id },
      base.ctx,
    );
    if (childStatus === 'implemented') {
      await workItemsService.updateStatus(child.id, 'in_progress', base.ctx);
      await workItemsService.updateStatus(child.id, 'implemented', base.ctx);
    }
  }
  // The parent-run flips the container In Progress at its own claim, before the
  // first child commits — so that is where the draft's delivery finds it.
  await workItemsService.updateStatus(story.id, 'in_progress', base.ctx);
  return { ...base, item: story };
}

/** A GitHub `pull_request` delivery body. `draft` defaults to FALSE, exactly as
 *  the payload's own field does, so a test opts INTO a draft. */
function prPayload(opts: {
  action: string;
  identifier: string;
  number?: number;
  state?: 'open' | 'closed';
  merged?: boolean;
  draft?: boolean;
}) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number ?? 7,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      draft: opts.draft ?? false,
      title: `Some change (${opts.identifier})`,
      head: { ref: `parent/${opts.identifier}-a-change` },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
}

/** The link a run writes the moment `gh pr create --draft` returns — before any
 *  delivery lands, which is the real ordering and the one this card is about. */
async function linkFor(
  s: { item: { id: string; identifier: string }; project: { id: string }; ctx: ServiceCtx },
  number = 7,
) {
  return linkPr(
    {
      workItemId: s.item.id,
      projectId: s.project.id,
      owner: 'moooon',
      name: 'acme',
      number,
      headRef: `parent/${s.item.identifier}-a-change`,
      baseRef: 'main',
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

describe('a DRAFT pull request opening carries no lifecycle', () => {
  it('records the delivery, transitions nothing, and posts nothing (a LEAF)', async () => {
    const s = await makeLeaf('draft-leaf@example.com');
    await linkFor(s);

    const opened = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, draft: true }),
    );

    expect(opened).toMatchObject({ event: 'pull_request', outcome: 'no_lifecycle_change' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
    // Creation, then the claim — and nothing since. The trail is what separates
    // "never transitioned" from "transitioned and back", which a status read cannot.
    expect(await statusHops(s.item.id)).toEqual(['todo', 'in_progress']);
    expect(await commentCount(s.item.id)).toBe(0);

    // ⚠️ THE DELIVERY IS STILL RECORDED, which is the half a blanket "ignore the
    // event" would have lost. A draft must stay an OPEN LINKED pull request to
    // every other reader — the `deferred_open_pr` count that holds a multi-repo
    // parent open, and the item's Development surface.
    const prRow = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 7 } });
    expect(prRow).toMatchObject({ state: 'open', merged: false, headRef: prRow.headRef });
    expect(await deliveredItemIds(prRow.id)).toEqual([s.item.id]);
  });

  it('does the same for a CONTAINER whose children have NOT landed — no `open_children` refusal', async () => {
    // The parent-run case the card was filed from: the session pull request is a
    // DRAFT linked to the STORY at creation, and the children have not committed
    // yet. Before this card the delivery reached `applyTransition`, was refused by
    // the container-completeness gate and reported `open_children` — a correct
    // hold, on a state that is entirely normal, once per run per repository. Now
    // there is no transition to refuse.
    const s = await makeContainer('draft-container@example.com', 'todo');
    await linkFor(s);

    const opened = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, draft: true }),
    );

    expect(opened).toMatchObject({ outcome: 'no_lifecycle_change' });
    expect(opened).not.toMatchObject({ outcome: 'open_children' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
    expect(await commentCount(s.item.id)).toBe(0);
  });

  it('a NON-draft pull request opening is untouched — it still reaches `implemented`', async () => {
    // The population this card must not move: a pull request that was never a
    // draft never fires `ready_for_review`, and its `opened` delivery resolves
    // exactly as it always did.
    const s = await makeLeaf('nondraft@example.com');
    await linkFor(s);

    const opened = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier }),
    );

    expect(opened).toMatchObject({ outcome: 'transitioned', toStatus: 'implemented' });
    expect(await statusOf(s.item.id)).toBe('implemented');
  });
});

describe('`ready_for_review` is the moment a draft becomes implemented', () => {
  it('moves the linked card to `implemented` (a LEAF), after the draft open did nothing', async () => {
    const s = await makeLeaf('ready-leaf@example.com');
    await linkFor(s);

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, draft: true }),
    );
    expect(await statusOf(s.item.id)).toBe('in_progress');

    // GitHub sends `ready_for_review` with the pull request no longer a draft.
    const ready = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'ready_for_review', identifier: s.item.identifier, draft: false }),
    );

    expect(ready).toMatchObject({ outcome: 'transitioned', toStatus: 'implemented' });
    expect(await statusOf(s.item.id)).toBe('implemented');
  });

  it('completes a CONTAINER whose children have ALL landed', async () => {
    const s = await makeContainer('ready-container-ok@example.com', 'implemented');
    await linkFor(s);

    const ready = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'ready_for_review', identifier: s.item.identifier }),
    );

    expect(ready).toMatchObject({ outcome: 'transitioned', toStatus: 'implemented' });
    expect(await statusOf(s.item.id)).toBe('implemented');
  });

  it('is still REFUSED with `open_children` on a container whose children have not', async () => {
    // The gate is not weakened by any of this. Marking a draft ready when the
    // children have not landed is a real error — the runbook's own parent flow
    // marks the pull request ready only when the LAST child commits — and the
    // container-completeness gate is what says so.
    const s = await makeContainer('ready-container-open@example.com', 'todo');
    await linkFor(s);

    const ready = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'ready_for_review', identifier: s.item.identifier }),
    );

    expect(ready).toMatchObject({ outcome: 'open_children', toStatus: 'implemented' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
  });

  it('is a `noop` on a card already at `implemented`, and writes no second revision', async () => {
    // The redelivery case, and the ordinary one: a run that flips the card itself
    // (MOTIR-4969's half) writes the same value this delivery would, so the second
    // writer must be a no-op rather than a second write.
    const s = await makeLeaf('ready-noop@example.com');
    await linkFor(s);
    await workItemsService.updateStatus(s.item.id, 'implemented', s.ctx);
    const before = await statusHops(s.item.id);

    const ready = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'ready_for_review', identifier: s.item.identifier }),
    );

    expect(ready).toMatchObject({ outcome: 'noop', toStatus: 'implemented' });
    expect(await statusHops(s.item.id)).toEqual(before);
  });
});

describe('the draft guard sits where `implemented` is decided, not at the top', () => {
  it('a draft CLOSED without merging still returns the card to `in_progress`', async () => {
    // The case a blanket early return breaks. GitHub permits closing a draft, and
    // its payload is `draft: true, state: 'closed'` — which must still resolve to
    // the abandoned-work signal, or the card is stranded wherever it was.
    const s = await makeLeaf('draft-closed@example.com');
    await linkFor(s);
    // Take it to `implemented` first so a hop back is observable.
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier }),
    );
    expect(await statusOf(s.item.id)).toBe('implemented');

    const closed = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        state: 'closed',
        merged: false,
        draft: true,
      }),
    );

    expect(closed).toMatchObject({ outcome: 'transitioned', toStatus: 'in_progress' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
  });

  it('a draft that is somehow MERGED still completes the card', async () => {
    // GitHub blocks merging a draft today. The seam must not depend on it
    // continuing to, which is why the guard sits after the merged arm.
    const s = await makeLeaf('draft-merged@example.com');
    await linkFor(s);
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier }),
    );

    const merged = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        state: 'closed',
        merged: true,
        draft: true,
      }),
    );

    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
  });
});
