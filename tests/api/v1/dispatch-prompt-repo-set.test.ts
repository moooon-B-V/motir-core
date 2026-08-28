import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/v1/work-items/[key]/dispatch-prompt/route';
import { db } from '@/lib/db';
import { dispatchPromptSchema, type V1DispatchPrompt } from '@/lib/api/v1/workLoop/schema';
import { V1_CONTRACT_VERSION } from '@/lib/api/v1/contractVersion';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { workItemsService } from '@/lib/services/workItemsService';
import { runDispatchPrompt } from '@/lib/mcp/tools/dispatchPrompt';
import { ArchivedTargetRepoError } from '@/lib/workItems/errors';
import { createV1ProjectCaller, type V1ProjectCaller } from '../../fixtures/apiV1Fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { randomToken } from '../../helpers/random';

// The dispatch payload carries the WHOLE repository set (Story MOTIR-2731 ·
// MOTIR-3131 — ADR `work-item-repository-set.md` § *Amendment 2026-08-19* §B1).
//
// The property under test is NOT "the payload has a `targetRepos`". It is the
// pair of claims the amendment makes, either of which failing silently is what
// this card exists to prevent:
//
//   1. **The scalar is a PROJECTION** — `targetRepos[0]?.name ?? null ===
//      targetRepo`, for EVERY item, including the unpinned card whose repository
//      is answered by its project's single one. A card where the two disagree is
//      a card the CLI and the completion gate would route differently.
//   2. **The envelope changed and the GRAMMAR did not** — the assembled `prompt`
//      text is byte-identical to what a one-repo, an unpinned AND a two-repo card
//      got before this card. The prompt is MOTIR-3132's; asserting it here is
//      what keeps the two separable.
//
// Real Postgres, the shipped route, and the shipped presenter — a fixture that
// mocked the resolve would agree with itself about a set nobody stored.

const BASE = 'http://localhost:3000/api/v1';

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

async function connectRepo(
  caller: V1ProjectCaller,
  name: string,
  opts: { defaultBranch?: string; archived?: boolean } = {},
): Promise<string> {
  const inst = await adminDb.githubInstallation.upsert({
    where: { installationId: `inst-${caller.fixture.workspaceId}` },
    create: {
      installationId: `inst-${caller.fixture.workspaceId}`,
      workspaceId: caller.fixture.workspaceId,
      accountLogin: 'moooon',
      accountType: 'Organization',
      provider: 'github',
    },
    update: {},
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      installationId: inst.id,
      workspaceId: caller.fixture.workspaceId,
      repoId: `repo-${randomToken(8)}`,
      owner: 'moooon',
      name,
      defaultBranch: opts.defaultBranch ?? 'main',
      archived: opts.archived ?? false,
      provider: 'github',
    },
  });
  return repo.id;
}

async function card(caller: V1ProjectCaller, title: string, targetRepos?: string[]) {
  return workItemsService.createWorkItem(
    {
      projectId: caller.fixture.projectId,
      kind: 'task',
      title,
      ...(targetRepos ? { targetRepos } : {}),
    },
    caller.ctx,
  );
}

async function payload(caller: V1ProjectCaller, key: string): Promise<V1DispatchPrompt> {
  const res = await GET(
    new Request(`${BASE}/work-items/${key}/dispatch-prompt`, { headers: caller.headers }),
    { params: Promise.resolve({ key }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as V1DispatchPrompt;
}

/** A MERGED pull request onto that repository's own default branch — the one
 *  thing that makes a repository `delivered` (`lib/workItems/repoDelivery.ts`).
 *
 *  ⚠️ IT WRITES BOTH HALVES OF THE LINK (MOTIR-3721), because the database does.
 *  The completion FACTS the classifier reads now come from `work_item_delivery`,
 *  and every row that carries a `github_pull_request.work_item_id` carries a
 *  delivery row too: the delivery table's migration backfilled all of them, and
 *  both live writers (`link_pull_request`, `mark_integrated`) write the pair. A
 *  fixture writing only the column would be describing a state that exists on no
 *  migrated database, and would assert the absence of a link rather than the
 *  classifier. */
async function mergedPr(repoId: string, workItemId: string, baseRef: string, number: number) {
  const row = await adminDb.githubPullRequest.create({
    data: {
      repoId,
      workItemId,
      number,
      state: 'closed',
      merged: true,
      headRef: `subtask/pr-${number}`,
      baseRef,
      mergedAt: new Date('2026-08-19T09:00:00.000Z'),
    },
  });
  const repo = await adminDb.githubRepo.findUniqueOrThrow({ where: { id: repoId } });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: repo.workspaceId,
      workItemId,
      githubPullRequestId: row.id,
      repoId,
    },
  });
}

describe('targetRepos — the whole set, ordered, primary first', () => {
  it('returns [] for a card Motir cannot place, and the scalars stay null', async () => {
    // Two connected repositories, no pin: `resolveDispatchRepo`'s second rung
    // declines to guess (there is no non-arbitrary choice), so BOTH the scalar
    // and the array say "Motir cannot say" — in agreement, which is the point.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai');
    const item = await card(caller, 'unplaceable');

    const body = await payload(caller, item.identifier);

    expect(() => dispatchPromptSchema.parse(body)).not.toThrow();
    expect(body.targetRepos).toEqual([]);
    expect(body.targetRepo).toBeNull();
    expect(body.targetRepoCloneUrl).toBeNull();
    expect(body.targetRepoDefaultBranch).toBeNull();
  });

  it('returns ONE element for a single-repo card, equal to the scalars field for field', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core', { defaultBranch: 'trunk' });
    const item = await card(caller, 'one repo', ['motir-core']);

    const body = await payload(caller, item.identifier);

    expect(body.targetRepos).toHaveLength(1);
    expect(body.targetRepos[0]).toMatchObject({
      name: body.targetRepo,
      cloneUrl: body.targetRepoCloneUrl,
      defaultBranch: body.targetRepoDefaultBranch,
    });
    // The mirrored branch, never a guessed "main".
    expect(body.targetRepoDefaultBranch).toBe('trunk');
  });

  it('returns N elements IN THE AUTHORED ORDER, primary first, each with its own coordinates', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai', { defaultBranch: 'trunk' });
    // Deliberately NOT alphabetical and NOT the order the repos were connected:
    // the set's order is the author's, and element 0 is the primary.
    const item = await card(caller, 'two repos', ['motir-ai', 'motir-core']);

    const body = await payload(caller, item.identifier);

    expect(body.targetRepos.map((r) => r.name)).toEqual(['motir-ai', 'motir-core']);
    expect(body.targetRepos.map((r) => r.defaultBranch)).toEqual(['trunk', 'main']);
    expect(body.targetRepo).toBe('motir-ai');
  });

  it('keeps `targetRepo` a PROJECTION of the array — including for an unpinned card the project places', async () => {
    // The case the invariant would otherwise be false for. The card pins
    // nothing, so it has no set of its own; the project has exactly ONE
    // repository, so `resolveDispatchRepo`'s second rung answers with it and the
    // dispatch has somewhere to run. The array carries that one element — with a
    // null delivery, because the completion gate does not hold this card on it.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core');
    const unpinned = await card(caller, 'unpinned, one-repo project');

    const body = await payload(caller, unpinned.identifier);

    expect(body.targetRepo).toBe('motir-core');
    expect(body.targetRepos).toEqual([
      {
        name: 'motir-core',
        cloneUrl: body.targetRepoCloneUrl,
        defaultBranch: 'main',
        delivery: null,
      },
    ]);
    expect(body.targetRepoCloneUrl).not.toBeNull();
    expect(body.targetRepos[0]?.name ?? null).toBe(body.targetRepo);
  });
});

describe('the per-repository DELIVERY state', () => {
  it('distinguishes a delivered repository from an awaiting one, without a second request', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const coreId = await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai');
    const item = await card(caller, 'half shipped', ['motir-core', 'motir-ai']);
    await mergedPr(coreId, item.id, 'main', 1);

    const body = await payload(caller, item.identifier);

    expect(body.targetRepos.map((r) => [r.name, r.delivery])).toEqual([
      ['motir-core', 'delivered'],
      ['motir-ai', 'awaiting'],
    ]);
  });

  it('answers from the SHARED classifier — the payload and `listRepoDelivery` agree element for element', async () => {
    // The story's real claim. A third derivation of "has this repository's work
    // landed?" is the defect `lib/workItems/repoDelivery.ts` was written to
    // prevent one level down; this asserts the dispatch payload did not become
    // one, rather than asserting it in a comment.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const coreId = await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai');
    const item = await card(caller, 'shared classifier', ['motir-core', 'motir-ai']);
    await mergedPr(coreId, item.id, 'main', 7);

    const body = await payload(caller, item.identifier);
    const row = await adminDb.workItem.findUnique({ where: { id: item.id } });
    const classified = await workItemsService.listRepoDelivery(
      item.id,
      row!.targetRepos,
      caller.ctx,
    );

    expect(body.targetRepos.map((r) => ({ repo: r.name, state: r.delivery }))).toEqual(
      classified.map((d) => ({ repo: d.repo, state: d.state })),
    );
  });

  it('reads a merge onto a NON-default branch as awaiting, exactly as the gate does', async () => {
    // Not a shade of the same answer: a merge that never reached the trunk has
    // not shipped, and the payload must not report it as if it had.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const coreId = await connectRepo(caller, 'motir-core');
    const item = await card(caller, 'merged onto a side branch', ['motir-core']);
    await mergedPr(coreId, item.id, 'release/1.x', 3);

    const body = await payload(caller, item.identifier);

    expect(body.targetRepos[0]?.delivery).toBe('awaiting');
  });
});

describe('the ARCHIVED refusal covers the whole set (§B5)', () => {
  it('throws ArchivedTargetRepoError naming a NON-PRIMARY archived repository', async () => {
    // §2 already refused an archived PRIMARY. A non-primary archived repository
    // is the worse of the two: the run appears to succeed while the completion
    // gate holds the card forever on work that can never merge, because a
    // read-only repository accepts no branch and no pull request.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai', { archived: true });
    const item = await card(caller, 'archived second half', ['motir-core', 'motir-ai']);

    await expect(
      dispatchPromptService.getDispatchPrompt(
        caller.fixture.projectId,
        item.identifier,
        caller.ctx,
      ),
    ).rejects.toThrow(ArchivedTargetRepoError);
    await expect(
      dispatchPromptService.getDispatchPrompt(
        caller.fixture.projectId,
        item.identifier,
        caller.ctx,
      ),
    ).rejects.toThrow(/motir-ai/);
  });
});

describe('the ENVELOPE changed and the GRAMMAR did not (MOTIR-3131)', () => {
  it('leaves the one-repo and unpinned GIT WORKFLOW exactly as it shipped', async () => {
    // MOTIR-3131 changed the PAYLOAD. The prompt's `GIT WORKFLOW` section is
    // MOTIR-3132's, and it moves ONLY for a card with two or more repositories —
    // so the shapes every existing card has must still render the shipped
    // single-pull-request text, stated as the literal it must not drift from.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai');
    const unpinned = await card(caller, 'grammar unpinned');
    const one = await card(caller, 'grammar one', ['motir-core']);

    const [a, b] = await Promise.all([
      payload(caller, unpinned.identifier),
      payload(caller, one.identifier),
    ]);

    for (const body of [a!, b!]) {
      expect(body.prompt).toContain(
        'This item has no session lineage, so it ships as ONE pull request of its own.',
      );
      // MOTIR-3529 renumbered this: the LINK call is step 6, so the STOP is 7.
      expect(body.prompt).toContain(
        '7. STOP at the open pull request. Do not merge it and do not delete the branch.',
      );
      // ONE worktree instruction, not N.
      expect(body.prompt.match(/git worktree add/g)).toHaveLength(1);
      expect(body.prompt).not.toContain('Repositories (');
    }
    // The unpinned card's worktree line is `../<repo>-…` — generic, and that is
    // the ONE documented difference `worktreeDir` renders for it.
    expect(a!.prompt).toContain('<repo>-');
    expect(b!.prompt).toContain('motir-core-');
    // Neither names the OTHER connected repository: a card's prompt is about the
    // card's own repositories, never the project's.
    expect(b!.prompt).not.toContain('motir-ai');
  });
});

describe('the MCP text names every repository — and only when there is more than one', () => {
  it('renders the single `Repo:` line for one repository and for none', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai');
    const one = await card(caller, 'mcp one', ['motir-core']);
    const none = await card(caller, 'mcp none');

    const oneResult = await runDispatchPrompt({ key: one.identifier }, caller.ctx);
    const noneResult = await runDispatchPrompt({ key: none.identifier }, caller.ctx);

    expect(String((oneResult.content as { text: string }[])[0]!.text)).toContain(
      'Repo: motir-core',
    );
    expect(String((noneResult.content as { text: string }[])[0]!.text)).toContain(
      'Repo: not pinned (Motir cannot say)',
    );
  });

  it('names every repository, in order, with its delivery state when there is more than one', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const coreId = await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai');
    const item = await card(caller, 'mcp two', ['motir-core', 'motir-ai']);
    await mergedPr(coreId, item.id, 'main', 11);

    const result = await runDispatchPrompt({ key: item.identifier }, caller.ctx);
    const text = String((result.content as { text: string }[])[0]!.text);

    expect(text).toContain('Repos (2): motir-core (primary) — delivered, motir-ai — awaiting');
  });
});

describe('the contract version says the payload grew', () => {
  it('moves past 1.11.0, the last release that predates the dispatch set', () => {
    // A monotonic floor, not an equality: pinning the exact string makes the
    // NEXT additive change under §8 red-light itself on a guard belonging to a
    // card it does not touch (the lesson MOTIR-2903 left one file over).
    const [major, minor] = V1_CONTRACT_VERSION.split('.').map(Number);
    expect(major).toBe(1);
    expect(minor).toBeGreaterThanOrEqual(12);
  });

  it('declares `targetRepos` on the dispatch shape without removing a scalar', () => {
    const shape = dispatchPromptSchema.shape;
    expect(shape).toHaveProperty('targetRepos');
    expect(shape).toHaveProperty('targetRepo');
    expect(shape).toHaveProperty('targetRepoCloneUrl');
    expect(shape).toHaveProperty('targetRepoDefaultBranch');
  });
});
