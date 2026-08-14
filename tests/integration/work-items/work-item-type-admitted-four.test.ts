import { readFileSync } from 'node:fs';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkItemType } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { WORK_ITEM_TYPES, defaultExecutorForType } from '@/lib/issues/executorDefaults';
import { WORK_ITEM_TYPE_META, workItemTypeChipBackground } from '@/lib/issues/workItemTypeMeta';
import { FILTER_FIELDS } from '@/lib/filters/registry';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { PLAN_TYPE_TO_WORK_ITEM_TYPE } from '@/scripts/plan-seed/mapItem';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';

// MOTIR-2632 — the four members ADR Amendment 1 (MOTIR-2629) admitted, walked
// across EVERY contract that publishes the type set.
//
// ── Why one test that walks all of them, rather than four in four files ──────
// The defect MOTIR-2622 exists to fix is not "a type is missing". It is "a type
// reaches SOME of the places that publish the set and not the others" — the
// planner teaches fourteen names while the enum offers ten, so a card that
// should be `translate` silently becomes something else and the authoring bar
// written for it never applies. Adding four members re-creates that hazard one
// layer down: a member that reaches the database but not the MCP tool schema is
// a value the product can store and an agent cannot set, which is the same bug
// wearing a smaller hat. A per-file test proves each contract is internally
// consistent; only a walk proves they agree WITH EACH OTHER.
//
// So the parametrised block below is the point: for each admitted member, every
// contract in the chain is asserted in one place, and a future member that is
// added to nine of them fails here rather than at a user.

/** The four Amendment 1 admitted — transcribed from the ADR, not from the code. */
const ADMITTED = ['copy', 'translate', 'verification', 'legal'] as const;

/**
 * The two names Amendment 1 declared ALIASES rather than members. They are
 * asserted ABSENT: admitting a duplicate is the failure mode the amendment
 * weighed as worse than the gap, because two menu entries nobody can choose
 * between get filed at random from then on.
 */
const ALIASES = ['doc', 'spike'] as const;

/** Amendment 1 §3a. `legal` is the only admitted member that is always-human. */
const ADMITTED_EXECUTORS: Record<(typeof ADMITTED)[number], 'coding_agent' | 'human'> = {
  copy: 'coding_agent',
  translate: 'coding_agent',
  verification: 'coding_agent',
  legal: 'human',
};

describe('the admitted four reach every contract that publishes the type set', () => {
  describe('the four internal copies of the set agree', () => {
    it('the Prisma enum and WORK_ITEM_TYPES hold the same members, in the same order', () => {
      // Order is load-bearing, not cosmetic: it is what the picker, the legend
      // and the filter menu iterate, and (since the migration anchors each
      // insertion with BEFORE/AFTER) it is also the database's own sort order.
      expect(Object.values(WorkItemType)).toEqual([...WORK_ITEM_TYPES]);
    });

    it('WorkItemTypeDto covers exactly WORK_ITEM_TYPES', () => {
      // `WORK_ITEM_TYPES` is `satisfies readonly WorkItemTypeDto[]`, so a member
      // NOT in the union is a compile error. The reverse hole — a union member
      // missing from the list — is what this catches, via the total META record.
      const fromMeta = Object.keys(WORK_ITEM_TYPE_META).sort();
      expect(fromMeta).toEqual([...WORK_ITEM_TYPES].sort());
    });

    it('holds fourteen members with no duplicates', () => {
      expect(WORK_ITEM_TYPES).toHaveLength(14);
      expect(new Set(WORK_ITEM_TYPES).size).toBe(14);
    });

    it.each(ALIASES)('does NOT admit `%s` — Amendment 1 declared it an alias', (alias) => {
      expect(WORK_ITEM_TYPES as readonly string[]).not.toContain(alias);
      expect(Object.values(WorkItemType) as string[]).not.toContain(alias);
    });
  });

  describe('presentation metadata is total, and the shared hues are deliberate', () => {
    it.each(ADMITTED)('%s has a glyph and its own --el-type-* token', (type) => {
      const meta = WORK_ITEM_TYPE_META[type];
      expect(meta.icon).toBeTruthy();
      // Its OWN token, even though it points at a neighbour's Tier-0 hue — so a
      // future palette can split them without touching a component.
      expect(meta.hueVar).toBe(`--el-type-${type}`);
      // A COMPLETE literal, never interpolated: a constructed class name is
      // invisible to the Tailwind JIT scanner and would be stripped.
      expect(meta.hueClass).toBe(`text-(--el-type-${type})`);
    });

    it('every member has a DISTINCT glyph — hue is shared, the glyph is not', () => {
      // This is what makes the shared-hue decision safe (design-notes.md "Q2"):
      // the palette has no eighth saturated hue, so `copy`/`translate` sit with
      // `content` and `verification` with `review`. The glyph is then the only
      // per-member visual, and two members sharing one would be the real defect.
      const icons = WORK_ITEM_TYPES.map((t) => WORK_ITEM_TYPE_META[t].icon);
      expect(new Set(icons).size).toBe(WORK_ITEM_TYPES.length);
    });

    it('the chip tint is the near-neutral 18% mix for `legal`, 14% for the rest', () => {
      // `legal` shares `decision`'s charcoal, so it needs the same higher mix
      // the other near-neutral members get or its tint does not read at all.
      expect(workItemTypeChipBackground('legal')).toContain('18%');
      expect(workItemTypeChipBackground('legal')).toContain('var(--el-type-legal)');
      for (const type of ['copy', 'translate', 'verification'] as const) {
        expect(workItemTypeChipBackground(type)).toContain('14%');
      }
      // Unchanged for the original near-neutrals and the original saturated set.
      expect(workItemTypeChipBackground('decision')).toContain('18%');
      expect(workItemTypeChipBackground('code')).toContain('14%');
    });

    it('every tint mixes only --el-* tokens — never a raw hue', () => {
      for (const type of WORK_ITEM_TYPES) {
        const bg = workItemTypeChipBackground(type);
        expect(bg).toMatch(
          /^color-mix\(in srgb, var\(--el-type-[a-z]+\) \d+%, var\(--el-page-bg\)\)$/,
        );
      }
    });
  });

  describe('the published contracts offer the same set', () => {
    it('the v1 API and ready schemas enumerate all fourteen', () => {
      // These are hand-written `as const` arrays guarded by an `AssertTotal`
      // type, so a missing member is a compile error — but a member added to the
      // array and NOT to the enum would compile, so read them back as data.
      for (const file of ['lib/api/v1/workItems/schema.ts', 'lib/api/v1/ready/schema.ts']) {
        const src = readFileSync(resolve(process.cwd(), file), 'utf8');
        for (const type of WORK_ITEM_TYPES) {
          expect(src, `${file} is missing '${type}'`).toContain(`'${type}',`);
        }
      }
    });

    it("the CLI's generated schema.d.ts publishes all fourteen", () => {
      // Generated from the OpenAPI document by `pnpm generate:cli-api`. It is
      // committed, so it can be stale — and a stale copy is precisely how a
      // command-line user ends up unable to set a type the API accepts.
      const src = readFileSync(resolve(process.cwd(), 'packages/cli/src/api/schema.d.ts'), 'utf8');
      for (const type of WORK_ITEM_TYPES) {
        expect(src, `the CLI schema is missing '${type}' — run pnpm generate:cli-api`).toContain(
          `"${type}"`,
        );
      }
    });

    it('the `type` filter facet whitelists all fourteen', () => {
      // The facet reads WORK_ITEM_TYPES directly rather than re-stating it, so
      // this should follow with no edit — the card asked for that to be VERIFIED
      // rather than assumed, and this is the verification.
      const facet = FILTER_FIELDS.find((f) => f.id === 'type');
      expect(facet).toBeDefined();
      expect(facet?.valueWhitelist).toEqual([...WORK_ITEM_TYPES]);
    });

    it('the seed loader accepts every member, and still collapses the two aliases', () => {
      for (const type of WORK_ITEM_TYPES) {
        expect(PLAN_TYPE_TO_WORK_ITEM_TYPE[type], `plan type '${type}'`).toBe(type);
      }
      expect(PLAN_TYPE_TO_WORK_ITEM_TYPE['doc']).toBe('content');
      expect(PLAN_TYPE_TO_WORK_ITEM_TYPE['spike']).toBe('research');
    });
  });

  describe('each admitted member round-trips through the write path', () => {
    let fx: WorkItemFixture;

    beforeEach(async () => {
      await truncateAuthTables();
      fx = await makeWorkItemFixture();
    });

    afterAll(async () => {
      await db.$disconnect();
      await adminDb.$disconnect();
    });

    it.each(ADMITTED)('%s persists and reads back, seeding its amendment default', async (type) => {
      const created = await workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: `A ${type} card`,
          type,
        },
        fx.ctx,
      );

      // Stored as the member itself — not folded into a neighbour, which is the
      // failure this whole story is about.
      expect(created.type).toBe(type);
      // The executor is SEEDED from the amendment's map, not left null.
      expect(created.executor).toBe(ADMITTED_EXECUTORS[type]);
      expect(created.executor).toBe(defaultExecutorForType(type));

      // Read back through the REPOSITORY, so the stored column is what is
      // asserted rather than the value we just handed in.
      const row = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        workItemRepository.findById(created.id, tx),
      );
      expect(row?.type).toBe(type);
      expect(row?.executor).toBe(ADMITTED_EXECUTORS[type]);
    });

    it('the filter facet RETURNS rows carrying an admitted type', async () => {
      // The whitelist assertion above proves the value is accepted by the
      // grammar; this proves a condition over it actually matches, which is the
      // end-to-end half of the card's AC 4.
      const target = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'zh twins', type: 'translate' },
        fx.ctx,
      );
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'a code card', type: 'code' },
        fx.ctx,
      );

      const rows = await adminDb.workItem.findMany({
        where: { projectId: fx.projectId, type: 'translate' },
        select: { id: true, type: true },
      });
      expect(rows.map((r) => r.id)).toEqual([target.id]);
      expect(rows[0]?.type).toBe('translate');
    });

    it('an admitted type is still refused on a CONTAINER kind — the leaf-only rule is untouched', async () => {
      // Amendment 1 changed the member set and nothing else. §2's leaf-only rule
      // is the part most likely to be eroded by accident while adding members.
      await expect(
        workItemsService.createWorkItem(
          {
            projectId: fx.projectId,
            kind: 'story',
            title: 'A story cannot be legal',
            type: 'legal' as WorkItemTypeDto,
          },
          fx.ctx,
        ),
      ).rejects.toThrow();
    });
  });
});
