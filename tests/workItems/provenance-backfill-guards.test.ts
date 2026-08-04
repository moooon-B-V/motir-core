import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $Enums } from '@prisma/client';
import {
  CANCELLED_STATUS_KEY,
  classifyImplementationSource,
  classifyPlanningSource,
  classifyProvenance,
  type ProvenanceBackfillRow,
} from '@/lib/workItems/provenanceBackfill';

// ARCHITECTURE + CONTRACT GUARDS for the provenance backfill (MOTIR-1760 — the
// vitest gate over MOTIR-1758's merged surface). These are the invariants
// COVERAGE CANNOT SEE: a line can be 100% covered and still write raw SQL,
// still be able to emit `hosted`, or still fabricate a harness. Each `it` below
// fails if the corresponding invariant is broken, which is the point — they are
// tripwires on the properties the backfill's safety rests on, not extra cases.
//
// Two of them are STRUCTURAL (they read source text) because the property is
// structural: "this file never reaches past the repository layer" is a claim
// about which call sites exist, and no runtime assertion can observe the call
// that was not written. The rest are TOTALITY checks — they sweep the whole
// decision space rather than spot-asserting a shape, so a future rule that
// widened the output set fails here instead of silently reaching production.

const ROOT = process.cwd();
const SCRIPT_PATH = join('scripts', 'backfill-work-item-provenance.ts');
const REPOSITORY_PATH = join('lib', 'repositories', 'workItemRepository.ts');

function readSource(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

/**
 * The body of one 2-space-indented object method in a repository/service
 * module — from its `async <name>(` signature to the `\n  },` that closes it.
 * The repositories are flat object literals, so this slice is exact; a renamed
 * or re-indented method makes the lookup throw rather than silently pass an
 * empty string, which is what keeps the guards below honest.
 */
function methodBody(source: string, methodName: string): string {
  const start = source.indexOf(`async ${methodName}(`);
  expect(start, `method ${methodName} not found — did it move or get renamed?`).toBeGreaterThan(-1);
  const end = source.indexOf('\n  },', start);
  expect(end, `method ${methodName} has no 2-space-indented close`).toBeGreaterThan(start);
  return source.slice(start, end);
}

/** The four columns the backfill must NEVER write — no evidence supports them. */
const FABRICABLE_COLUMNS = [
  'planningHarness',
  'planningModel',
  'implementationHarness',
  'implementationModel',
] as const;

describe('the operator script obeys 4-layer — no raw write, no raw SQL', () => {
  const script = readSource(SCRIPT_PATH);

  it('never writes to the work_item table directly', () => {
    // `db.workItem.update / updateMany / upsert / create / delete / …` from the
    // script body would bypass the service's transaction, its workspace-context
    // binding, and the null-guard that makes the whole sweep idempotent. The
    // script's own `db` reads (project lookup, membership lookup) are fine and
    // deliberately not matched: 4-layer's write rule is what this guards.
    const rawWorkItemWrites =
      script.match(
        /\bdb\.workItem\.(update|updateMany|upsert|create|createMany|delete|deleteMany)\b/g,
      ) ?? [];
    expect(rawWorkItemWrites).toEqual([]);
  });

  it('never reaches for raw SQL', () => {
    const rawSql = script.match(/\$(execute|query)Raw(Unsafe)?\b/g) ?? [];
    expect(rawSql).toEqual([]);
  });

  it('reaches persistence only through the service, which owns the repository calls', () => {
    // The positive half of the same rule: it is not enough that the script
    // avoids raw writes — it must actually go through the shipped layer, so
    // the backfill a script runs and the backfill a test drives are one path.
    expect(script).toMatch(/from '@\/lib\/services\/workItemsService'/);
    expect(script).toMatch(/workItemsService\.backfillProvenanceForProject\(/);
    expect(script).not.toMatch(/from '@\/lib\/repositories\//);
  });
});

describe('no fabricated harness or model — structurally unwritable', () => {
  const repository = readSource(REPOSITORY_PATH);

  it.each([
    ['backfillPlanningSourceByIds', 'planningSource'],
    ['backfillImplementationSourceByIds', 'implementationSource'],
  ])('%s writes only its one source column', (methodName, ownColumn) => {
    const body = methodBody(repository, methodName);
    expect(body).toContain(`data: { ${ownColumn}: source }`);
    for (const column of FABRICABLE_COLUMNS) {
      expect(body, `${methodName} must never write ${column}`).not.toContain(column);
    }
  });

  it('the decision table has no channel that could carry a harness or a model', () => {
    // The behavioural half: a fabricated value would have to be DECIDED before
    // it could be written, and the verdict has exactly two slots. Asserting the
    // key set (rather than the values) is what makes this a totality check — a
    // future `planningHarness` slot on the verdict fails here immediately.
    const verdict = classifyProvenance(baseRow(), OPTS);
    expect(Object.keys(verdict).sort()).toEqual(['implementationSource', 'planningSource']);
  });
});

// ── The totality sweep ──────────────────────────────────────────────────────
//
// Every combination of the evidence the classifier reads. Small enough to
// enumerate exhaustively (a few thousand rows), which is exactly why the
// "unreachable" claims below are provable rather than sampled.

const SEED_BURST_END = new Date('2026-06-15T14:27:16.297Z');

const OPTS = {
  seedBurstEnd: SEED_BURST_END,
  implementedStatusKeys: new Set(['done']),
};

const CREATED_AT = [
  new Date(SEED_BURST_END.getTime() - 1),
  SEED_BURST_END,
  new Date(SEED_BURST_END.getTime() + 1),
];
const STATUSES = ['todo', 'blocked', 'in_progress', 'in_review', 'done', CANCELLED_STATUS_KEY];
const TYPES = [null, ...Object.values($Enums.WorkItemType)] as ProvenanceBackfillRow['type'][];
const EXECUTORS = [null, ...Object.values($Enums.Executor)] as ProvenanceBackfillRow['executor'][];
const PLANNING_SOURCES = [
  null,
  ...Object.values($Enums.WorkItemPlanningSource),
] as ProvenanceBackfillRow['planningSource'][];
const IMPLEMENTATION_SOURCES = [
  null,
  ...Object.values($Enums.WorkItemImplementationSource),
] as ProvenanceBackfillRow['implementationSource'][];

function baseRow(): ProvenanceBackfillRow {
  return {
    id: 'row-1',
    identifier: 'PROD-1',
    createdAt: SEED_BURST_END,
    status: 'done',
    type: null,
    executor: null,
    planningSource: null,
    implementationSource: null,
    hasLinkedPr: false,
    sessionBranch: null,
  };
}

/** Every row the classifier can be handed, as one flat generator. */
function* everyRow(): Generator<ProvenanceBackfillRow> {
  for (const createdAt of CREATED_AT)
    for (const status of STATUSES)
      for (const type of TYPES)
        for (const executor of EXECUTORS)
          for (const planningSource of PLANNING_SOURCES)
            for (const implementationSource of IMPLEMENTATION_SOURCES)
              for (const hasLinkedPr of [false, true])
                for (const sessionBranch of [null, 'subtask/MOTIR-1758-x'])
                  yield {
                    ...baseRow(),
                    createdAt,
                    status,
                    type,
                    executor,
                    planningSource,
                    implementationSource,
                    hasLinkedPr,
                    sessionBranch,
                  };
}

describe('the reachable output set, swept exhaustively', () => {
  const planningReached = new Set<string>();
  const implementationReached = new Set<string>();
  let rowsSwept = 0;

  for (const row of everyRow()) {
    rowsSwept += 1;
    const planning = classifyPlanningSource(row, OPTS);
    const implementation = classifyImplementationSource(row, OPTS);
    if (planning !== null) planningReached.add(planning);
    if (implementation !== null) implementationReached.add(implementation);
  }

  it('swept the whole decision space, not a sample', () => {
    const expected =
      CREATED_AT.length *
      STATUSES.length *
      TYPES.length *
      EXECUTORS.length *
      PLANNING_SOURCES.length *
      IMPLEMENTATION_SOURCES.length *
      2 *
      2;
    expect(rowsSwept).toBe(expected);
  });

  it('`hosted` is UNREACHABLE — no row shape can produce it', () => {
    // The load-bearing one. `hosted` means "Motir's own hosted execution ran
    // this", which no self-reported evidence can ever establish (the ADR), and
    // Epic 9 does not exist yet. Derived from the sweep, not spot-asserted: the
    // reachable set is COMPUTED and `hosted` is shown to be outside it.
    expect(implementationReached.has('hosted')).toBe(false);
    expect([...implementationReached].sort()).toEqual(['byok', 'manual']);

    const unreachable = Object.values($Enums.WorkItemImplementationSource).filter(
      (value) => !implementationReached.has(value),
    );
    expect(unreachable).toEqual(['hosted']);
  });

  it('`native` and `api` are UNREACHABLE on the planning half, for the same reason', () => {
    // Its twin: `native` means "materialized from a motir-ai-generated plan",
    // which only `plansService.materialize` can know. If the sweep ever reaches
    // it, the backfill has started inventing planning attribution.
    //
    // `api` (Subtask 11.2.5 — MOTIR-2044) joins it, and the reason is sharper:
    // the backfill's post-seed-burst rule stamps `mcp`, so a row created over
    // `/api/v1` and left NULL would be RE-LABELLED as MCP-authored — a false
    // attribution that cannot be undone, because nothing in a row's shape
    // reveals which write surface made it. That is precisely why the v1 create
    // endpoint stamps `api` itself at write time and why this enum value is a
    // PREREQUISITE of that endpoint rather than a follow-up.
    //
    // ⚠️ THIS ASSERTION IS THE TOTALITY GATE. It is derived from the sweep over
    // `Object.values($Enums.WorkItemPlanningSource)`, so adding an enum member
    // without deciding what the backfill does with it FAILS HERE — which is what
    // caught `api` when it landed. Do not relax it to a `.includes` check.
    expect(planningReached.has('native')).toBe(false);
    expect(planningReached.has('api')).toBe(false);
    expect([...planningReached].sort()).toEqual(['manual', 'mcp']);

    const unreachable = Object.values($Enums.WorkItemPlanningSource).filter(
      (value) => !planningReached.has(value),
    );
    expect(unreachable.sort()).toEqual(['api', 'native']);
  });

  it('never overwrites a row that already carries a source', () => {
    // Idempotence at the RULE level — the guarantee the repository's null-guard
    // then enforces at the write level. Swept over every shape rather than the
    // handful the unit suite pins, so no combination of status/type/executor
    // can talk the classifier past an existing value.
    for (const row of everyRow()) {
      if (row.planningSource !== null) {
        expect(classifyPlanningSource(row, OPTS)).toBeNull();
      }
      if (row.implementationSource !== null) {
        expect(classifyImplementationSource(row, OPTS)).toBeNull();
      }
    }
  });

  it('never stamps an implementation source outside the implemented-status set', () => {
    // Including `cancelled`, which the default workflow files under the `done`
    // CATEGORY — the trap this rule exists to avoid.
    for (const row of everyRow()) {
      if (!OPTS.implementedStatusKeys.has(row.status)) {
        expect(classifyImplementationSource(row, OPTS)).toBeNull();
      }
    }
  });
});
