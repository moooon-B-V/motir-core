import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { assessArtifactEvidence } from '@/lib/workItems/artifactEvidence';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-3364 — A REFUSED CLOSE-OUT IS A HOLD, NOT A CRASH.
//
// The artifact-evidence gate (MOTIR-2709) refuses `→ done` on a `type: 'deploy'`
// card whose comments record no published artifact. That refusal is CORRECT and
// nothing here weakens it. What was wrong is what happened next: the gate throws
// from inside `applyStatusTransition`, and the merge-driven sync's
// `classifyTransitionError` did not know the error, so it RETHREW — a 500 on a
// successful merge delivery, with the card left at In Review and nothing on it to
// say why. Measured in production on 2026-08-21: `motir-gateway#19` merged at
// 11:55:14Z, motir-core logged the unhandled `MissingArtifactEvidenceError` at
// 11:55:15Z, and MOTIR-3282 never moved.
//
// The cost was not one card. Every `deploy` card in that story hit it, and it read
// as INTERMITTENT — a card closed on merge only when some earlier comment happened
// to contain a `1.2.3`-shaped string — so one session wrote the crash down as a
// design ("a deploy card simply is not finishable by a merge").
//
// Real Postgres, the real webhook service, the real provider seam — no mocks, the
// motir-core convention, matching `changeRequestTrunkGate.test.ts` next door.
// What is pinned here:
//
//   1. The delivery RESOLVES with its own outcome instead of rejecting, and the
//      item stays exactly where it was.
//   2. The reason lands ON THE CARD, once per merge — a redelivery adds no second
//      note, the guard the two sibling holds already use.
//   3. A failed note does not fail the delivery (best-effort, like the siblings).
//   4. The gate is not weakened: a non-`deploy` card still completes, and a
//      `deploy` card that DID record an artifact still completes.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-artifact-evidence';
const REPO_PROVIDER_ID = '9301';

/** A workspace + project + a leaf of `type`, plus a mirrored installation + repo. */
async function makeScenario(email: string, type: 'deploy' | 'code' = 'deploy') {
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
  const ctx = { userId: user.id, workspaceId: workspace.id };
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Cut the release', type },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
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
  return { user, workspace, project, item, ctx };
}

function prPayload(opts: {
  action: string;
  identifier: string;
  number: number;
  state?: 'open' | 'closed';
  merged?: boolean;
}) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: `Cut the release (${opts.identifier})`,
      head: { ref: `subtask/${opts.identifier}-cut-the-release` },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
}

/** Open the PR (parking the item at Implemented, as in reality) then merge it into
 *  the default branch. Returns the MERGE delivery's result. */
async function openThenMerge(identifier: string, number: number) {
  // MOTIR-3674 — the link is the only association a pull request has; the key in
  // the branch is a label. A run writes it the moment `gh pr create` returns,
  // which is before the `opened` delivery lands.
  await linkPrByIdentifier({
    identifier,
    owner: 'moooon',
    name: 'acme',
    number,
    headRef: `subtask/${identifier}-cut-the-release`,
    title: `Cut the release (${identifier})`,
  });
  const opened = await githubWebhookService.handleEvent(
    'pull_request',
    prPayload({ action: 'opened', identifier, number }),
  );
  expect(opened).toMatchObject({ outcome: 'transitioned', toStatus: 'implemented' });
  return githubWebhookService.handleEvent(
    'pull_request',
    prPayload({ action: 'closed', identifier, number, state: 'closed', merged: true }),
  );
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

async function commentsOn(workItemId: string) {
  return adminDb.comment.findMany({ where: { workItemId }, orderBy: { createdAt: 'asc' } });
}

/** The status hops on the append-only revision trail, oldest first. The ABSENCE of
 *  a `done` hop is the proof the gate HELD rather than transitioning and back. */
async function statusHops(workItemId: string): Promise<string[]> {
  const rows = await adminDb.workItemRevision.findMany({
    where: { workItemId },
    orderBy: { changedAt: 'asc' },
  });
  return rows
    .map((r) => (r.diff as { status?: { to?: string } } | null)?.status?.to)
    .filter((to): to is string => typeof to === 'string');
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the artifact-evidence hold — a merge that cannot complete a `deploy` card', () => {
  it('RESOLVES with `missing_artifact_evidence` instead of rejecting, and never moves the item', async () => {
    const s = await makeScenario('ae-hold@example.com');

    // The whole defect in one assertion: before this card the call REJECTED, and
    // the webhook route (which does not wrap `handleEvent`) turned that into a 500.
    const merged = await openThenMerge(s.item.identifier, 7001);

    expect(merged).toMatchObject({
      event: 'pull_request',
      outcome: 'missing_artifact_evidence',
      workItemId: s.item.id,
      toStatus: 'done',
    });
    expect(await statusOf(s.item.id)).toBe('implemented');

    // Never reached `done` at all — not even briefly. Every hop on the trail came
    // from `workItemsService` (a raw `workflow_status` write leaves no revision).
    const hops = await statusHops(s.item.id);
    expect(hops).not.toContain('done');
    expect(hops.at(-1)).toBe('implemented');

    // The pull-request row still records the truth about the merge itself — the
    // hold changes what the CARD says, never what the change request did.
    const prRow = await adminDb.githubPullRequest.findFirst({ where: { number: 7001 } });
    expect(prRow).toMatchObject({ state: 'closed', merged: true, workItemId: s.item.id });
  });

  it('says WHY on the card — the pull request, the forms accepted, and the escape hatch', async () => {
    const s = await makeScenario('ae-note@example.com');

    await openThenMerge(s.item.identifier, 7002);

    const comments = await commentsOn(s.item.id);
    expect(comments).toHaveLength(1);
    const body = comments[0]!.bodyMd;
    expect(body).toContain('#7002'); // which merge this is about
    expect(body).toContain('deploy'); // why THIS card and not its neighbours
    expect(body).toContain('sha256:'); // …and each accepted form, so the reader's
    expect(body).toContain('sha512-'); //    next action is to record one
    expect(body).toContain('version');
    expect(body).toContain('NO ARTIFACT:'); // the declared exemption
    expect(body).toContain('pull request'); // GitHub's noun for the change request
  });

  it('the note does NOT satisfy the gate it explains', async () => {
    // The gate is a string SCAN over every comment on the card, and this note is
    // one — so an illustrative `1.4.0` in its text reads to the scanner exactly
    // like a version somebody recorded. Drafted that way, the note posted its own
    // way out: the redelivery below closed the card the gate had just refused.
    // Asserted at the rule rather than by re-listing the forbidden shapes, so a
    // later edit to the wording cannot reintroduce it.
    const s = await makeScenario('ae-note-inert@example.com');
    await openThenMerge(s.item.identifier, 7009);

    const body = (await commentsOn(s.item.id))[0]!.bodyMd;
    expect(assessArtifactEvidence([body])).toEqual({ outcome: 'missing' });
  });

  it('is idempotent under redelivery — the hold repeats, the note does not', async () => {
    const s = await makeScenario('ae-redeliver@example.com');
    await linkPrByIdentifier({
      identifier: s.item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 7003,
      headRef: `subtask/${s.item.identifier}-cut-the-release`,
      title: `Cut the release (${s.item.identifier})`,
    });
    const mergePayload = prPayload({
      action: 'closed',
      identifier: s.item.identifier,
      number: 7003,
      state: 'closed',
      merged: true,
    });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, number: 7003 }),
    );
    const first = await githubWebhookService.handleEvent('pull_request', mergePayload);
    const second = await githubWebhookService.handleEvent('pull_request', mergePayload);
    const third = await githubWebhookService.handleEvent('pull_request', mergePayload);

    for (const r of [first, second, third]) {
      expect(r).toMatchObject({ outcome: 'missing_artifact_evidence' });
    }
    expect(await statusOf(s.item.id)).toBe('implemented');
    // A redelivery describes the SAME merge event — one note, not three.
    expect(await commentsOn(s.item.id)).toHaveLength(1);
  });

  it('a note that fails to post does NOT fail the delivery — the hold is the correctness', async () => {
    const s = await makeScenario('ae-note-fails@example.com');
    vi.spyOn(commentsService, 'addComment').mockRejectedValue(new Error('comment store down'));

    const merged = await openThenMerge(s.item.identifier, 7004);

    // Best-effort, exactly like the two sibling holds: a failed note must never
    // turn a correct hold back into a 500 the host retries forever.
    expect(merged).toMatchObject({ outcome: 'missing_artifact_evidence' });
    expect(await statusOf(s.item.id)).toBe('implemented');
    expect(await commentsOn(s.item.id)).toHaveLength(0);
  });
});

describe('the gate is not weakened — what still completes on merge', () => {
  it('a NON-`deploy` card completes as it always did', async () => {
    const s = await makeScenario('ae-code@example.com', 'code');

    const merged = await openThenMerge(s.item.identifier, 7005);

    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
    // The hold is silent when it does not fire.
    expect(await commentsOn(s.item.id)).toHaveLength(0);
  });

  it('a `deploy` card whose comments DO record an artifact completes on merge', async () => {
    const s = await makeScenario('ae-satisfied@example.com');
    await commentsService.addComment(
      s.item.id,
      { bodyMd: 'Released `ghcr.io/moooon-b-v/acme@sha256:446c692d1f4a9b0c2e11` — release 18.' },
      s.ctx,
    );

    const merged = await openThenMerge(s.item.identifier, 7006);

    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
    // The evidence comment, and no hold note beside it.
    expect(await commentsOn(s.item.id)).toHaveLength(1);
  });

  it('a `deploy` card carrying a declared `NO ARTIFACT:` exemption completes on merge', async () => {
    const s = await makeScenario('ae-exempt@example.com');
    await commentsService.addComment(
      s.item.id,
      { bodyMd: 'NO ARTIFACT: a DNS cutover — nothing is published to a registry.' },
      s.ctx,
    );

    const merged = await openThenMerge(s.item.identifier, 7007);

    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
  });

  it('a closed-UNMERGED pull request on a `deploy` card is untouched by the hold', async () => {
    // The gate is scoped to the merged→Done decision; the abandoned-work path
    // targets `in_progress`, which is not a done-category status.
    const s = await makeScenario('ae-unmerged@example.com');
    await linkPrByIdentifier({
      identifier: s.item.identifier,
      owner: 'moooon',
      name: 'acme',
      number: 7008,
      headRef: `subtask/${s.item.identifier}-cut-the-release`,
      title: `Cut the release (${s.item.identifier})`,
    });
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, number: 7008 }),
    );
    const closed = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        number: 7008,
        state: 'closed',
        merged: false,
      }),
    );

    expect(closed).toMatchObject({ outcome: 'transitioned', toStatus: 'in_progress' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
    expect(await commentsOn(s.item.id)).toHaveLength(0);
  });
});
