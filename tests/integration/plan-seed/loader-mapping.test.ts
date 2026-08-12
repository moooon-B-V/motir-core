import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { WORK_ITEM_TYPES, defaultExecutorForType } from '@/lib/issues/executorDefaults';
import {
  PLAN_TYPE_TO_WORK_ITEM_TYPE,
  composeDescription,
  mapTypeAndExecutor,
} from '@/scripts/plan-seed/mapItem';
import type { SeedItem } from '@/scripts/plan-seed/types';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';

// Subtask 2.7.7 — the SEED-LOADER mapping half of the type/executor lock-down
// (the gap the other 2.7.7 areas already cover: the default map lives in
// tests/items/executorDefaults.test.ts; the schema + leaf-only + executor
// seeding in tests/integration/work-items/work-item-type-executor.test.ts; the
// FilterAST `type` facet in tests/integration/work-items/filter-builder-matrix
// .test.ts's CASES). What was UNTESTED until now is the loader bridge (2.7.5):
// the pure plan-leaf → structured-field mapping + the "stop emitting prose"
// regression guard, extracted from seed.ts into scripts/plan-seed/mapItem.ts so
// it is testable WITHOUT importing seed.ts (which runs main() against a real DB
// on import). The pure cases need no DB; the final block proves the mapped
// values persist and the prose is gone "via a repository read" (the AC).

/** A minimal plan leaf — only the fields the two pure functions read (`status`
 * is required by SeedItem but irrelevant to the mapping). */
function leaf(overrides: Partial<SeedItem> & Pick<SeedItem, 'id'>): SeedItem {
  return { title: 'A leaf', status: 'planned', ...overrides };
}

describe('mapTypeAndExecutor — plan `type` string → the WorkItemType enum (2.7.5)', () => {
  it('maps every one of the fourteen enum members to itself, seeding the default executor', () => {
    for (const type of WORK_ITEM_TYPES) {
      expect(mapTypeAndExecutor(leaf({ id: `x.${type}`, type }))).toEqual({
        type,
        executor: defaultExecutorForType(type),
      });
    }
  });

  it('normalises the richer/legacy plan-vocabulary aliases DOWN to the enum', () => {
    // The plan vocabulary is wider than the enum members; these collapse in.
    // `spike` and `doc` are the TWO aliases ADR Amendment 1 (MOTIR-2629)
    // declared — each shares an authoring bar with the member it names, which is
    // why neither was admitted. `e2e` and `bug` are loader-local normalisations
    // that predate it.
    expect(mapTypeAndExecutor(leaf({ id: 'a', type: 'e2e' })).type).toBe('test');
    expect(mapTypeAndExecutor(leaf({ id: 'b', type: 'spike' })).type).toBe('research');
    expect(mapTypeAndExecutor(leaf({ id: 'c', type: 'doc' })).type).toBe('content');
    expect(mapTypeAndExecutor(leaf({ id: 'd', type: 'bug' })).type).toBe('code');
  });

  it('maps `copy` to ITSELF — Amendment 1 promoted it from alias to member', () => {
    // The regression this pins: `copy` aliased to `content` for exactly as long
    // as `content`'s ADR gloss read "Copy, docs, and translation". Amendment 1
    // unpacked that bundle, so a plan leaf saying `copy` must now land on the
    // `copy` member and NOT be folded into `content` — which is the whole defect
    // MOTIR-2622 exists to fix, in the one place it had already been encoded.
    expect(mapTypeAndExecutor(leaf({ id: 'e', type: 'copy' }))).toEqual({
      type: 'copy',
      executor: 'coding_agent',
    });
    expect(mapTypeAndExecutor(leaf({ id: 'f', type: 'translate' })).type).toBe('translate');
    expect(mapTypeAndExecutor(leaf({ id: 'g', type: 'verification' })).type).toBe('verification');
    // `legal` is the one admitted member that seeds a HUMAN executor.
    expect(mapTypeAndExecutor(leaf({ id: 'h', type: 'legal' }))).toEqual({
      type: 'legal',
      executor: 'human',
    });
  });

  it('seeds the executor from the type default when the leaf omits one', () => {
    expect(mapTypeAndExecutor(leaf({ id: 'e', type: 'code' })).executor).toBe('coding_agent');
    expect(mapTypeAndExecutor(leaf({ id: 'f', type: 'manual' })).executor).toBe('human');
    // an alias seeds from its NORMALISED type's default (e2e → test → coding_agent)
    expect(mapTypeAndExecutor(leaf({ id: 'g', type: 'e2e' })).executor).toBe('coding_agent');
  });

  it('honours an explicit executor over the default (override wins)', () => {
    expect(mapTypeAndExecutor(leaf({ id: 'h', type: 'code', executor: 'human' }))).toEqual({
      type: 'code',
      executor: 'human',
    });
    expect(mapTypeAndExecutor(leaf({ id: 'i', type: 'manual', executor: 'coding_agent' }))).toEqual(
      {
        type: 'manual',
        executor: 'coding_agent',
      },
    );
  });

  it('returns {null, null} for an untyped leaf (containers / legacy rows)', () => {
    expect(mapTypeAndExecutor(leaf({ id: 'j' }))).toEqual({ type: null, executor: null });
  });

  it('honours an explicit executor even with no type rather than dropping it', () => {
    expect(mapTypeAndExecutor(leaf({ id: 'k', executor: 'human' }))).toEqual({
      type: null,
      executor: 'human',
    });
  });

  it('ABORTS on an unknown plan type (a plan typo is a seed-time error, not a silent drop)', () => {
    expect(() => mapTypeAndExecutor(leaf({ id: '9.9.9', type: 'kode' }))).toThrowError(
      /work item 9\.9\.9 has an unknown type "kode"/,
    );
    // the error names the allowed set so the fix is obvious.
    // NB `translate` used to be this example — MOTIR-2629 admitted it, so the
    // stand-in has to be a string that is still genuinely outside the vocabulary.
    expect(() => mapTypeAndExecutor(leaf({ id: 'z', type: 'transliterate' }))).toThrowError(
      /Allowed plan types:/,
    );
  });

  it('every alias target is a real WorkItemType enum member (no dangling mapping)', () => {
    const enumSet = new Set<string>(WORK_ITEM_TYPES);
    for (const [planType, mapped] of Object.entries(PLAN_TYPE_TO_WORK_ITEM_TYPE)) {
      expect(enumSet, `${planType} → ${mapped}`).toContain(mapped);
    }
    // the ten members are present as identity entries
    for (const type of WORK_ITEM_TYPES) expect(PLAN_TYPE_TO_WORK_ITEM_TYPE[type]).toBe(type);
  });
});

describe('composeDescription — the "stop emitting prose" regression guard (2.7.5)', () => {
  it('does NOT stringify type/executor into the description (they are columns now)', () => {
    const out = composeDescription(
      leaf({
        id: '2.7.5',
        type: 'code',
        executor: 'coding_agent',
        estimateMinutes: 40,
        dependsOn: ['2.7.3'],
        descriptionMd: 'Close the loader loop.',
      }),
    );
    expect(out).not.toBeNull();
    expect(out!).not.toContain('Type:');
    expect(out!).not.toContain('Executor:');
    // the blockquote keeps only the estimate + depends-on hints + the real prose
    expect(out!).toContain('**Estimate:** 40m');
    expect(out!).toContain('**Depends on:** 2.7.3');
    expect(out!).toContain('Close the loader loop.');
  });

  it('returns the bare prose with no blockquote when there is no estimate/deps', () => {
    expect(composeDescription(leaf({ id: 'm', type: 'code', descriptionMd: 'Just prose.' }))).toBe(
      'Just prose.',
    );
  });

  it('returns null for a leaf with neither prose nor metadata', () => {
    expect(composeDescription(leaf({ id: 'n' }))).toBeNull();
  });
});

describe('the loader mapping persists structured fields + prose-free description (repository read)', () => {
  async function truncateAll(): Promise<void> {
    await adminDb.$executeRawUnsafe(
      'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
    );
    await truncateAuthTables();
  }

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await db.$disconnect();
    await adminDb.$disconnect();
  });

  it('writes work_item.type/executor as STRUCTURED columns with no Type:/Executor: prose', async () => {
    const fx = await makeWorkItemFixture();
    // A plan leaf carrying the richer `e2e` vocabulary + no explicit executor —
    // exercises both the alias normalisation and the default-seeding end to end.
    const planLeaf = leaf({
      id: '2.7.8',
      title: 'E2E — type picker + filter',
      type: 'e2e',
      estimateMinutes: 40,
      dependsOn: ['2.7.4'],
      descriptionMd: 'Pick a type + executor on create, then filter by type.',
    });

    const { type, executor } = mapTypeAndExecutor(planLeaf);
    expect({ type, executor }).toEqual({ type: 'test', executor: 'coding_agent' });

    // Persist through the shipped create path (the same columns the loader writes).
    const created = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: planLeaf.title,
        type,
        executor,
        descriptionMd: composeDescription(planLeaf),
      },
      fx.ctx,
    );

    // Assert via a REPOSITORY READ (the AC) — the structured columns are set…
    const row = await workItemRepository.findById(created.id);
    expect(row?.type).toBe('test');
    expect(row?.executor).toBe('coding_agent');
    // …and the persisted description carries no type/executor prose.
    expect(row?.descriptionMd).toBeTruthy();
    expect(row!.descriptionMd!).not.toContain('Type:');
    expect(row!.descriptionMd!).not.toContain('Executor:');
    expect(row!.descriptionMd!).toContain('Pick a type + executor on create');
  });
});
