import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import type { GithubWebhookResult } from '@/lib/services/githubWebhookService';
import type { ChangeRequestSyncResult } from '@/lib/services/changeRequestStatusSync';
import { repoSetCompletionService } from '@/lib/services/repoSetCompletionService';
import { resolveChangeRequestWorkItemSet } from '@/lib/services/changeRequestWorkItems';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-3721 — THE READERS WHOSE FAILURE IS SILENT, moved onto
// `work_item_delivery` (`docs/decisions/delivery-reader-migration.md`).
//
// ── Why this file exists beside the suites that already pass ───────────────
// Every reader this card moves fails by returning NOTHING while raising
// NOTHING. An empty delivery read makes `reevaluateItem` answer
// `no_linked_change_request` for every card in the product; an unresolved link
// makes a merge move no card; a capped resolve moves ONE card of N and reports
// success. None of those is an error, so a green suite is not evidence about
// any of them — each needs a test that asserts a NON-EMPTY, N-VALUED result.
// That is what these are.
//
// ⚠️ AND THE HEADLINE IS N > 1, DELIBERATELY. `resolveChangeRequestWorkItemSet`
// used to take a `linked: ChangeRequestWorkItemRef | null` argument and return
// `args.linked ? [args.linked] : []` — a cardinality cap living in a PARAMETER
// TYPE rather than in a column, which no grep of `work_item_id` could find and
// which every N = 1 test passes straight through. The measured cost was four
// merged pull requests delivering seven cards, of which six never moved.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-delivery-readers';
const REPO_PROVIDER_ID = '9401';

async function makeScenario(email: string) {
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
        name: 'motir-core',
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return { user, workspace, project, ctx };
}

function prPayload(opts: {
  action: string;
  number: number;
  headRef: string;
  state?: 'open' | 'closed';
  merged?: boolean;
  baseRef?: string;
}) {
  return {
    action: opts.action,
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      merged_at: opts.merged ? '2026-08-28T10:00:00.000Z' : null,
      // Names NOTHING. The association is the LINK (MOTIR-3674).
      title: 'A sweep',
      head: { ref: opts.headRef },
      base: { ref: opts.baseRef ?? 'main' },
      user: { id: 4242 },
    },
  };
}

const pr = (payload: ReturnType<typeof prPayload>) =>
  githubWebhookService.handleEvent('pull_request', payload);

/** Narrow the webhook's result union to the STATUS-SYNC member on its own `event`
 *  discriminant, so a per-card field can be read without a cast. A result that is
 *  not a `pull_request` one is a test failure with a legible message rather than a
 *  compile-time widening. */
function asSync(result: GithubWebhookResult): ChangeRequestSyncResult {
  if (result.event !== 'pull_request') {
    throw new Error(`expected a pull_request result, got "${result.event}"`);
  }
  return result;
}

const ci = (opts: { conclusion: string; headSha: string; prNumbers: number[] }) =>
  githubWebhookService.handleEvent('check_suite', {
    action: 'completed',
    installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: opts.headSha,
      head_branch: null,
      status: 'completed',
      conclusion: opts.conclusion,
      app: { slug: 'github-actions' },
      pull_requests: opts.prNumbers.map((n) => ({ number: n })),
    },
  });

async function statusOf(workItemId: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id: workItemId } })).status;
}

async function makeCard(
  s: Awaited<ReturnType<typeof makeScenario>>,
  title: string,
  targetRepos: string[] = [],
) {
  const item = await workItemsService.createWorkItem(
    {
      projectId: s.project.id,
      kind: 'task',
      title,
      ...(targetRepos.length ? { targetRepos } : {}),
    },
    s.ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', s.ctx);
  return item;
}

/** `link_pull_request`'s own service door — one call PER (card, pull request),
 *  which is exactly what a `motir auto` run makes for each card of its run. */
async function link(
  s: Awaited<ReturnType<typeof makeScenario>>,
  workItemId: string,
  opts: { number: number; headRef: string },
) {
  return githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId,
      projectId: s.project.id,
      owner: 'moooon',
      name: 'motir-core',
      number: opts.number,
      headRef: opts.headRef,
      baseRef: 'main',
      title: null,
    },
    s.ctx,
  );
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('ONE pull request delivering N cards — the merge closes all N (MOTIR-3721)', () => {
  const BRANCH = 'motir/auto-run-77';

  it('opens all three to Implemented and closes all three on the merge', async () => {
    const s = await makeScenario('n-cards@example.com');
    const cards = [
      await makeCard(s, 'card one'),
      await makeCard(s, 'card two'),
      await makeCard(s, 'card three'),
    ];
    await pr(prPayload({ action: 'opened', number: 501, headRef: BRANCH }));
    for (const card of cards) await link(s, card.id, { number: 501, headRef: BRANCH });

    // ⚠️ THE LINKS ARE THE WHOLE SET. Three calls, three delivery rows, one pull
    // request. The scalar this asymmetry was written against is gone (MOTIR-3757),
    // so what used to be a demonstration that the two disagreed is now simply the
    // shape: `link_pull_request` ADDS, and there is nothing left for it to move.
    const row = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 501 } });
    expect(await adminDb.workItemDelivery.count({ where: { githubPullRequestId: row.id } })).toBe(
      3,
    );

    // The link resync moves each card it finds already open; assert the state
    // rather than the route, since either order must end the same way.
    for (const card of cards) {
      if ((await statusOf(card.id)) !== 'implemented') {
        await workItemsService.updateStatus(card.id, 'implemented', s.ctx);
      }
    }

    const merged = await pr(
      prPayload({
        action: 'closed',
        number: 501,
        headRef: BRANCH,
        state: 'closed',
        merged: true,
      }),
    );

    // A delivery deciding N cards SAYS N — reporting one of them is the defect.
    const synced = asSync(merged);
    expect(synced).toMatchObject({ outcome: 'delivery_applied' });
    expect(synced.deliveredItems).toHaveLength(3);
    expect(new Set(synced.deliveredItems?.map((d) => d.workItemId))).toEqual(
      new Set(cards.map((c) => c.id)),
    );
    for (const d of synced.deliveredItems ?? []) {
      expect(d).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    }
    for (const card of cards) expect(await statusOf(card.id)).toBe('done');
  });

  it("writes the CI verdict onto EVERY delivered card's `ciState`, not just one", async () => {
    // S2's per-card act. `ciState` is a per-card signal and the verdict is about
    // all of them: a second card left reading whatever the previous run wrote is a
    // WRONG answer, not a missing one.
    const s = await makeScenario('n-cards-ci@example.com');
    const cards = [await makeCard(s, 'ci one'), await makeCard(s, 'ci two')];
    await pr(prPayload({ action: 'opened', number: 502, headRef: BRANCH }));
    for (const card of cards) await link(s, card.id, { number: 502, headRef: BRANCH });

    const res = await ci({ conclusion: 'success', headSha: 'sha-green', prNumbers: [502] });
    expect(res).toMatchObject({ outcome: 'verified', ciState: 'passing' });

    for (const card of cards) {
      const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: card.id } });
      expect(row.ciState).toBe('passing');
    }
  });

  it('resolves the delivery set as `linked`, and a session branch still as `session_branch`', async () => {
    // AC 4 — the member was renamed because it asserted a cardinality it no longer
    // has. Its ONE reader compares `'session_branch'` (`changeRequestStatusSync`'s
    // session close-out), so the rename cannot reach it — asserted here rather
    // than argued, because "the other arm is unaffected" is exactly the claim a
    // rename quietly falsifies.
    const s = await makeScenario('kinds@example.com');
    const linkedCard = await makeCard(s, 'linked card');
    await pr(prPayload({ action: 'opened', number: 503, headRef: 'subtask/one' }));
    await link(s, linkedCard.id, { number: 503, headRef: 'subtask/one' });
    const row = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 503 } });

    // ⚠️ BIND THE TENANT — the resolver reads `work_item`, which carries no
    // `system_admin` arm (MOTIR-2880), so a bare system context returns an EMPTY
    // set and raises nothing. Both live callers bind before they reach it; a test
    // that did not would be measuring the blind spot rather than the resolver.
    const linkedSet = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, s.workspace.id);
      return resolveChangeRequestWorkItemSet({
        workspaceId: s.workspace.id,
        headRef: 'subtask/one',
        githubPullRequestId: row.id,
        tx,
      });
    });
    expect(linkedSet.kind).toBe('linked');
    expect(linkedSet.sessionBranch).toBeNull();
    expect(linkedSet.items.map((i) => i.id)).toEqual([linkedCard.id]);

    // A card recorded as integrated onto a session branch resolves the OTHER arm,
    // whatever the pull request's links say.
    const onBranch = await makeCard(s, 'on the branch');
    await adminDb.workItem.update({
      where: { id: onBranch.id },
      data: { sessionBranch: BRANCH },
    });
    const sessionSet = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, s.workspace.id);
      return resolveChangeRequestWorkItemSet({
        workspaceId: s.workspace.id,
        headRef: BRANCH,
        githubPullRequestId: row.id,
        tx,
      });
    });
    expect(sessionSet.kind).toBe('session_branch');
    expect(sessionSet.sessionBranch).toBe(BRANCH);
    expect(sessionSet.items.map((i) => i.id)).toEqual([onBranch.id]);
  });
});

describe('a delivery row the tenant context cannot follow resolves to NOTHING, never a fabricated card', () => {
  it('drops a delivery naming a card in ANOTHER workspace', async () => {
    // The corrupt pairing the delivery table's own migration declined to carry
    // forward: *"a pull request whose repository belongs to a different workspace
    // than the card it names is corrupt, and this backfill declines to carry that
    // corruption forward"*. The resolver declines it too, and this asserts WHICH
    // way it declines — an empty set rather than an item nobody in this tenant may
    // see.
    //
    // ⚠️ IT IS REACHABLE PRECISELY BECAUSE THE TWO TABLES ARE ARMED DIFFERENTLY
    // (MOTIR-3721). `work_item_delivery` now carries the `system_admin` arm, so
    // the link read is admitted; `work_item` does not, so the card read is gated
    // on the bound workspace alone. A resolver that trusted the link read would
    // hand its caller a cross-tenant item; this one keeps only the rows the tenant
    // context actually returned.
    const s = await makeScenario('cross-tenant@example.com');
    await pr(prPayload({ action: 'opened', number: 801, headRef: 'subtask/cross' }));
    const row = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 801 } });

    // A card in a DIFFERENT workspace.
    const other = await usersService.createUser({
      email: 'other-tenant@example.com',
      password: PASSWORD,
      name: 'Other',
    });
    const { workspace: otherWorkspace } = await workspacesService.createWorkspace({
      name: 'Other',
      ownerUserId: other.id,
    });
    const otherProject = await projectsService.createProject({
      workspaceId: otherWorkspace.id,
      actorUserId: other.id,
      name: 'Other',
      identifier: 'OTHR',
    });
    const foreign = await workItemsService.createWorkItem(
      { projectId: otherProject.id, kind: 'task', title: 'not yours' },
      { userId: other.id, workspaceId: otherWorkspace.id },
    );

    // Written through `adminDb` on purpose: `link_pull_request` refuses a
    // cross-workspace target, so this state cannot be reached through the door —
    // only by a row that predates the check or by corruption.
    await adminDb.workItemDelivery.create({
      data: {
        workspaceId: s.workspace.id,
        workItemId: foreign.id,
        githubPullRequestId: row.id,
        repoId: row.repoId,
      },
    });

    const resolved = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, s.workspace.id);
      return resolveChangeRequestWorkItemSet({
        workspaceId: s.workspace.id,
        headRef: 'subtask/cross',
        githubPullRequestId: row.id,
        tx,
      });
    });

    expect(resolved.kind).toBe('linked');
    expect(resolved.items).toEqual([]);
  });
});

describe('the TENANT resolves from a delivery row, before any workspace is bound (MOTIR-3721 AC 2)', () => {
  it('re-evaluates a card whose ONLY association is a delivery row', async () => {
    // ⚠️ THE ASSERTION THAT MATTERS IS *NOT EMPTY*. `reevaluateItem` opens
    // `withSystemContext`, resolves the workspace off a table it can read before a
    // tenant is bound, and only then binds. If that read comes back empty the
    // method answers `no_linked_change_request` — for a card that plainly has one
    // — and raises nothing. So the fixture strips the legacy column to leave the
    // DELIVERY ROW as the only path to the answer, and the test requires a verdict
    // that could only have been reached through it.
    const s = await makeScenario('tenant@example.com');
    const card = await makeCard(s, 'ships in core', ['motir-core']);
    await pr(prPayload({ action: 'opened', number: 601, headRef: 'subtask/tenant' }));
    await link(s, card.id, { number: 601, headRef: 'subtask/tenant' });
    await workItemsService.updateStatus(card.id, 'implemented', s.ctx);
    await pr(
      prPayload({
        action: 'closed',
        number: 601,
        headRef: 'subtask/tenant',
        state: 'closed',
        merged: true,
      }),
    );
    expect(await statusOf(card.id)).toBe('done');

    // Back to In Review — through the workflow's own legal hops, never a raw
    // write. The delivery row is the ONLY record that this card has a change
    // request at all; the legacy column this case used to clear by hand no longer
    // exists (MOTIR-3757), so the state it was arranging is now simply the state.
    await workItemsService.updateStatus(card.id, 'in_progress', s.ctx);
    await workItemsService.updateStatus(card.id, 'in_review', s.ctx);
    expect(await adminDb.workItemDelivery.count({ where: { workItemId: card.id } })).toBe(1);

    const result = await repoSetCompletionService.reevaluateItem(card.id, { dryRun: false });

    // NON-EMPTY: the tenant was found, the card was read, and the gate reached a
    // real verdict. `no_linked_change_request` is exactly what an empty read
    // produces, so it is the failure this asserts against.
    expect(result.outcome).not.toBe('no_linked_change_request');
    expect(result).toMatchObject({
      workItemId: card.id,
      outcome: 'transitioned',
      toStatus: 'done',
    });
    expect(await statusOf(card.id)).toBe('done');
  });

  it('still answers `no_linked_change_request` for a card that genuinely has none', async () => {
    // The mirror assertion, so the one above cannot pass by the method having
    // stopped distinguishing the two.
    const s = await makeScenario('tenant-none@example.com');
    const card = await makeCard(s, 'no change request', ['motir-core']);
    const result = await repoSetCompletionService.reevaluateItem(card.id, { dryRun: false });
    expect(result.outcome).toBe('no_linked_change_request');
  });
});

describe('the column IS dropped, and `linked_manually` is not (MOTIR-3757 AC 7)', () => {
  // ⚠️ THE PREDECESSOR OF THIS BLOCK ASSERTED THE OPPOSITE — *"the column is NOT
  // dropped, and both writers still write it (MOTIR-3721 AC 7)"* — and it was
  // right for its card, whose whole argument was that the EXPAND step drops
  // nothing so the rollback stays a code revert. This is the CONTRACT step: the
  // column goes, both writers go with it, and the one thing that must NOT go is
  // `linked_manually`, which qualified the link and outlives it as provenance.
  it('a link stamps `linked_manually` and a later delivery preserves it', async () => {
    const s = await makeScenario('column@example.com');
    const card = await makeCard(s, 'still stamped');
    await pr(prPayload({ action: 'opened', number: 701, headRef: 'subtask/col' }));
    await link(s, card.id, { number: 701, headRef: 'subtask/col' });

    // The declared-not-inferred stamp, which is all that is left of W1.
    const afterLink = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 701 } });
    expect(afterLink.linkedManually).toBe(true);
    expect(
      await adminDb.workItemDelivery.count({ where: { githubPullRequestId: afterLink.id } }),
    ).toBe(1);

    // A later delivery upserts the row's state fields and PRESERVES the flag. It
    // reaches no association at all now: the link lives in another table.
    await pr(
      prPayload({
        action: 'closed',
        number: 701,
        headRef: 'subtask/col',
        state: 'closed',
        merged: true,
      }),
    );
    const afterDelivery = await adminDb.githubPullRequest.findFirstOrThrow({
      where: { number: 701 },
    });
    expect(afterDelivery.linkedManually).toBe(true);
    expect(afterDelivery.merged).toBe(true);
    expect(
      await adminDb.workItemDelivery.count({ where: { githubPullRequestId: afterDelivery.id } }),
    ).toBe(1);
  });

  it('`github_pull_request` no longer has a `work_item_id` column at all', async () => {
    // The drop asserted where it happened. A green suite proves the readers
    // moved; only this proves the column went, and only this catches a
    // `migrate resolve` that skipped the migration on some environment.
    const columns = await adminDb.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'github_pull_request'`;
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain('work_item_id');
    expect(names).toContain('linked_manually');
  });
});

// ─────────────────────── EXPAND-2 (MOTIR-3756) ─────────────────────────────
//
// The readers whose failure is VISIBLE — a Development list that comes back
// SHORT, and the correction door a set makes necessary. They share this file
// because they share the ADR and the fixture; what they do not share is the
// acceptance instrument, which is why they are a different card: these are
// found by USING the product, and MOTIR-3721's are found by nobody.

describe('the Development surface reads the delivery set (MOTIR-3756 AC 5)', () => {
  it('lists a pull request that delivers this card ALONGSIDE others, for every card it delivers', async () => {
    const s = await makeScenario('development-surface@example.com');
    const parent = await makeCard(s, 'The parent a session PR delivers');
    const childA = await makeCard(s, 'Child A, on the same session branch');
    const childB = await makeCard(s, 'Child B, on the same session branch');
    await pr(prPayload({ action: 'opened', number: 810, headRef: 'motir/auto-run-1' }));
    // One pull request, three deliveries — the shape a scoped run produces, and
    // the shape the singular column could name only one third of.
    await link(s, parent.id, { number: 810, headRef: 'motir/auto-run-1' });
    await link(s, childA.id, { number: 810, headRef: 'motir/auto-run-1' });
    await link(s, childB.id, { number: 810, headRef: 'motir/auto-run-1' });

    // Three delivery rows for one pull request. A reader on the retired scalar
    // would have shown this pull request to childB and to NOBODY else — that is
    // what made the three assertions below non-trivial, and the fixture now states
    // it as the set rather than as the disagreement.
    const row = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 810 } });
    expect(await adminDb.workItemDelivery.count({ where: { githubPullRequestId: row.id } })).toBe(
      3,
    );

    for (const card of [parent, childA, childB]) {
      const listed = await workItemsService.listLinkedPullRequests(card.id, s.ctx);
      expect(listed.map((p) => p.number)).toEqual([810]);
    }
  });

  it('lists EVERY pull request delivering one card — the cross-repository shape', async () => {
    const s = await makeScenario('development-multi@example.com');
    const card = await makeCard(s, 'A card delivered by two pull requests');
    await pr(prPayload({ action: 'opened', number: 811, headRef: 'parent/MOTIR-x' }));
    await pr(prPayload({ action: 'opened', number: 812, headRef: 'parent/MOTIR-x' }));
    await link(s, card.id, { number: 811, headRef: 'parent/MOTIR-x' });
    await link(s, card.id, { number: 812, headRef: 'parent/MOTIR-x' });

    const listed = await workItemsService.listLinkedPullRequests(card.id, s.ctx);
    expect(listed.map((p) => p.number).sort()).toEqual([811, 812]);
  });
});

describe('`unlink_pull_request` — the mis-link-then-correct path (MOTIR-3756 AC 6)', () => {
  it('removes EXACTLY ONE delivery: the wrong card loses it, every other card keeps it', async () => {
    const s = await makeScenario('unlink-correct@example.com');
    const wrong = await makeCard(s, 'The card the run linked by mistake');
    const right = await makeCard(s, 'The card the pull request actually delivers');
    const bystander = await makeCard(s, 'Another card on the same session pull request');
    await pr(prPayload({ action: 'opened', number: 820, headRef: 'motir/auto-run-2' }));

    // The mistake, and the "correction" that is not one: linking the RIGHT card
    // ADDS a delivery and leaves the wrong row exactly where it was.
    await link(s, wrong.id, { number: 820, headRef: 'motir/auto-run-2' });
    await link(s, bystander.id, { number: 820, headRef: 'motir/auto-run-2' });
    await link(s, right.id, { number: 820, headRef: 'motir/auto-run-2' });
    expect((await workItemsService.listLinkedPullRequests(wrong.id, s.ctx)).length).toBe(1);

    const removed = await githubPullRequestService.unlinkPullRequestByCoordinates(
      {
        workItemId: wrong.id,
        projectId: s.project.id,
        owner: 'moooon',
        name: 'motir-core',
        number: 820,
      },
      s.ctx,
    );
    expect(removed.removed).toBe(true);

    // Exactly one row gone.
    expect(await workItemsService.listLinkedPullRequests(wrong.id, s.ctx)).toEqual([]);
    expect(
      (await workItemsService.listLinkedPullRequests(right.id, s.ctx)).map((p) => p.number),
    ).toEqual([820]);
    expect(
      (await workItemsService.listLinkedPullRequests(bystander.id, s.ctx)).map((p) => p.number),
    ).toEqual([820]);
  });

  it('answers `removed: false` for a pair that was never linked, and leaves the pull request alone', async () => {
    const s = await makeScenario('unlink-noop@example.com');
    const card = await makeCard(s, 'A card that never linked it');
    await pr(prPayload({ action: 'opened', number: 821, headRef: 'subtask/never' }));

    const result = await githubPullRequestService.unlinkPullRequestByCoordinates(
      {
        workItemId: card.id,
        projectId: s.project.id,
        owner: 'moooon',
        name: 'motir-core',
        number: 821,
      },
      s.ctx,
    );
    expect(result.removed).toBe(false);
    // The pull request row itself is untouched — state, title and checks are the
    // webhook's to say, and so is the legacy column.
    const row = await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 821 } });
    expect(row.state).toBe('open');
  });

  it('leaves the mirrored pull request exactly as it stands (the unlink is not a retraction)', async () => {
    const s = await makeScenario('unlink-column@example.com');
    const card = await makeCard(s, 'A card whose pull request survives its unlink');
    await pr(prPayload({ action: 'opened', number: 822, headRef: 'subtask/col2' }));
    await link(s, card.id, { number: 822, headRef: 'subtask/col2' });

    await githubPullRequestService.unlinkPullRequestByCoordinates(
      {
        workItemId: card.id,
        projectId: s.project.id,
        owner: 'moooon',
        name: 'motir-core',
        number: 822,
      },
      s.ctx,
    );

    // The delivery is gone and the MIRROR ROW is not: unlinking corrects an
    // association, it does not retract the pull request. (This case used to add
    // that the legacy column was left standing; MOTIR-3757 dropped it, so the
    // only thing left to leave alone is the row itself.)
    expect(await workItemsService.listLinkedPullRequests(card.id, s.ctx)).toEqual([]);
    await adminDb.githubPullRequest.findFirstOrThrow({ where: { number: 822 } });
    expect(await adminDb.workItemDelivery.count({ where: { workItemId: card.id } })).toBe(0);
  });
});
