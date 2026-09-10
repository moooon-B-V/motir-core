import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { gitlabWebhookService } from '@/lib/services/gitlabWebhookService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { linkPrByIdentifier } from '../helpers/prLink';

// MOTIR-5001 — A GITLAB DRAFT MERGE REQUEST REACHES `implemented` WHEN IT IS
// MARKED READY.
//
// MOTIR-4968 taught the shared seam about drafts on BOTH providers: an OPEN DRAFT
// carries no lifecycle, so a draft's `open` delivery stops asserting that the code
// is ready for review. GitHub's other half is `ready_for_review`, a dedicated
// action added to `HANDLED_PR_ACTIONS` in that same card — the moment the card
// becomes `implemented`.
//
// GitLab has no such action. Marking a draft MR ready arrives as
// `object_attributes.action: 'update'`, which is ALSO what GitLab emits for a
// pushed commit, a label, an assignee and a title edit — the event we want is
// buried in the event we most want to ignore. So the fix is a PREDICATE over the
// delivery's `changes` object, not a new member of `HANDLED_MR_ACTIONS`: widening
// the set would run the status sync on every push in every connected GitLab
// project, which is exactly the per-push cost GitHub's `synchronize` exclusion is
// reasoned out to avoid.
//
// The predicate reads what CHANGED, and that is why it lives in this service
// rather than on the seam: `NormalizedChangeRequest` carries the CURRENT draft
// state (`false` at this moment) and has no notion of a transition, so an
// un-drafting delivery and a title edit on an already-ready MR normalize to the
// identical shape. Only `changes` separates them, and it never crosses the seam.
//
// Real Postgres, the real webhook service, the real provider seam — no mocks, the
// `tests/gitlab/` convention.

const PASSWORD = 'hunter2hunter2';
const PROJECT_ID = '42';

interface Scenario {
  user: Awaited<ReturnType<typeof usersService.createUser>>;
  item: { id: string; identifier: string };
}

/** A workspace + project + work item, plus the GitLab connection and connected
 *  project row the resolver reads. Mirrors `gitlabWebhookService.test.ts`. */
async function makeScenario(email: string): Promise<Scenario> {
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
    { projectId: project.id, kind: 'task', title: 'A tracked change' },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);

  await withSystemContext(async (tx) => {
    const connection = await githubInstallationRepository.upsertGitlabConnection(
      {
        installationId: `gitlab-ws-${workspace.id}`,
        workspaceId: workspace.id,
        organizationId: workspace.organizationId,
        accountLogin: 'octocat',
        accountType: 'User',
        accessTokenEncrypted: 'enc',
        refreshTokenEncrypted: 'enc',
        tokenExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
      },
      tx,
    );
    await githubRepoRepository.upsert(
      {
        installationId: connection.id,
        workspaceId: workspace.id,
        organizationId: workspace.organizationId,
        repoId: PROJECT_ID,
        owner: 'octocat',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
      },
      tx,
    );
  });

  return { user, item };
}

/** A GitLab `merge_request` webhook body. `draft` is the MR's CURRENT draft state
 *  (what the seam normalizes); `changes` is what THIS delivery changed (what the
 *  gate reads) — the two are deliberately independent so a payload can be built
 *  that is inconsistent, which is a case the tests below exercise. */
function mrPayload(opts: {
  action: string;
  identifier: string;
  state?: 'opened' | 'closed' | 'merged' | 'locked';
  draft?: boolean;
  title?: string;
  changes?: Record<string, unknown>;
  iid?: number;
}) {
  return {
    object_kind: 'merge_request',
    project: { id: Number(PROJECT_ID) },
    object_attributes: {
      iid: opts.iid ?? 7,
      action: opts.action,
      state: opts.state ?? 'opened',
      draft: opts.draft ?? false,
      title: opts.title ?? `Some change (${opts.identifier})`,
      source_branch: `subtask/${opts.identifier}-a-change`,
      target_branch: 'main',
    },
    ...(opts.changes ? { changes: opts.changes } : {}),
  };
}

async function linkMr(identifier: string, iid = 7) {
  await linkPrByIdentifier({
    identifier,
    owner: 'octocat',
    name: 'acme',
    number: iid,
    headRef: `subtask/${identifier}-a-change`,
    baseRef: 'main',
    title: `Some change (${identifier})`,
  });
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await adminDb.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

/** Drive one delivery through the real dispatcher. */
function deliver(payload: ReturnType<typeof mrPayload>) {
  return gitlabWebhookService.handleEvent('Merge Request Hook', payload);
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('gitlabWebhookService — a draft MR that is marked READY', () => {
  it('drives the status sync and moves the linked card to implemented (AC1)', async () => {
    const s = await makeScenario('undraft@example.com');
    await linkMr(s.item.identifier);

    // The draft OPENS: recorded, nothing transitioned (MOTIR-4968's arm).
    const opened = await deliver(
      mrPayload({
        action: 'open',
        identifier: s.item.identifier,
        draft: true,
        title: `Draft: Some change (${s.item.identifier})`,
      }),
    );
    expect(opened).toMatchObject({ event: 'pull_request', outcome: 'no_lifecycle_change' });
    expect(await statusOf(s.item.id)).toBe('in_progress');

    // Marked READY — an `update` whose `changes.draft` cleared the flag. This is
    // the rung GitLab had no way to reach before MOTIR-5001.
    const ready = await deliver(
      mrPayload({
        action: 'update',
        identifier: s.item.identifier,
        draft: false,
        changes: {
          draft: { previous: true, current: false },
          title: {
            previous: `Draft: Some change (${s.item.identifier})`,
            current: `Some change (${s.item.identifier})`,
          },
        },
      }),
    );
    expect(ready).toMatchObject({
      event: 'pull_request',
      outcome: 'transitioned',
      toStatus: 'implemented',
    });
    expect(await statusOf(s.item.id)).toBe('implemented');
  });

  it('treats a LEGACY payload — `changes.title` losing its `Draft: ` prefix, no `changes.draft` — as un-drafting (AC3)', async () => {
    // Self-hosted GitLab lags the SaaS release by arbitrary amounts, so this is not
    // dead code on a schedule: it is the only tell some deployments emit.
    const s = await makeScenario('legacy@example.com');
    await linkMr(s.item.identifier);

    await deliver(
      mrPayload({
        action: 'open',
        identifier: s.item.identifier,
        draft: true,
        title: `Draft: Some change (${s.item.identifier})`,
      }),
    );
    expect(await statusOf(s.item.id)).toBe('in_progress');

    const ready = await deliver(
      mrPayload({
        action: 'update',
        identifier: s.item.identifier,
        draft: false,
        changes: {
          title: {
            previous: `Draft: Some change (${s.item.identifier})`,
            current: `Some change (${s.item.identifier})`,
          },
        },
      }),
    );
    expect(ready).toMatchObject({ outcome: 'transitioned', toStatus: 'implemented' });
    expect(await statusOf(s.item.id)).toBe('implemented');
  });

  it.each([
    ['[Draft]', '[Draft] Some change', 'Some change'],
    ['(Draft)', '(Draft) Some change', 'Some change'],
    ['WIP:', 'WIP: Some change', 'Some change'],
    ['[WIP]', '[WIP] Some change', 'Some change'],
  ])(
    'reads the pre-14.0 / bracketed draft prefix %s off the legacy title tell (AC3)',
    async (prefix, previous, current) => {
      const s = await makeScenario(`legacy-${prefix.replace(/\W/g, '')}@example.com`);
      await linkMr(s.item.identifier);
      await deliver(
        mrPayload({ action: 'open', identifier: s.item.identifier, draft: true, title: previous }),
      );

      const ready = await deliver(
        mrPayload({
          action: 'update',
          identifier: s.item.identifier,
          draft: false,
          changes: { title: { previous, current } },
        }),
      );
      expect(ready).toMatchObject({ outcome: 'transitioned', toStatus: 'implemented' });
      expect(await statusOf(s.item.id)).toBe('implemented');
    },
  );

  it('an `update` that SETS the draft flag transitions NOTHING — it is not the inverse rung (AC4)', async () => {
    const s = await makeScenario('redraft@example.com');
    await linkMr(s.item.identifier);

    // Ready first, so the card is at `implemented` and a regression would be visible
    // as a move rather than as an absence.
    await deliver(mrPayload({ action: 'open', identifier: s.item.identifier, draft: false }));
    expect(await statusOf(s.item.id)).toBe('implemented');

    const redrafted = await deliver(
      mrPayload({
        action: 'update',
        identifier: s.item.identifier,
        draft: true,
        title: `Draft: Some change (${s.item.identifier})`,
        changes: {
          draft: { previous: false, current: true },
          title: {
            previous: `Some change (${s.item.identifier})`,
            current: `Draft: Some change (${s.item.identifier})`,
          },
        },
      }),
    );
    // Ignored at the GATE — the card stays exactly where it was.
    expect(redrafted).toMatchObject({ event: 'pull_request', outcome: 'ignored_action' });
    expect(await statusOf(s.item.id)).toBe('implemented');
  });
});

// THE CRITERION THAT PROVES THE PREDICATE IS NARROW rather than the action being
// handled (AC2). Every shape below is an `update` — the action `HANDLED_MR_ACTIONS`
// still does not contain — and every one must be `ignored_action`. The gate returns
// before any database work, so these need no scenario: the assertion IS that
// nothing downstream is reached.
describe('gitlabWebhookService — an `update` that does NOT clear the draft flag stays ignored (AC2)', () => {
  const base = { action: 'update', identifier: 'ACME-1' } as const;

  it.each([
    ['a new commit — no `changes` object at all', undefined],
    ['a label change', { labels: { previous: [], current: [{ title: 'bug' }] } }],
    ['an assignee change', { assignees: { previous: [], current: [{ id: 3 }] } }],
    ['an update_at touch carrying no draft or title key', { updated_at: { previous: 'a' } }],
    [
      'a title edit on a NON-draft MR — neither side carries a draft prefix',
      { title: { previous: 'Some change', current: 'Some other change' } },
    ],
    [
      'a title edit that leaves the MR a draft — the prefix survives',
      { title: { previous: 'Draft: one', current: 'Draft: two' } },
    ],
    [
      'a title edit that ADDS the prefix — drafting, not un-drafting',
      { title: { previous: 'Some change', current: 'Draft: Some change' } },
    ],
    ['a `changes.title` whose sides are not strings', { title: { previous: null, current: 42 } }],
    [
      'a `changes.draft` whose sides are not booleans',
      { draft: { previous: 'true', current: 'false' } },
    ],
    ['a `changes.draft` present but unchanged', { draft: { previous: false, current: false } }],
    ['a `changes` that is not an object', undefined],
  ])('%s', async (_label, changes) => {
    const res = await deliver(mrPayload({ ...base, changes }));
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'ignored_action' });
  });

  it('`changes.draft` is AUTHORITATIVE — a set-draft delivery is ignored even when its title lost a prefix', async () => {
    // The two tells disagree, which is possible because a payload is data rather
    // than a proof. The modern key wins in BOTH directions, so the legacy arm can
    // never re-admit a delivery the modern one just refused.
    const res = await deliver(
      mrPayload({
        ...base,
        changes: {
          draft: { previous: false, current: true },
          title: { previous: 'Draft: one', current: 'one' },
        },
      }),
    );
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'ignored_action' });
  });

  it('a non-`update` action outside the handled set is still ignored, predicate or not', async () => {
    const res = await deliver(
      mrPayload({
        ...base,
        action: 'approved',
        changes: { draft: { previous: true, current: false } },
      }),
    );
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'ignored_action' });
  });
});

describe('gitlabWebhookService — the un-draft gate does not disturb the four handled actions', () => {
  it('`open` / `merge` still drive the sync with no `changes` object present', async () => {
    const s = await makeScenario('handled@example.com');
    await linkMr(s.item.identifier);

    const opened = await deliver(mrPayload({ action: 'open', identifier: s.item.identifier }));
    expect(opened).toMatchObject({ outcome: 'transitioned', toStatus: 'implemented' });

    const merged = await deliver(
      mrPayload({ action: 'merge', state: 'merged', identifier: s.item.identifier }),
    );
    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
  });

  it('an un-drafting delivery whose MR is somehow STILL a draft carries no lifecycle — the seam decides, not the gate', async () => {
    // The gate admits the delivery; `changeRequestLifecycle` reads the MR's own
    // state and returns null. Nothing transitions, and that is correct: the gate
    // answers "is this worth looking at", never "what does it mean".
    const s = await makeScenario('inconsistent@example.com');
    await linkMr(s.item.identifier);

    const res = await deliver(
      mrPayload({
        action: 'update',
        identifier: s.item.identifier,
        draft: true,
        changes: { draft: { previous: true, current: false } },
      }),
    );
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'no_lifecycle_change' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
  });
});
