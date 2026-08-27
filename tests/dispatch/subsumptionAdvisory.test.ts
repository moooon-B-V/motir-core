import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  buildDispatchProseAdvisories,
  buildProseVsGraphAdvisories,
} from '@/lib/services/proseGraphAdvisoryService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { runClaimNextReady } from '@/lib/mcp/tools/claimNextReady';
import { runDispatchPrompt } from '@/lib/mcp/tools/dispatchPrompt';
import { runValidateWorkItem } from '@/lib/mcp/tools/validateWorkItem';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { isSubsumptionAdvisory, type WorkItemProseAdvisoryDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// THE SUBSUMPTION ADVISORY (MOTIR-2903) — over REAL Postgres.
//
// The defect this pins: MOTIR-2757 sat `todo` / `high` / `readiness.ready: true`
// / `openBlockers: []` / `validate_work_item.valid: true` / `advisories: []` for
// two days after MOTIR-2796's sweep shipped its entire deliverable, and a run
// claimed it. Every plan-side signal was green and every one was wrong, because
// the only artifact where the overlap is a FACT is the merged diff — the card
// that absorbed it names not one of its methods, paths or symbols.
//
// So the calibration below is the card's criterion 4, verbatim: the real
// MOTIR-2757 state FIRES, the real MOTIR-1715/MOTIR-1502 state FIRES, and a
// genuinely-ready card in the same project does NOT. The bodies are the real
// ones, reduced to the sentences that carry a path; the merges are the real
// commits' paths and dates. Invented input would calibrate the check on itself.
//
// ⚠️ AND the invariant that makes it safe: READINESS IS BYTE-IDENTICAL. This is
// a heuristic that fails toward the false positive — two cards touching one file
// in sequence is the ordinary case — so every readiness assertion here exists to
// fail loudly if someone "improves" it into a blocker.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const FILED = new Date('2026-08-12T10:00:00Z');
const SWEEP_MERGED = new Date('2026-08-15T14:00:00Z');

/** MOTIR-2757's body, reduced to the sentences that carry a path. The path the
 *  sweep took (`lib/services/workflowsService.ts`) is in CONTEXT REFS; the only
 *  path in the acceptance criteria is a test file the sweep never touched. */
const MOTIR_2757_BODY = [
  "`workflowsService`'s three read methods read on the `db` singleton and return",
  'nothing under `motir_app`.',
  '',
  '## Acceptance criteria',
  '',
  '- `tests/permissions/userlessTenantRead.test.ts` proves the bound path returns rows.',
  '',
  '## Context refs',
  '',
  '- `lib/services/workflowsService.ts` — the unbound read surface.',
].join('\n');

/** MOTIR-1502's shape: the deliverable MOTIR-852 absorbed. */
const MOTIR_1502_BODY = [
  'Augment retrieval instruments — the skeleton read plus a minimal',
  '`search_work_items` over the shipped FilterAST.',
  '',
  '## Acceptance criteria',
  '',
  '- `lib/mcp/tools/searchWorkItems.ts` exposes the tool.',
].join('\n');

/** A card whose paths NOTHING has merged against — the negative control. */
const GENUINELY_READY_BODY = [
  'Add the repository-set quick view to the project header.',
  '',
  '## Acceptance criteria',
  '',
  '- `components/projects/RepositorySetQuickView.tsx` renders the connected set.',
].join('\n');

async function connectRepo(fx: WorkItemFixture, name = 'motir-core') {
  await githubInstallationService.persistInstallation({
    workspaceId: fx.workspaceId,
    installation: {
      installationId: `inst-${name}`,
      accountLogin: 'moooon-B-V',
      accountType: 'Organization',
    },
    repos: [
      {
        providerRepoId: `pr-${name}`,
        owner: 'moooon-B-V',
        name,
        defaultBranch: 'main',
        archived: false,
      },
    ],
  });
  return adminDb.githubRepo.findFirstOrThrow({ where: { repoId: `pr-${name}` } });
}

/** Seed ONE merged pull request as data — these cases are about the CHECK, not
 *  about the webhook that writes the row (MOTIR-2922 owns that). */
async function seedMerge(
  repoId: string,
  opts: {
    number: number;
    changedPaths: string[];
    /** `undefined` takes the default merge instant; an explicit `null` is the
     *  pre-capture row, and the OPEN arm's rows (MOTIR-3230). */
    mergedAt?: Date | null;
    workItemId?: string | null;
    title?: string | null;
    merged?: boolean;
    state?: string;
  },
) {
  return adminDb.githubPullRequest.create({
    data: {
      repoId,
      number: opts.number,
      state: opts.state ?? 'closed',
      merged: opts.merged ?? true,
      headRef: `subtask/MOTIR-${opts.number}`,
      title: opts.title === undefined ? 'Bind the READ surface for motir_app' : opts.title,
      mergedAt: opts.mergedAt === undefined ? SWEEP_MERGED : opts.mergedAt,
      changedPaths: opts.changedPaths,
      workItemId: opts.workItemId ?? null,
    },
  });
}

/** Create a card and BACKDATE its `createdAt` — "merged after this card was
 *  filed" is half the rule, so the fixture has to control both instants. */
async function makeCard(
  fx: WorkItemFixture,
  title: string,
  descriptionMd: string,
  createdAt: Date = FILED,
  targetRepo: string | null = 'motir-core',
) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'bug', title, descriptionMd, targetRepo },
    fx.ctx,
  );
  await adminDb.workItem.update({ where: { id: item.id }, data: { createdAt } });
  return { ...item, createdAt: createdAt.toISOString() };
}

const subsumptions = (advisories: WorkItemProseAdvisoryDto[]) =>
  advisories.filter(isSubsumptionAdvisory);

describe('the retro-check — criterion 4, on the real incidents', () => {
  it('MOTIR-2757 FIRES: the sweep touched a path in its Context refs, three days after it was filed', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(
      fx,
      "workflowsService's READ SURFACE is unbound too",
      MOTIR_2757_BODY,
    );
    await seedMerge(repo.id, {
      number: 2059,
      changedPaths: ['lib/services/workflowsService.ts', 'lib/services/sprintsService.ts'],
    });

    const advisories = await buildDispatchProseAdvisories(card, fx.ctx);
    const found = subsumptions(advisories);

    expect(found).toEqual([
      {
        kind: 'subsumption',
        item: card.identifier,
        severity: 'likely-already-shipped',
        path: 'lib/services/workflowsService.ts',
        pullRequest: 'moooon-B-V/motir-core#2059',
        pullRequestTitle: 'Bind the READ surface for motir_app',
        state: 'merged',
        mergedAt: SWEEP_MERGED.toISOString(),
      },
    ]);
    // The whole point: readiness said this card was startable, and still does.
    const readiness = await workItemsService.getReadiness(card.id, fx.ctx);
    expect(readiness.ready).toBe(true);
    expect([...readiness.openBlockerIds]).toEqual([]);
  });

  it('MOTIR-1715 FIRES: MOTIR-1502, absorbed by a later card that shipped its deliverable', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'Augment retrieval instruments', MOTIR_1502_BODY);
    await seedMerge(repo.id, {
      number: 852,
      changedPaths: ['lib/mcp/tools/searchWorkItems.ts'],
      title: 'search_work_items planner read tool',
    });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toMatchObject([
      { path: 'lib/mcp/tools/searchWorkItems.ts', pullRequest: 'moooon-B-V/motir-core#852' },
    ]);
  });

  it('a genuinely-ready card in the same project does NOT fire', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'Repository-set quick view', GENUINELY_READY_BODY);
    // The SAME merge is in the workspace — the control is that this card's paths
    // are not in it, not that the repository is empty.
    await seedMerge(repo.id, { number: 2059, changedPaths: ['lib/services/workflowsService.ts'] });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toEqual([]);
  });
});

describe('the three clauses of the rule, one negative case each', () => {
  it('a merge BEFORE the card was filed is the substrate it was written against, not a cover', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A card', MOTIR_2757_BODY);
    await seedMerge(repo.id, {
      number: 900,
      changedPaths: ['lib/services/workflowsService.ts'],
      mergedAt: new Date('2026-08-01T00:00:00Z'),
    });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toEqual([]);
  });

  it("the card's OWN merged pull request never covers it", async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A card', MOTIR_2757_BODY);
    await seedMerge(repo.id, {
      number: 2059,
      changedPaths: ['lib/services/workflowsService.ts'],
      workItemId: card.id,
    });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toEqual([]);
  });

  // ⚠️ AMENDED ON THE RECORD, NOT DELETED (MOTIR-3230). This read `an OPEN pull
  // request touching the same path does not cover it` and asserted `[]`, which was
  // a correct statement of MOTIR-2903's merged-only scope. Reporting the open hit
  // — under its OWN severity and disposition — is this card's whole deliverable,
  // so the guarantee is restated rather than removed, and the arm it now describes
  // is covered in full by `the OPEN arm` block at the end of this file.
  it('an OPEN pull request touching the same path now covers it, as the IN-FLIGHT arm', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A card', MOTIR_2757_BODY);
    await seedMerge(repo.id, {
      number: 2060,
      changedPaths: ['lib/services/workflowsService.ts'],
      merged: false,
      state: 'open',
    });

    // Note the row is deliberately INCONSISTENT — open, unmerged, and carrying a
    // merge instant from the helper's default. The arm is keyed on `merged`, so it
    // is read as in flight and the stale instant is dropped rather than reported.
    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toMatchObject([
      { severity: 'likely-in-flight', state: 'open', mergedAt: null },
    ]);
  });

  it('a merge in ANOTHER repo does not cover a card that PINS its own', async () => {
    // `lib/db.ts` exists in three of these repos; a same-named path outside the
    // pin is a coincidence, and one subtask is one repo and one pull request.
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    await connectRepo(fx, 'motir-core');
    const other = await connectRepo(fx, 'motir-ai');
    const card = await makeCard(fx, 'A card', MOTIR_2757_BODY, FILED, 'motir-core');
    await seedMerge(other.id, { number: 77, changedPaths: ['lib/services/workflowsService.ts'] });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toEqual([]);
  });
});

describe('the exemption — criterion 5', () => {
  it('a card that DECLARES itself a boundary contract is never flagged, however many merges share its paths', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const body = [
      'This is a **boundary contract** card: the motir-core producer plus its mirrored',
      'consumer, two coordinated pull requests, one card.',
      '',
      '## Acceptance criteria',
      '',
      '- `lib/services/workflowsService.ts` gains the producer field.',
    ].join('\n');
    const card = await makeCard(fx, 'The contract', body);
    await seedMerge(repo.id, { number: 2059, changedPaths: ['lib/services/workflowsService.ts'] });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toEqual([]);
  });

  it('the SAME card without the declaration fires — the exemption is the assertion, not the shape', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const body = [
      'The motir-core producer plus its mirrored consumer, two coordinated pull requests.',
      '',
      '## Acceptance criteria',
      '',
      '- `lib/services/workflowsService.ts` gains the producer field.',
    ].join('\n');
    const card = await makeCard(fx, 'The contract', body);
    await seedMerge(repo.id, { number: 2059, changedPaths: ['lib/services/workflowsService.ts'] });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toHaveLength(1);
  });
});

describe('the delivery tier — criterion 3', () => {
  it('claim_next_ready hands the finding back in the CLAIM payload, and the claim still stands', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A subsumed card', MOTIR_2757_BODY);
    await seedMerge(repo.id, { number: 2059, changedPaths: ['lib/services/workflowsService.ts'] });
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
    await adminDb.workItem.updateMany({ where: { id: card.id }, data: { sprintId: sprint.id } });
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    const result = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const payload = result.structuredContent as {
      item: { key: string } | null;
      advisories: WorkItemProseAdvisoryDto[];
    };

    // The claim SUCCEEDED — the advisory is a notice, never a gate.
    expect(payload.item?.key).toBe(card.identifier);
    expect(subsumptions(payload.advisories)).toMatchObject([
      { path: 'lib/services/workflowsService.ts', pullRequest: 'moooon-B-V/motir-core#2059' },
    ]);
    // …and it is in the TEXT the operator reads, not only the machine payload.
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('moooon-B-V/motir-core#2059');
    expect(text).toContain('READ THAT DIFF BEFORE YOU BRANCH');
    const item = await workItemsService.getWorkItem(card.id, fx.ctx);
    expect(item.status).toBe('in_progress');
  });
});

describe('the batch path — validate_work_item scans a whole subtree in ONE query', () => {
  /** The batch entry point, with the exempt set every real caller computes. */
  async function scanBatch(
    fx: WorkItemFixture,
    subjects: Array<{
      item: string;
      descriptionMd: string | null;
      targetRepos?: readonly string[];
      id?: string | null;
      createdAt?: Date | null;
    }>,
  ) {
    return buildProseVsGraphAdvisories(
      subjects.map((s) => ({
        item: s.item,
        descriptionMd: s.descriptionMd,
        exemptIds: new Set<string>(),
        type: null,
        executor: null,
        // `?? ['motir-core']` would be wrong: an UNPINNED subject passes `[]`
        // deliberately, and a nullish default would silently give it a repo.
        targetRepos: s.targetRepos ?? ['motir-core'],
        id: s.id ?? null,
        createdAt: s.createdAt ?? null,
        // Right-sized and childless (MOTIR-3110) — this helper's subject is
        // about the SUBSUMPTION check, so it supplies the values that emit no
        // sizing advisory rather than leaving the family to fire into these
        // assertions.
        storyPoints: 3,
        estimateMinutes: 45,
        hasChildren: false,
      })),
      fx.ctx,
    );
  }

  it('a subject with NO stored row is skipped, and does not stop its siblings being checked', async () => {
    // The projected-plan path: a not-yet-materialized `add` has no id and no
    // filing instant, so it cannot have been subsumed. The point of the case is
    // that the REAL sibling in the same batch is still checked.
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const real = await makeCard(fx, 'A real card', MOTIR_2757_BODY);
    await seedMerge(repo.id, { number: 2059, changedPaths: ['lib/services/workflowsService.ts'] });

    const advisories = await scanBatch(fx, [
      { item: 'planItem:new', descriptionMd: MOTIR_2757_BODY },
      { item: real.identifier, descriptionMd: MOTIR_2757_BODY, id: real.id, createdAt: FILED },
    ]);

    expect(subsumptions(advisories).map((a) => a.item)).toEqual([real.identifier]);
  });

  it('a batch of only projected subjects issues no query at all', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    await seedMerge(repo.id, { number: 2059, changedPaths: ['lib/services/workflowsService.ts'] });

    expect(
      subsumptions(await scanBatch(fx, [{ item: 'planItem:new', descriptionMd: MOTIR_2757_BODY }])),
    ).toEqual([]);
  });

  it('a merged row with NO merge instant is dropped — the ordering clause cannot be approximated', async () => {
    // Every row written before MOTIR-2922 has `mergedAt: null`. A row that
    // cannot say WHEN it merged is dropped rather than assumed recent, which is
    // what keeps "merged after this card was filed" a fact rather than a guess.
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A card', MOTIR_2757_BODY);
    await adminDb.githubPullRequest.create({
      data: {
        repoId: repo.id,
        number: 1000,
        state: 'closed',
        merged: true,
        headRef: 'subtask/legacy',
        title: 'A pre-MOTIR-2922 row',
        mergedAt: null,
        changedPaths: ['lib/services/workflowsService.ts'],
      },
    });

    expect(
      subsumptions(
        await scanBatch(fx, [
          { item: card.identifier, descriptionMd: MOTIR_2757_BODY, id: card.id, createdAt: FILED },
        ]),
      ),
    ).toEqual([]);
  });

  it('an EXEMPT card is not flagged even when a sibling in the batch put its paths in the query', async () => {
    // The exemption is applied twice — once when building the query's path union
    // and once when reading the result — because a sibling can pull the same
    // paths into the batch. Only the second check saves the exempt card there.
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const plain = await makeCard(fx, 'A plain card', MOTIR_2757_BODY);
    const exempt = await makeCard(
      fx,
      'The contract',
      `A boundary contract card.\n${MOTIR_2757_BODY}`,
    );
    await seedMerge(repo.id, { number: 2059, changedPaths: ['lib/services/workflowsService.ts'] });

    const advisories = await scanBatch(fx, [
      { item: plain.identifier, descriptionMd: MOTIR_2757_BODY, id: plain.id, createdAt: FILED },
      {
        item: exempt.identifier,
        descriptionMd: `A boundary contract card.\n${MOTIR_2757_BODY}`,
        id: exempt.id,
        createdAt: FILED,
      },
    ]);

    expect(subsumptions(advisories).map((a) => a.item)).toEqual([plain.identifier]);
  });

  it('an UNPINNED card takes every repo in the workspace — the honest reading of an unpinned card', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    await connectRepo(fx, 'motir-core');
    const other = await connectRepo(fx, 'motir-ai');
    const card = await makeCard(fx, 'A card', MOTIR_2757_BODY, FILED, null);
    await seedMerge(other.id, {
      number: 77,
      changedPaths: ['lib/services/workflowsService.ts'],
      title: null,
    });

    expect(
      subsumptions(
        await scanBatch(fx, [
          {
            item: card.identifier,
            descriptionMd: MOTIR_2757_BODY,
            targetRepos: [],
            id: card.id,
            createdAt: FILED,
          },
        ]),
      ),
    ).toMatchObject([{ pullRequest: 'moooon-B-V/motir-ai#77', pullRequestTitle: null }]);
  });

  it('a card carrying BOTH a shape finding and a subsumption sorts SHAPE first', async () => {
    // The deterministic wire order, pinned: a mis-shaped criterion is a cut to
    // make, the subsumption is a diff to read, and the references below both are
    // things to go and verify.
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const body = [
      'Bind the read surface.',
      '',
      '## Acceptance criteria',
      '',
      '- `lib/services/workflowsService.ts` is bound once this lands.',
    ].join('\n');
    const card = await makeCard(fx, 'A card', body);
    await seedMerge(repo.id, { number: 2059, changedPaths: ['lib/services/workflowsService.ts'] });

    const advisories = await scanBatch(fx, [
      { item: card.identifier, descriptionMd: body, id: card.id, createdAt: FILED },
    ]);

    expect(advisories.map((a) => a.kind)).toEqual(['shape', 'subsumption']);
  });

  it('accepts the filing instant as a Date as well as the ISO string a DTO carries', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A card', MOTIR_2757_BODY);
    await seedMerge(repo.id, { number: 2059, changedPaths: ['lib/services/workflowsService.ts'] });

    const asDate = await buildDispatchProseAdvisories({ ...card, createdAt: FILED }, fx.ctx);
    expect(subsumptions(asDate)).toHaveLength(1);
  });
});

describe('the other three surfaces render it — never as a bare reference', () => {
  /** A subsumed card, its merge seeded, in a fixture ready to dispatch. */
  async function subsumedCard(fx: WorkItemFixture, title: string | null = 'Bind the READ surface') {
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A subsumed card', MOTIR_2757_BODY);
    await seedMerge(repo.id, {
      number: 2059,
      changedPaths: ['lib/services/workflowsService.ts'],
      title,
    });
    return card;
  }

  it('the DISPATCH PROMPT carries it, so every harness inherits it', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const card = await subsumedCard(fx);

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );

    expect(dto.prompt).toContain('THIS CARD MAY ALREADY BE BUILT');
    expect(dto.prompt).toContain('lib/services/workflowsService.ts');
    expect(dto.prompt).toContain('moooon-B-V/motir-core#2059');
    expect(dto.prompt).toContain('Bind the READ surface');
    expect(dto.prompt).not.toContain('undefined');
    // ⚠️ And it dispatches all the same — the advisory is a notice, not a gate.
    expect(dto.workflowMode).toBe('per_item_pr');
  });

  it('a merge with NO title renders without a dangling dash', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const card = await subsumedCard(fx, null);

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );

    expect(dto.prompt).toContain('moooon-B-V/motir-core#2059');
    expect(dto.prompt).not.toContain('— ""');
    expect(dto.prompt).not.toContain('undefined');
  });

  it('the dispatch_prompt TOOL summary repeats it at the top, for a caller who skims', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const card = await subsumedCard(fx);

    const result = await runDispatchPrompt({ key: card.identifier }, fx.ctx);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;

    expect(text).toContain('moooon-B-V/motir-core#2059');
    expect(text).toContain('may already be');
    expect(text).not.toContain('undefined');
  });

  it('validate_work_item reports it — the surface whose `advisories: []` is the observation to invert', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const parent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'The parent' },
      fx.ctx,
    );
    const repo = await connectRepo(fx);
    const card = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'bug',
        title: 'A subsumed child',
        descriptionMd: MOTIR_2757_BODY,
        parentId: parent.id,
        targetRepo: 'motir-core',
      },
      fx.ctx,
    );
    await adminDb.workItem.update({ where: { id: card.id }, data: { createdAt: FILED } });
    await seedMerge(repo.id, { number: 2059, changedPaths: ['lib/services/workflowsService.ts'] });

    const verdict = await workItemsService.validateWorkItem(
      fx.projectId,
      parent.identifier,
      fx.ctx,
    );

    expect(subsumptions(verdict.advisories)).toMatchObject([
      { item: card.identifier, path: 'lib/services/workflowsService.ts' },
    ]);
    // ⚠️ `valid` and `blockers` are byte-identical either way.
    expect(verdict.valid).toBe(true);
    expect(verdict.blockers).toEqual([]);

    const result = await runValidateWorkItem({ key: parent.identifier }, fx.ctx);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('moooon-B-V/motir-core#2059');
    expect(text).toContain('may already be in the repository');
    expect(text).toContain('still VALID');
    expect(text).not.toContain('undefined');
  });
});

// ── THE OPEN ARM (MOTIR-3230) ────────────────────────────────────────────────
//
// The defect this pins is the SAME shape one window earlier. MOTIR-3218 was filed
// at 10:33 against a file that motir-core#2200 had been OPEN against since 09:45 —
// 48 minutes — naming the same cause and shipping the same remedy. It merged at
// 11:09, and the advisory that would have stopped the duplicate only started
// returning anything at that moment, to the session that had already claimed the
// card. A pull request is merged for the rest of time and open for about an hour,
// so a merged-only check speaks for the whole period in which the answer no longer
// matters and is silent in the one hour it would have changed something.
describe('the OPEN arm — a pull request touching the path RIGHT NOW', () => {
  it('FIRES on an open pull request, with the in-flight severity and a null instant', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A card naming the swept path', MOTIR_2757_BODY);
    await seedMerge(repo.id, {
      number: 2200,
      state: 'open',
      merged: false,
      mergedAt: null,
      changedPaths: ['lib/services/workflowsService.ts'],
      title: 'Inject the resolver into every main() call',
    });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toEqual([
      {
        kind: 'subsumption',
        item: card.identifier,
        severity: 'likely-in-flight',
        path: 'lib/services/workflowsService.ts',
        pullRequest: 'moooon-B-V/motir-core#2200',
        pullRequestTitle: 'Inject the resolver into every main() call',
        state: 'open',
        mergedAt: null,
      },
    ]);
    // The standing invariant: this is a heuristic and it never gates.
    const readiness = await workItemsService.getReadiness(card.id, fx.ctx);
    expect(readiness.ready).toBe(true);
  });

  it('FIRES on a pull request opened BEFORE the card — the interval clause is the merged arm alone', async () => {
    // The merged arm drops anything that landed before the card was filed, because
    // that is the substrate the card was written against. Applying the same clause
    // to an open pull request would re-create the exact blindness this closes: a
    // colleague who started yesterday and has not finished is the most relevant
    // hit there is, not the least.
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A card filed after they started', MOTIR_2757_BODY);
    await seedMerge(repo.id, {
      number: 2201,
      state: 'open',
      merged: false,
      mergedAt: null,
      changedPaths: ['lib/services/workflowsService.ts'],
    });
    // Backdate the pull request's own row to well before the card's `createdAt`.
    await adminDb.githubPullRequest.updateMany({
      where: { repoId: repo.id, number: 2201 },
      data: { createdAt: new Date('2026-08-01T00:00:00Z') },
    });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toMatchObject([
      { severity: 'likely-in-flight', state: 'open' },
    ]);
  });

  it('prefers the OPEN hit when both arms cover one path — its remedy dominates', async () => {
    // *Stop and coordinate* is right whether or not something also merged; *read
    // the merged diff* is wrong if somebody is editing the file right now. The
    // accessor cannot express this (an open row has no instant to sort on), so the
    // index sorts the two arms itself and this pins that it did.
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A card on a busy path', MOTIR_2757_BODY);
    await seedMerge(repo.id, {
      number: 2059,
      changedPaths: ['lib/services/workflowsService.ts'],
    });
    await seedMerge(repo.id, {
      number: 2200,
      state: 'open',
      merged: false,
      mergedAt: null,
      changedPaths: ['lib/services/workflowsService.ts'],
    });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toMatchObject([
      { state: 'open', pullRequest: 'moooon-B-V/motir-core#2200', mergedAt: null },
    ]);
  });

  it('the MERGED arm is unchanged — same finding, now carrying `state`', async () => {
    // Asserted alongside the new arm rather than trusted: the widening is only
    // safe if the behaviour it widens is byte-identical apart from the new field.
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A card the sweep covered', MOTIR_2757_BODY);
    await seedMerge(repo.id, {
      number: 2059,
      changedPaths: ['lib/services/workflowsService.ts'],
    });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toMatchObject([
      {
        severity: 'likely-already-shipped',
        state: 'merged',
        mergedAt: SWEEP_MERGED.toISOString(),
      },
    ]);
  });

  it('a CLOSED-UNMERGED pull request fires NEITHER arm', async () => {
    // Abandoned work is not shipped and is not in flight, so both remedies would
    // be wrong. The open arm is keyed on `state` AND `merged` for exactly this row.
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A card nobody is working on', MOTIR_2757_BODY);
    await seedMerge(repo.id, {
      number: 2202,
      state: 'closed',
      merged: false,
      mergedAt: null,
      changedPaths: ['lib/services/workflowsService.ts'],
    });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toEqual([]);
  });

  it("the card's OWN open pull request never covers it", async () => {
    // A card whose branch is open is doing its work, not having it done for it —
    // the exclusion that already held for the merged arm, asserted for the new one
    // because it is the arm on which a card's own in-flight PR is the common case.
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A card being built right now', MOTIR_2757_BODY);
    await seedMerge(repo.id, {
      number: 2203,
      state: 'open',
      merged: false,
      mergedAt: null,
      changedPaths: ['lib/services/workflowsService.ts'],
      workItemId: card.id,
    });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toEqual([]);
  });

  it('a pre-capture MERGED row is never mis-read as in flight', async () => {
    // Keyed on `merged` rather than on `mergedAt` being null, because the two agree
    // for every row the webhook writes and disagree for exactly this one: a
    // pre-path-capture merge, which is closed, merged, and carries no instant.
    // Reading the open arm off the instant would present it as work in flight.
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const card = await makeCard(fx, 'A card over a legacy row', MOTIR_2757_BODY);
    await seedMerge(repo.id, {
      number: 1000,
      state: 'closed',
      merged: true,
      mergedAt: null,
      changedPaths: ['lib/services/workflowsService.ts'],
    });

    expect(subsumptions(await buildDispatchProseAdvisories(card, fx.ctx))).toEqual([]);
  });

  it('the MCP text renders the two arms as SEPARATE advisories', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'MOTIR' });
    const repo = await connectRepo(fx);
    const parent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'A story' },
      fx.ctx,
    );
    const card = await makeCard(fx, 'A card on a busy path', MOTIR_2757_BODY);
    await workItemsService.updateWorkItem(card.id, { parentId: parent.id }, fx.ctx);
    await seedMerge(repo.id, {
      number: 2200,
      state: 'open',
      merged: false,
      mergedAt: null,
      changedPaths: ['lib/services/workflowsService.ts'],
    });

    const result = await runValidateWorkItem({ key: parent.identifier }, fx.ctx);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('OPEN pull request is changing right');
    expect(text).toContain('(OPEN, not merged)');
    // The merged wording must NOT be used for an unmerged pull request — a reader
    // told "may already be in the repository" here takes the opposite action.
    expect(text).not.toContain('may already be in the repository');
    expect(text).not.toContain('merged null');
    expect(text).not.toContain('undefined');
  });
});
