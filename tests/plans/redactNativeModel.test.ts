import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redactNativeActor, redactNativeProvenance } from '@/lib/plans/redactNativeModel';
import { toPlanDto, toPlanItemDto, toWorkItemPlanHistoryEntryDto } from '@/lib/mappers/planMappers';
import type { Plan, PlanItem } from '@/generated/prisma/client';
import type { PlanHistoryItemRow } from '@/lib/repositories/planItemRepository';

// The ONE rule behind "a plan read never names Motir's model" (MOTIR-7225), and
// the guard that it has one home: every tenant-facing plan serialiser calls the
// helper, and none writes the rule inline.

describe('redactNativeProvenance', () => {
  it('nulls the model of a native provenance and keeps the rest', () => {
    expect(
      redactNativeProvenance({ source: 'native', harness: 'Motir', model: 'claude-opus-5-5' }),
    ).toEqual({ source: 'native', harness: 'Motir', model: null });
  });

  it('returns an mcp provenance unchanged', () => {
    const p = { source: 'mcp', harness: 'Codex', model: 'gpt-5' };
    expect(redactNativeProvenance(p)).toBe(p);
  });

  it('returns a missing provenance unchanged', () => {
    expect(redactNativeProvenance(null)).toBeNull();
    expect(redactNativeProvenance(undefined)).toBeUndefined();
    const sourceless = { model: 'x' };
    expect(redactNativeProvenance(sourceless)).toBe(sourceless);
  });

  it('does not mutate its input — the stored value is untouched', () => {
    const p = { source: 'native', harness: 'Motir', model: 'claude-opus-5-5' };
    redactNativeProvenance(p);
    expect(p.model).toBe('claude-opus-5-5');
  });
});

describe('redactNativeActor', () => {
  it.each([
    ['native', 'claude-opus-5-5', null],
    ['mcp', 'gpt-5', 'gpt-5'],
    ['manual', null, null],
    [null, 'legacy-model', 'legacy-model'],
    [undefined, undefined, null],
  ] as const)('%s / %s → %s', (source, model, expected) => {
    expect(redactNativeActor(source, model)).toBe(expected);
  });
});

const at = new Date('2026-10-02T00:00:00.000Z');

describe('the plan mappers apply it', () => {
  it('toPlanItemDto nulls a native add’s provenance model, keeps an mcp one', () => {
    const row = (provenance: unknown) =>
      ({
        id: 'pi',
        op: 'add',
        workItemId: null,
        proposedFields: { title: 't', kind: 'task', planningProvenance: provenance },
        patch: null,
        parentRef: null,
        blockedByRefs: [],
        supersedesRefs: [],
        baseRevision: null,
        reason: null,
        createdAt: at,
      }) as unknown as PlanItem;
    expect(
      toPlanItemDto(row({ source: 'native', harness: 'Motir', model: 'm' })).proposedFields
        ?.planningProvenance,
    ).toEqual({ source: 'native', harness: 'Motir', model: null });
    expect(
      toPlanItemDto(row({ source: 'mcp', harness: 'Codex', model: 'gpt-5' })).proposedFields
        ?.planningProvenance?.model,
    ).toBe('gpt-5');
  });

  it('toPlanItemDto leaves fields with no provenance as stored', () => {
    const row = {
      id: 'pi',
      op: 'add',
      workItemId: null,
      proposedFields: { title: 't', kind: 'task' },
      patch: null,
      parentRef: null,
      blockedByRefs: [],
      supersedesRefs: [],
      baseRevision: null,
      reason: null,
      createdAt: at,
    } as unknown as PlanItem;
    expect(toPlanItemDto(row).proposedFields).toEqual({ title: 't', kind: 'task' });
  });

  it('toPlanDto and the plan-history entry null a native author model only', () => {
    const plan = (authorSource: string, authorModel: string) =>
      ({
        id: 'p',
        workspaceId: 'w',
        projectId: 'pr',
        status: 'planned',
        title: null,
        summary: null,
        sourceJobId: null,
        sessionId: null,
        origin: 'requested',
        createdById: null,
        authorSource,
        authorHarness: 'h',
        authorModel,
        createdAt: at,
        plannedAt: null,
        decidedAt: null,
        decidedById: null,
        decisionReason: null,
      }) as unknown as Plan;
    expect(toPlanDto(plan('native', 'm'), 0).authorModel).toBeNull();
    expect(toPlanDto(plan('mcp', 'gpt-5'), 0).authorModel).toBe('gpt-5');

    const entry = (p: Plan) =>
      toWorkItemPlanHistoryEntryDto({
        ...p,
        decidedBy: null,
      } as unknown as PlanHistoryItemRow['plan']);
    expect(entry(plan('native', 'm')).author.model).toBeNull();
    expect(entry(plan('mcp', 'gpt-5')).author.model).toBe('gpt-5');
  });
});

// ── ONE HOME FOR THE RULE ───────────────────────────────────────────────────
// Every tenant-facing serialiser that carries a plan model. A new one that reads
// `planningProvenance` / `actorModel` / `authorModel` belongs on this list, and
// the list fails if a member stops calling the helper or writes the rule inline.
const SERIALISERS = [
  'lib/mappers/planMappers.ts',
  'lib/services/planReviewService.ts',
  'lib/mcp/payloads/workLoop.ts',
] as const;

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

describe('the rule has one home', () => {
  it.each(SERIALISERS)('%s calls the helper', (file) => {
    expect(read(file)).toMatch(/redactNative(Actor|Provenance)\(/);
  });

  it.each(SERIALISERS)('%s writes no inline native-model ternary', (file) => {
    expect(read(file)).not.toMatch(/===\s*'native'\s*\?\s*null/);
  });
});
