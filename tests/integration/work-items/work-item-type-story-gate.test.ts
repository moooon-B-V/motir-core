import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { WorkItemType } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import {
  WORK_ITEM_TYPES,
  defaultExecutorForType,
  isWorkItemType,
} from '@/lib/issues/executorDefaults';
import { WORK_ITEM_TYPE_GROUP, WORK_ITEM_TYPE_META } from '@/lib/issues/workItemTypeMeta';
import { FILTER_FIELDS } from '@/lib/filters/registry';
import { workItemSummarySchema } from '@/lib/api/v1/workItems/schema';
import { workItemsService } from '@/lib/services/workItemsService';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';

// MOTIR-2634 — the STORY gate for the work-item type vocabulary.
//
// ── What this file is, and what it deliberately is not ──────────────────────
// The sibling cards' suites answer "did the four admitted members land?"
// (tests/integration/work-items/work-item-type-admitted-four.test.ts) and "do
// the three surfaces render them?" (tests/components/work-item-type-surfaces
// .test.tsx). Neither of those keeps working when the NEXT member is added.
//
// This file asks the durable question instead: **do the seven homes a work type
// must exist in stay in step with each other, for EVERY member?** It is
// parameterised over `WORK_ITEM_TYPES` rather than over the four, so it does not
// need editing when the set grows — it just starts failing at whichever home was
// forgotten.
//
// The homes:
//
//   1. the Prisma enum                    prisma/schema.prisma
//   2. the canonical ordered list         lib/issues/executorDefaults.ts
//   3. the DTO union                      lib/dto/workItems.ts
//   4. the executor default map           lib/issues/executorDefaults.ts
//   5. the presentation map + group       lib/issues/workItemTypeMeta.ts
//   6. the colour token                   packages/design-system/theme.css
//   7. both message catalogues            messages/{en,zh}.json
//
// Home 6 is the one nothing checked before this card, and it is the one that
// fails most quietly: a `hueVar` naming a token that does not exist yields a
// glyph with no colour, in production only, with a green build and green tests.
//
// ── Each guard was proven by MUTATION, not by assertion alone (AC 3) ─────────
// Every guard below was verified by deleting one member from ONE home and
// watching it go red, then restoring. Recorded in the PR body with the actual
// failure output. A guard that passes both before and after the thing it claims
// to catch is worse than no guard, because it reads as coverage.

const THEME_CSS = readFileSync(resolve(process.cwd(), 'packages/design-system/theme.css'), 'utf8');

/** Every `--el-type-*` custom property DEFINED (not merely referenced) in the theme. */
function definedTypeTokens(): Set<string> {
  return new Set(
    [...THEME_CSS.matchAll(/^\s*(--el-type-[a-z-]+)\s*:/gm)].map((m) => m[1] as string),
  );
}

describe('GUARD 1 — the enum, the ordered list and the DTO union are ONE set', () => {
  it('the Prisma enum and WORK_ITEM_TYPES agree on members AND order', () => {
    // Order, not just membership: the list is what every picker, legend and
    // filter menu iterates, and the migration anchors the database's own
    // `enumsortorder` to it, so a divergence here is real drift and not taste.
    expect(Object.values(WorkItemType)).toEqual([...WORK_ITEM_TYPES]);
  });

  it('the DTO union covers the list exactly, in both directions', () => {
    // `WORK_ITEM_TYPES` is `satisfies readonly WorkItemTypeDto[]`, so a list
    // member outside the union is a compile error. The other direction — a union
    // member missing from the list — has no compile-time signal, and this is it:
    // every total `Record<WorkItemTypeDto, …>` must have exactly these keys.
    expect(Object.keys(WORK_ITEM_TYPE_META).sort()).toEqual([...WORK_ITEM_TYPES].sort());
    expect(Object.keys(WORK_ITEM_TYPE_GROUP).sort()).toEqual([...WORK_ITEM_TYPES].sort());
  });

  it('the narrowing guard accepts every member and rejects a plausible non-member', () => {
    for (const type of WORK_ITEM_TYPES) expect(isWorkItemType(type)).toBe(true);
    // The two names ADR Amendment 1 declared ALIASES must not narrow — admitting
    // a duplicate is the failure the amendment weighed as worse than the gap.
    expect(isWorkItemType('doc')).toBe(false);
    expect(isWorkItemType('spike')).toBe(false);
    expect(isWorkItemType('')).toBe(false);
    expect(isWorkItemType(null)).toBe(false);
  });
});

describe('GUARD 2 — the behaviour maps are TOTAL over the set', () => {
  it.each([...WORK_ITEM_TYPES])('%s has an executor default', (type) => {
    const ex = defaultExecutorForType(type);
    expect(ex === 'coding_agent' || ex === 'human', `${type} -> ${ex}`).toBe(true);
  });

  it.each([...WORK_ITEM_TYPES])('%s has presentation metadata and a group', (type) => {
    const meta = WORK_ITEM_TYPE_META[type];
    expect(meta.type).toBe(type);
    expect(meta.icon).toBeTruthy();
    expect(WORK_ITEM_TYPE_GROUP[type]).toBeTruthy();
  });

  it('the filter facet whitelist IS the set — it reads the list, never restates it', () => {
    expect(FILTER_FIELDS.find((f) => f.id === 'type')?.valueWhitelist).toEqual([
      ...WORK_ITEM_TYPES,
    ]);
  });
});

describe('GUARD 3 — every member has a label in BOTH catalogues, no orphans', () => {
  it.each([...WORK_ITEM_TYPES])('%s has an en label and a zh twin', (type) => {
    const en = (enMessages.labels.workItemType as Record<string, string>)[type];
    const zh = (zhMessages.labels.workItemType as Record<string, string>)[type];
    expect(en, `en label for ${type}`).toBeTruthy();
    expect(zh, `zh label for ${type}`).toBeTruthy();
    // A zh twin that is just the en string back is a missing translation wearing
    // a present one — the parity check would pass and the product would not.
    expect(zh, `zh label for ${type} is untranslated`).not.toBe(en);
  });

  it('has NO ORPHAN key in either direction (AC 4)', () => {
    // Both directions explicitly: an `en` key with no `zh` twin ships an English
    // string to a Chinese reader; an orphan `zh` key is dead weight that hides a
    // rename. Neither is visible from one side alone.
    const en = Object.keys(enMessages.labels.workItemType).sort();
    const zh = Object.keys(zhMessages.labels.workItemType).sort();
    expect(zh).toEqual(en);
    expect(en).toEqual([...WORK_ITEM_TYPES].sort());

    const enG = Object.keys(enMessages.labels.workItemTypeGroup).sort();
    const zhG = Object.keys(zhMessages.labels.workItemTypeGroup).sort();
    expect(zhG).toEqual(enG);
    // Every group a member claims must have a header string to render.
    expect(new Set(Object.values(WORK_ITEM_TYPE_GROUP)).size).toBeLessThanOrEqual(enG.length);
    for (const group of new Set(Object.values(WORK_ITEM_TYPE_GROUP))) {
      expect(enG, `group '${group}' has no en header`).toContain(group);
    }
  });
});

describe('GUARD 4 — every hue token is DEFINED in the design system, not just named', () => {
  // The home nothing checked before this card. `hueVar` is a string, so a typo
  // or a token that never landed compiles, type-checks, renders, and produces a
  // colourless glyph in production only.
  it.each([...WORK_ITEM_TYPES])('%s resolves to a token defined in theme.css', (type) => {
    const defined = definedTypeTokens();
    expect(defined, `${WORK_ITEM_TYPE_META[type].hueVar} is not defined`).toContain(
      WORK_ITEM_TYPE_META[type].hueVar,
    );
  });

  it('each definition points at a palette token — never a raw colour', () => {
    // The colour rule, mechanised for this token family: an invented hue neither
    // swaps with `data-palette` nor stays distinct from its siblings.
    for (const type of WORK_ITEM_TYPES) {
      const decl = new RegExp(`${WORK_ITEM_TYPE_META[type].hueVar}\\s*:\\s*([^;]+);`);
      const value = THEME_CSS.match(decl)?.[1]?.trim();
      expect(value, `no declaration for ${type}`).toBeTruthy();
      expect(value, `${type} is a raw colour, not a palette token`).toMatch(/^var\(--color-/);
    }
  });

  it('the hueClass is the hueVar wrapped in a COMPLETE literal utility', () => {
    for (const type of WORK_ITEM_TYPES) {
      const meta = WORK_ITEM_TYPE_META[type];
      expect(meta.hueClass).toBe(`text-(${meta.hueVar})`);
    }
  });
});

describe('the integration seam — a type survives the whole path, on real Postgres', () => {
  let fx: WorkItemFixture;

  beforeEach(async () => {
    await truncateAuthTables();
    fx = await makeWorkItemFixture();
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  // Every member, not only the four admitted: the seam is what breaks when a
  // reader is added, and a reader added tomorrow drops an OLD type just as
  // easily as a new one.
  it.each([...WORK_ITEM_TYPES])(
    '%s round-trips create -> DTO read -> filter -> the v1 API shape',
    async (type) => {
      const created = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: `A ${type} card`, type },
        fx.ctx,
      );

      // 1. The DTO the app reads. This is the drop this guards against: a value
      //    the writer accepts and the reader silently omits or nulls.
      expect(created.type).toBe(type);
      expect(created.executor).toBe(defaultExecutorForType(type));

      // 2. The filter path — a query for this type returns exactly this row.
      const filtered = await db.workItem.findMany({
        where: { projectId: fx.projectId, type },
        select: { id: true },
      });
      expect(filtered.map((r) => r.id)).toContain(created.id);

      // 3. The v1 API SHAPE, parsed by the published zod schema rather than
      //    eyeballed — an enum the schema does not offer fails here, which is
      //    exactly the "storable but not publishable" defect the story is about.
      const parsed = workItemSummarySchema.safeParse({
        key: created.identifier,
        kind: created.kind,
        type: created.type,
        title: created.title,
        status: created.status,
        priority: created.priority,
        assigneeId: created.assigneeId ?? null,
        reporterId: created.reporterId,
        dueDate: null,
        estimateMinutes: created.estimateMinutes ?? null,
        storyPoints: created.storyPoints ?? null,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        dependencies: { blockedBy: [], blocks: [] },
      });
      expect(parsed.success, `v1 schema rejected type '${type}'`).toBe(true);
      if (parsed.success) expect(parsed.data.type).toBe(type);
    },
  );

  it('the v1 schema REJECTS a non-member, so the enum is genuinely closed', () => {
    // The mirror of the loop above. Without this, "the schema accepts every
    // member" would also be true of a schema that accepts anything at all.
    const base = {
      key: 'PROD-1',
      kind: 'task' as const,
      title: 't',
      status: 'todo',
      priority: 'medium' as const,
      assigneeId: null,
      reporterId: 'u1',
      dueDate: null,
      estimateMinutes: null,
      storyPoints: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      dependencies: { blockedBy: [], blocks: [] },
    };
    for (const alias of ['doc', 'spike', 'kode'] as unknown as WorkItemTypeDto[]) {
      expect(
        workItemSummarySchema.safeParse({ ...base, type: alias }).success,
        `v1 schema wrongly accepted '${alias}'`,
      ).toBe(false);
    }
  });
});
