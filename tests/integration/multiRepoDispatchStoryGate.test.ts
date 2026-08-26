import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/v1/work-items/[key]/dispatch-prompt/route';
import { db } from '@/lib/db';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { workItemsService } from '@/lib/services/workItemsService';
import { toWorkItemDto } from '@/lib/mappers/workItemMappers';
import { dispatchPromptSchema, type V1DispatchPrompt } from '@/lib/api/v1/workLoop/schema';
import { presentWorkItemDetail, workItemDetailSchema } from '@/lib/api/v1/workItems/schema';
import { ArchivedTargetRepoError } from '@/lib/workItems/errors';
import { createV1ProjectCaller, type V1ProjectCaller } from '../fixtures/apiV1Fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { randomToken } from '../helpers/random';

// STORY GATE for MOTIR-2731 — running a card that ships in more than one
// repository (Subtask MOTIR-3140).
//
// This file asserts only what a GATE can: the seams BETWEEN the story's
// subtasks, on their real, assembled behaviour, against a real Postgres. The
// per-subtask suites already prove each half in isolation; two mocked halves
// agreeing is exactly the state in which a contract has already drifted.
//
// The four things only this file is positioned to see:
//
//   1. The PAYLOAD and the DETAIL read answer from ONE classifier — repository
//      for repository, on the same card, at the same moment. The story exists
//      because a panel saying `delivered` while the gate holds the card is the
//      one bug this surface has no defence against, and adding a third
//      derivation inside the dispatch payload would have reproduced it.
//   2. The payload and the PROMPT GRAMMAR agree about the COUNT. They are
//      written by two cards (MOTIR-3131, MOTIR-3132) and read by one agent; a
//      set of two with a prompt that instructs one pull request is the exact
//      failure the story is about, and it can only be seen with both in hand.
//   3. The SCALAR IS A PROJECTION, over zero, one and N repositories, on the DTO
//      and on the published payload — so `targetRepo` can never become a second
//      fact about where a card ships.
//   4. SINGLE-REPOSITORY INVARIANCE. Every card in the tenant today pins one
//      repository, and none of them may be able to tell that this story shipped.

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
});

const BASE = 'http://localhost:3000/api/v1';

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

/** A MERGED pull request onto that repository's own default branch. */
async function mergedPr(repoId: string, workItemId: string, baseRef: string, number: number) {
  await adminDb.githubPullRequest.create({
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
}

describe('1 — the PAYLOAD and the DETAIL read answer from one classifier', () => {
  it('agrees repository for repository, on the same card, at the same moment', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const coreId = await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai', { defaultBranch: 'trunk' });
    const item = await card(caller, 'half shipped', ['motir-core', 'motir-ai']);
    await mergedPr(coreId, item.id, 'main', 1);

    // The RUN's view…
    const body = await payload(caller, item.identifier);
    // …and the PERSON's, off the quick-view payload the panel renders from —
    // the ONLY place `repoDelivery` is published today.
    const peek = await workItemsService.getQuickView(
      caller.fixture.projectId,
      item.identifier,
      'open',
      caller.ctx,
      'en',
    );

    expect(body.targetRepos.map((r) => ({ repo: r.name, state: r.delivery }))).toEqual(
      peek.repoDelivery.map((d) => ({ repo: d.repo, state: d.state })),
    );
    // …and they say something, rather than agreeing on an empty list.
    expect(body.targetRepos.map((r) => r.delivery)).toEqual(['delivered', 'awaiting']);
  });
});

describe('2 — the payload and the PROMPT agree about the COUNT', () => {
  it('a two-repository card carries two pull-request instructions, on the same response', async () => {
    // The story's own failure, asserted where it would actually bite: a payload
    // that says two and a prompt that instructs one is a run that opens a single
    // pull request and leaves the card held forever. Both halves are read off
    // ONE response here, because that is the only place the disagreement exists.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai', { defaultBranch: 'trunk' });
    const item = await card(caller, 'two halves', ['motir-core', 'motir-ai']);

    const body = await payload(caller, item.identifier);

    expect(() => dispatchPromptSchema.parse(body)).not.toThrow();
    expect(body.targetRepos).toHaveLength(2);
    // MOTIR-3529 — UPDATED, not removed. It used to count `TITLE carries`
    // lines. The property is the same and is the reason this gate exists — ONE
    // instruction per repository, because each repository has its own pull
    // request — but the instruction is now the LINK call rather than the title,
    // which is a string the sync had to guess at.
    const prInstructions = body.prompt
      .split('\n')
      .filter((line) => line.includes('LINK it: call the link_pull_request tool'));
    expect(prInstructions).toHaveLength(body.targetRepos.length);
    // The key stays in every title, re-framed as a label for a human reader.
    const titleLabels = body.prompt
      .split('\n')
      .filter((line) => line.includes('in the TITLE as well'));
    expect(titleLabels).toHaveLength(body.targetRepos.length);
    for (const repo of body.targetRepos) {
      expect(body.prompt).toContain(`git worktree add ../${repo.name}-`);
    }
    // Each repository is branched from ITS OWN default branch, which only the
    // payload knows — so the grammar is reading the set, not guessing.
    expect(body.prompt).toContain('origin/trunk');
  });
});

describe('3 — the scalar is a PROJECTION, on both surfaces', () => {
  it('holds for zero, one and N repositories, on the DTO and on the published payload', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai');
    const fixtures = [
      await card(caller, 'zero'),
      await card(caller, 'one', ['motir-core']),
      await card(caller, 'two', ['motir-ai', 'motir-core']),
    ];

    for (const item of fixtures) {
      const body = await payload(caller, item.identifier);
      expect(body.targetRepos[0]?.name ?? null).toBe(body.targetRepo);

      // …and the ITEM shape's own projection, off the row rather than off the
      // create's return value — two mocked halves agreeing is how a key drifts.
      const row = await adminDb.workItem.findUnique({ where: { id: item.id } });
      const dto = toWorkItemDto(row!);
      expect(dto.targetRepos[0] ?? null).toBe(dto.targetRepo);
      const detail = await workItemsService.getIssueDetail(
        caller.fixture.projectId,
        item.identifier,
        caller.ctx,
      );
      const published = workItemDetailSchema.parse(presentWorkItemDetail(detail, 0, {}));
      expect(published.targetRepos[0] ?? null).toBe(published.targetRepo);
    }
  });
});

describe('4 — SINGLE-REPOSITORY invariance', () => {
  it('leaves the prompt text and the three scalars untouched for a one-repo and an unpinned card', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core');
    const one = await card(caller, 'ordinary card', ['motir-core']);
    const unpinned = await card(caller, 'unpinned card');

    const [a, b] = await Promise.all([
      payload(caller, one.identifier),
      payload(caller, unpinned.identifier),
    ]);

    for (const body of [a!, b!]) {
      // ONE worktree instruction, ONE pull request, and no repositories block —
      // the shipped grammar, byte for byte where it can be quoted.
      expect(body.prompt.match(/git worktree add/g)).toHaveLength(1);
      expect(body.prompt).toContain(
        'This item has no session lineage, so it ships as ONE pull request of its own.',
      );
      // MOTIR-3529 renumbered this: the LINK call is now step 6, so the STOP
      // is 7. The step it asserts is unchanged — only its ordinal moved.
      expect(body.prompt).toContain(
        '7. STOP at the open pull request. Do not merge it and do not delete the branch.',
      );
      expect(body.prompt).toContain('6. LINK it: call the link_pull_request tool');
      expect(body.prompt).not.toContain('Repositories (');
    }
    // The three scalars still say what they always said. The project has exactly
    // one repository, so the unpinned card resolves to it through rung 2 —
    // unchanged behaviour, and the array follows the scalar rather than the
    // other way round.
    expect(a!.targetRepo).toBe('motir-core');
    expect(b!.targetRepo).toBe('motir-core');
    expect(a!.targetRepoDefaultBranch).toBe('main');
  });
});

describe('5 — the refusals and the tenant boundary on the new read path', () => {
  it('raises the typed archived refusal for a NON-PRIMARY repository of the set', async () => {
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai', { archived: true });
    const item = await card(caller, 'archived half', ['motir-core', 'motir-ai']);

    await expect(
      dispatchPromptService.getDispatchPrompt(
        caller.fixture.projectId,
        item.identifier,
        caller.ctx,
      ),
    ).rejects.toThrow(ArchivedTargetRepoError);
  });

  it('does not read another tenant’s multi-repository card through the dispatch route', async () => {
    // An unknown key and another workspace's key must be indistinguishable — no
    // existence leak — and the new array must not become the one field that
    // answers before the gate does.
    const mine = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    const theirs = await createV1ProjectCaller({
      scopes: ['read', 'work_items:write'],
      workspaceName: 'other-tenant',
      identifier: 'OTHR',
    });
    await connectRepo(theirs, 'motir-core');
    await connectRepo(theirs, 'motir-ai');
    const foreign = await card(theirs, 'their card', ['motir-core', 'motir-ai']);

    const res = await GET(
      new Request(`${BASE}/work-items/${foreign.identifier}/dispatch-prompt`, {
        headers: mine.headers,
      }),
      { params: Promise.resolve({ key: foreign.identifier }) },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain('motir-ai');
  });

  it('resolves the references inside a BOUND transaction — an unbound read would say “no repositories”', async () => {
    // The failure `lib/workItems/expectedRepos.ts` documents: the join table is
    // RLS-gated on a GUC bound only on a transaction, and an unbound read
    // returns `[]` — indistinguishable from "this card has no repositories",
    // which is the worse of the two failures. Asserted by OUTCOME: a card with
    // two references resolves two, through the shipped route.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai');
    const item = await card(caller, 'bound read', ['motir-core', 'motir-ai']);

    const body = await payload(caller, item.identifier);
    expect(body.targetRepos.map((r) => r.name)).toEqual(['motir-core', 'motir-ai']);
  });
});

describe('6 — ONE derivation, not three', () => {
  it('the payload answers from `listRepoDelivery`, not from a private re-implementation', async () => {
    // Structural, deliberately. A test that compared two hand-written
    // expectations would pass just as happily against a second classifier living
    // inside the dispatch service — which is the defect `repoDelivery.ts` was
    // written to prevent one level down, reproduced one level up where nothing
    // could see the disagreement.
    const caller = await createV1ProjectCaller({ scopes: ['read', 'work_items:write'] });
    await connectRepo(caller, 'motir-core');
    await connectRepo(caller, 'motir-ai');
    const item = await card(caller, 'delegation', ['motir-core', 'motir-ai']);

    const spy = vi.spyOn(workItemsService, 'listRepoDelivery');
    try {
      await dispatchPromptService.getDispatchPrompt(
        caller.fixture.projectId,
        item.identifier,
        caller.ctx,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[0]).toBe(item.id);
    } finally {
      spy.mockRestore();
    }
  });
});
