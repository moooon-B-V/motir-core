import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dispatchPromptService } from '@/lib/services/dispatchPromptService';
import { buildDispatchProseAdvisories } from '@/lib/services/proseGraphAdvisoryService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { runDispatchPrompt } from '@/lib/mcp/tools/dispatchPrompt';
import { runClaimNextReady } from '@/lib/mcp/tools/claimNextReady';
import type { WorkItemProseAdvisoryDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// DISPATCH READS THE ADVISORIES (MOTIR-2079) — over REAL Postgres.
//
// MOTIR-1969 shipped the prose-vs-graph detector and it works. On the SEVENTH
// instance of the family it returned, unprompted and correctly,
// `{ referenced: MOTIR-2073, referencedStatus: in_review, severity:
// likely-missing-edge }` — and the card dispatched anyway, because every
// dispatch path computes readiness from EDGES alone and nothing called the
// detector. The verdict was addressed to nobody (`notes.html` #210). This suite
// pins the three consumers that now read it:
//
//   1. `dispatch_prompt` renders it into the prompt (every harness inherits it,
//      because no harness assembles its own prompt text);
//   2. the CLI warns on it (`packages/cli/test/dispatchCommand.test.ts` — the
//      client half, where the exit-code invariant is asserted);
//   3. `claim_next_ready` returns it (the planner-agent seam).
//
// ⚠️ AND the invariant that makes all three safe: READINESS IS BYTE-IDENTICAL.
// `likely-missing-edge` is a severity, never a gate. Every `readiness` assertion
// below exists to fail loudly if someone "improves" this into a blocker — which
// would falsely stop the three legitimate shapes MOTIR-1969 enumerates, and
// teach authors to write vaguer acceptance criteria to dodge it.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** A `[label](motir:<id>)` reference token — the shipped chip form every card in
 *  this family carries, which is why extraction is a regex and not a language
 *  problem. */
const ref = (label: string, id: string) => `[${label}](motir:${id})`;

/**
 * A card body shaped EXACTLY like the MOTIR-2075 miss this work exists for: the
 * reference sits inside the card's own ACCEPTANCE CRITERIA (so it is being
 * CONSUMED, not merely mentioned), the referenced card is `in_review` (merged
 * nowhere — its substrate lives only on an open PR), and the only edge between
 * them is a `relates_to`, which readiness does not read.
 */
function cardNamingInAcceptanceCriteria(label: string, id: string): string {
  return [
    'Separate the status hues so two adjacent chips are distinguishable.',
    '',
    '## Acceptance criteria',
    '',
    `- ${ref(label, id)} added statusHueSeparation.test.ts; extend it with the new pairs.`,
    '- Every palette passes the ΔE2000 floor.',
  ].join('\n');
}

/** The same reference, in PROSE only — outside the acceptance-criteria section. */
function cardNamingInProse(label: string, id: string): string {
  return [
    `Filed after ${ref(label, id)}, which is the incident record for this defect.`,
    '',
    '## Acceptance criteria',
    '',
    '- The thing works.',
  ].join('\n');
}

async function makeItem(
  fx: WorkItemFixture,
  title: string,
  descriptionMd: string | null = null,
  parentId?: string,
) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title,
      descriptionMd,
      ...(parentId ? { parentId } : {}),
    },
    fx.ctx,
  );
}

/** Move an item to `in_review` along the legal path (there is no direct edge). */
async function toInReview(id: string, fx: WorkItemFixture): Promise<void> {
  await workItemsService.updateStatus(id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(id, 'in_review', fx.ctx);
}

const keys = (advisories: WorkItemProseAdvisoryDto[]) => advisories.map((a) => a.referenced);

describe('buildDispatchProseAdvisories — the single-card resolver', () => {
  it('reports a card whose ACCEPTANCE CRITERIA name a not-done item it has no edge to', async () => {
    // The MOTIR-2075 fixture, reproduced: an AC naming an `in_review` card, with
    // only a `relates_to` between them.
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Graphite in_review ramp');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Palette status hues',
      cardNamingInAcceptanceCriteria('MOTIR-2073', substrate.id),
    );
    // No explicit link is written here, and that is the point: `autoRelateWorkItemMentions`
    // ALREADY wrote a `relates_to` on create, from the same reference tokens this
    // advisory scans. That auto-written edge is exactly what made MOTIR-2075 look
    // wired while the ready set saw nothing — the card carries a real link, just
    // not the kind that gates.
    const links = await db.workItemLink.findMany({ where: { fromId: card.id } });
    expect(links.map((l) => l.kind)).toEqual(['relates_to']);

    const advisories = await buildDispatchProseAdvisories(card, fx.ctx);
    expect(advisories).toEqual([
      {
        item: card.identifier,
        referenced: substrate.identifier,
        referencedStatus: 'in_review',
        severity: 'likely-missing-edge',
      },
    ]);
  });

  it('⚠️ READINESS IS UNTOUCHED — the card is ready, with no open blockers', async () => {
    // The load-bearing assertion of this whole card. `relates_to` is not a gate,
    // and the advisory does not make it one: this item dispatches.
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
    );

    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toHaveLength(1);
    // Read through `getIssueDetail` — the SAME `readiness` shape `motir run`
    // gates on before it dispatches (`readiness.ready` / `openBlockers`).
    const { readiness } = await workItemsService.getIssueDetail(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.openBlockers).toEqual([]);
  });

  it('says NOTHING once the edge is real — a blocked_by reference is exempt', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
    );
    await workItemsService.linkWorkItems(
      { fromId: card.id, toId: substrate.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    // The graph now says what the prose says — which is the fix, so the advisory
    // has nothing left to report. (Readiness now legitimately gates it; that is
    // the EDGE doing its job, not the advisory.)
    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([]);
  });

  it('says nothing about a DONE reference — the prose is history, not a dependency', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Landed');
    await toInReview(substrate.id, fx);
    await workItemsService.updateStatus(substrate.id, 'done', fx.ctx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('LANDED', substrate.id),
    );
    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([]);
  });

  it('says nothing about its own ANCESTOR — naming your parent is not a dependency', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Parent story' },
      fx.ctx,
    );
    const card = await makeItem(
      fx,
      'Child',
      cardNamingInAcceptanceCriteria('PARENT', parent.id),
      parent.id,
    );
    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([]);
  });

  it('carries ONLY the likely-missing-edge tier — a prose mention is not a dispatch warning', async () => {
    // The `advisory` tier fires on any not-done item named ANYWHERE in a body —
    // an incident record, a superseded-by pointer, an out-of-scope note. Useful
    // when a human browses the card; pure noise in front of an agent about to
    // branch. `validate_work_item` still reports both tiers; nothing is lost.
    const fx = await makeWorkItemFixture();
    const record = await makeItem(fx, 'Incident record');
    const card = await makeItem(fx, 'Consumer', cardNamingInProse('RECORD', record.id));

    expect(await buildDispatchProseAdvisories(card, fx.ctx)).toEqual([]);
    // …and the full-tier surface still sees it, so this is a scope, not a loss.
    const validity = await workItemsService.validateWorkItem(fx.projectId, card.identifier, fx.ctx);
    expect(keys(validity.advisories)).toEqual([record.identifier]);
    expect(validity.advisories[0]?.severity).toBe('advisory');
  });

  it('reports EVERY unedged reference an AC names, deterministically ordered', async () => {
    const fx = await makeWorkItemFixture();
    const a = await makeItem(fx, 'Alpha');
    const b = await makeItem(fx, 'Beta');
    const card = await makeItem(
      fx,
      'Consumer',
      [
        'Body.',
        '',
        '## Acceptance criteria',
        '',
        `- Extends ${ref('A', a.id)} and ${ref('B', b.id)}.`,
      ].join('\n'),
    );
    const advisories = await buildDispatchProseAdvisories(card, fx.ctx);
    expect(keys(advisories)).toEqual([a.identifier, b.identifier].sort());
  });

  it('a card naming nothing costs no advisory and no crash on a null body', async () => {
    const fx = await makeWorkItemFixture();
    const bare = await makeItem(fx, 'No body at all', null);
    const plain = await makeItem(fx, 'Prose only', 'Just words, no references.');
    expect(await buildDispatchProseAdvisories(bare, fx.ctx)).toEqual([]);
    expect(await buildDispatchProseAdvisories(plain, fx.ctx)).toEqual([]);
  });
});

describe('dispatch_prompt — the advisories reach the AGENT', () => {
  it('renders the reference, its status, and the verify-before-you-branch instruction', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
    );

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(keys(dto.advisories)).toEqual([substrate.identifier]);
    expect(dto.prompt).toContain(`${substrate.identifier} (in_review)`);
    expect(dto.prompt).toContain('origin/main');
    expect(dto.prompt).toContain('REFERENCED BUT NOT A DEPENDENCY');
  });

  it('⚠️ dispatches all the same — readiness, workflow mode and status are untouched', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
    );

    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(dto.advisories).toHaveLength(1);
    expect(dto.workflowMode).toBe('per_item_pr');
    // Still a pure READ: an advisory does not claim, block, or flip anything.
    const after = await workItemsService.getWorkItemByIdentifier(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(after.status).toBe('todo');
    const { readiness } = await workItemsService.getIssueDetail(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.openBlockers).toEqual([]);
  });

  it('a card with none renders no section at all — and the DTO still carries []', async () => {
    const fx = await makeWorkItemFixture();
    const card = await makeItem(
      fx,
      'Clean card',
      'Nothing referenced.\n\n## Acceptance criteria\n\n- Works.',
    );
    const dto = await dispatchPromptService.getDispatchPrompt(
      fx.projectId,
      card.identifier,
      fx.ctx,
    );
    expect(dto.advisories).toEqual([]);
    expect(dto.prompt).not.toContain('REFERENCED BUT NOT A DEPENDENCY');
  });

  it('the TOOL names it in the human summary as well as in the prompt', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
    );

    const res = await runDispatchPrompt({ key: card.identifier }, fx.ctx);
    expect(res.isError).toBeFalsy();
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Advisory (NOT a blocker');
    expect(text).toContain(`${substrate.identifier} (in_review)`);
  });
});

describe('claim_next_ready — the advisories reach the PLANNER AGENT', () => {
  /** Create a sprint holding the given items and START it. */
  async function activeSprintWith(fx: WorkItemFixture, itemIds: string[]): Promise<void> {
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
    await db.workItem.updateMany({
      where: { id: { in: itemIds } },
      data: { sprintId: sprint.id },
    });
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);
  }

  const structOf = (r: { structuredContent?: unknown }) =>
    r.structuredContent as { item: { key: string } | null; advisories: WorkItemProseAdvisoryDto[] };

  it('returns the claimed card’s advisories, and still claims it', async () => {
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const card = await makeItem(
      fx,
      'Consumer',
      cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
    );
    await activeSprintWith(fx, [card.id]);

    const res = await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx);
    const struct = structOf(res);
    expect(struct.item?.key).toBe(card.identifier);
    expect(keys(struct.advisories)).toEqual([substrate.identifier]);
    // The claim IS the status flip, advisory or not.
    const row = await db.workItem.findUniqueOrThrow({ where: { id: card.id } });
    expect(row.status).toBe('in_progress');
    const text = (res.content as { text: string }[])[0]!.text;
    expect(text).toContain('Advisory (NOT a blocker');
  });

  it('⚠️ SELECTION is unchanged — the advisory-carrying card is picked in the same order', async () => {
    // Two ready cards, one carrying an advisory, the other clean. The pick must
    // follow rank alone; if an advisory ever demoted or skipped a card, that
    // would be a gate wearing a warning's clothes.
    const fx = await makeWorkItemFixture();
    const substrate = await makeItem(fx, 'Substrate');
    await toInReview(substrate.id, fx);
    const flagged = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Flagged but highest',
        priority: 'highest',
        descriptionMd: cardNamingInAcceptanceCriteria('SUBSTRATE', substrate.id),
      },
      fx.ctx,
    );
    const clean = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Clean but low', priority: 'low' },
      fx.ctx,
    );
    await activeSprintWith(fx, [flagged.id, clean.id]);

    const first = structOf(await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx));
    expect(first.item?.key).toBe(flagged.identifier);
    expect(first.advisories).toHaveLength(1);

    const second = structOf(await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx));
    expect(second.item?.key).toBe(clean.identifier);
    expect(second.advisories).toEqual([]);
  });

  it('carries an EMPTY array on the nothing-to-claim arm too — one shape for the caller', async () => {
    const fx = await makeWorkItemFixture();
    await activeSprintWith(fx, []);
    const struct = structOf(await runClaimNextReady({ projectKey: fx.projectIdentifier }, fx.ctx));
    expect(struct.item).toBeNull();
    expect(struct.advisories).toEqual([]);
  });
});
