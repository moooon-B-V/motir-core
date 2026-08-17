import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { scanSystemContexts, schemaMap, systemOnlyReads } from './systemContextScan';

// The SYSTEM-CONTEXT ARM guard (MOTIR-2880) — the FOURTH axis, and the first one
// that asks a question about the DATABASE rather than about the code.
//
//   singleton-read-guard   — can this read be bound?          (a `tx` parameter)
//   call-site-guard        — do its callers bind it?          (a `tx` argument)
//   bare-transaction-guard — what did the transaction bind?   (a `set_config`)
//   THIS ONE               — does any POLICY read what it bound?
//
// Every site below answers YES to the first three. `withSystemContext` opens a
// transaction, binds `app.system_admin`, and hands a `tx` to every read beneath
// it — textbook, by all three sibling instruments. And `app.system_admin` is read
// by a policy ARM that exists PER TABLE: at the commit this landed, 26 of the 69
// RLS-protected tables carry one on a permissive SELECT/ALL policy and 43 do not.
// A read of one of the 43 inside a system context returns ZERO ROWS AND RAISES
// NOTHING, so `parentStatusRollupService` answered `no_parent` for every item,
// `changeRequestStatusSync` stopped driving any card's status, and
// `ciFleetCostMeterService` reported a cost of zero — none of it visible, none of
// it logged, all of it green under three scanners.
//
// ⚠️ THE ASSERTION IS PER (TABLE, CONTEXT) AND IT READS `pg_policies`, NOT THE
// MIGRATIONS. The arm is a property of the DEPLOYED policy set, so the migration
// files are a claim about it and the catalog is the fact (`notes.html` #248, the
// same distinction one layer down). Reading the catalog also means a policy
// dropped by hand, or an arm a later migration removes, turns this red on the
// next run rather than at the next incident.
//
// ⚠️ AND IT ADJUDICATES THE WHOLE QUERY, NOT THE FROM CLAUSE. `notes.html` #269.
// Both sites this card could NOT fix by binding were found through a JOIN and
// would have been cleared by an arm inventory: `projectRepository#findLivePairs`
// reads the armed `project` and dies on its `workspace: { is: {} }` relation
// filter; `ciContainerPeriodCostRepository#sumForPeriodByMetaSplit` reads the
// armed `ci_container_period_cost` and dies on `JOIN "organization"`. So
// `systemContextScan` resolves relation keys and raw-SQL join targets, and the
// assertion below runs over every table the query touches.
//
// The division of labour is the one MOTIR-2784 established and the three sibling
// guards keep: the machine enumerates, a human adjudicates, and a site nobody has
// ruled on fails the build.

/** Why a system-only read of an UNARMED table is nonetheless acceptable. */
type Verdict =
  /**
   * NOT GATED AFTER ALL — the model is in `policyGatedModels` only because that
   * set OVER-APPROXIMATES on purpose (a `workspaceId` column, or a historical
   * `CREATE POLICY` the migration sweep never subtracts). The table has RLS
   * disabled, so no arm is owed.
   *
   * ⚠️ The reason must carry the MEASUREMENT — `pg_class.relrowsecurity` — because
   * that is the authority and the schema heuristic is not.
   */
  | 'no-rls'
  /**
   * CONFIRMED blind under `motir_app`, with a card that owns the fix. Empty today
   * and meant to stay that way: this is where a NEW finding lands while its card
   * is in flight, not a parking space.
   */
  | 'blind-carded';

/**
 * One entry per (FILE#ENCLOSING, model), matching the sibling guards' choice of a
 * LINE-INDEPENDENT key: a system context that moves down its file is the same
 * adjudication, and keying on the line would make every unrelated edit a
 * re-review.
 *
 * ⚠️ EMPTY IS THE HEADLINE, and it is a measurement rather than an aspiration.
 * MOTIR-2872's class 1 opened with 88 system-context sites of which TEN reached a
 * table with no arm. Eight were fixed by BINDING the tenant — the disposition
 * that widens nothing — and two, which are cross-tenant by design and have no
 * single tenant to bind, by a `FOR SELECT` arm on `workspace` and `organization`
 * (`20260817120000_system_admin_read_arms_workspace_organization`). Ten to zero,
 * with no entry left here.
 */
const DELIBERATELY_SYSTEM_ONLY: Record<string, Verdict> = {};

let rlsTables: Set<string>;
let armedTables: Set<string>;

// WARM THE SCAN ONCE, in a hook with its own budget — the reason
// `call-site-guard.test.ts` and `bare-transaction-guard.test.ts` both give: the
// compiler-API walk over `lib/` + `app/` is a few seconds bare, and under
// `vitest run --coverage` the v8 provider instruments it heavily enough to blow
// the repo's 15 s `testTimeout`, so `pnpm test` is green while the coverage lane
// is red. Both roots are warmed — the fixture tree is a SEPARATE cache key, on
// purpose, so a single unkeyed cache could never hand the fixture the real
// repo's answer.
//
// ⚠️ Do NOT "fix" a recurrence by raising `testTimeout`: that is a global knob
// and this is one expensive fixture.
beforeAll(async () => {
  scanSystemContexts();
  scanSystemContexts('tests/rls/__fixtures__/systemContexts');
  const enabled = await adminDb.$queryRaw<{ relname: string }[]>`
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relrowsecurity
  `;
  rlsTables = new Set(enabled.map((r) => r.relname));

  // A table is READ-armed when a PERMISSIVE policy covering SELECT (`FOR SELECT`
  // or `FOR ALL`) has `app.system_admin` in its USING clause. Permissive matters:
  // Postgres combines them with OR, so a permissive arm ADMITS. A restrictive one
  // could only ever narrow, and reading it as an arm would be backwards.
  const arms = await adminDb.$queryRaw<{ tablename: string }[]>`
    SELECT DISTINCT tablename
      FROM pg_policies
     WHERE schemaname = 'public'
       AND permissive = 'PERMISSIVE'
       AND cmd IN ('SELECT', 'ALL')
       AND coalesce(qual, '') LIKE '%system_admin%'
  `;
  armedTables = new Set(arms.map((r) => r.tablename));
}, 120_000);

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('every system-context read touches a table whose policy set reads app.system_admin', () => {
  it('has no unadjudicated (site, table) pair', () => {
    const { tableOf } = schemaMap();
    const findings: string[] = [];

    for (const site of scanSystemContexts()) {
      for (const model of site.systemOnlyModels) {
        const table = tableOf.get(model);
        if (!table) {
          findings.push(`${site.key} :: ${model} — no table in prisma/schema.prisma`);
          continue;
        }
        if (!rlsTables.has(table)) continue; // over-approximation; nothing to be blind to
        if (armedTables.has(table)) continue;
        if (DELIBERATELY_SYSTEM_ONLY[`${site.key} :: ${model}`]) continue;
        findings.push(
          `${site.key} :: ${model} -> "${table}" has RLS and NO system_admin read arm ` +
            `(reached via ${site.via.join(', ')})`,
        );
      }
    }

    expect(
      findings,
      'A `withSystemContext` block reads a table whose policies do not read ' +
        '`app.system_admin`. Under `motir_app` that read returns ZERO ROWS and raises ' +
        'NOTHING.\n\n' +
        'The disposition is one of three, and the FIRST is nearly always right:\n' +
        '  1. BIND the tenant — `bindWorkspaceContext(tx, id)` /\n' +
        '     `bindOrganizationContext(tx, id)` the moment the id is known, or move the\n' +
        '     whole block to `withWorkspaceServiceContext`. Additive, widens nothing.\n' +
        '  2. ARM the table — ONLY when the read is cross-tenant BY DESIGN and there is\n' +
        '     no single tenant to bind. `FOR SELECT` only: the tenant-root WRITE\n' +
        '     refusal (MOTIR-2865) is load-bearing.\n' +
        '  3. ADJUDICATE it here, with the measurement and the card that owns it.\n\n' +
        'Adding an entry to DELIBERATELY_SYSTEM_ONLY without one of the first two is ' +
        'how this class grew back.',
    ).toEqual([]);
  });

  it('has no adjudication left for a pair the scan no longer reports', () => {
    // The mirror of the assertion above, and the half that rots silently: an
    // entry whose site was fixed or deleted keeps a permanent "this is fine" on
    // record for a shape nobody can find any more.
    const { tableOf } = schemaMap();
    const live = new Set(
      scanSystemContexts().flatMap((s) => s.systemOnlyModels.map((m) => `${s.key} :: ${m}`)),
    );
    const stale = Object.keys(DELIBERATELY_SYSTEM_ONLY).filter((k) => !live.has(k));
    expect(stale, 'a verdict for a pair the scan no longer reports — delete it').toEqual([]);
    // …and a verdict of `no-rls` that is no longer true.
    const wrong = Object.entries(DELIBERATELY_SYSTEM_ONLY)
      .filter(([k, v]) => v === 'no-rls' && rlsTables.has(tableOf.get(k.split(' :: ')[1]!) ?? ''))
      .map(([k]) => k);
    expect(wrong, 'adjudicated `no-rls`, but the table has RLS enabled').toEqual([]);
  });

  it('the two un-bindable sites are ARMED, not adjudicated away', () => {
    // The pair this card could not fix by binding, pinned BY NAME. They are the
    // reason two policies were added, so the day someone reverts an arm the
    // failure names the read rather than appearing as an anonymous count.
    expect(armedTables.has('workspace'), 'workspace — projectRepository#findLivePairs').toBe(true);
    expect(
      armedTables.has('organization'),
      'organization — ciContainerPeriodCostRepository#sumForPeriodByMetaSplit',
    ).toBe(true);
  });

  it('the arms are READ-only — no system arm was added to a tenant-root WRITE policy', () => {
    // MOTIR-2865 found the ABSENCE of a system arm on the tenant-root write
    // policies doing useful work: a caller reaching for `withSystemContext` on a
    // membership INSERT is REFUSED rather than over-permitted. Arming a read is
    // how this card fixed two sites; arming a write would trade a visible bug for
    // an invisible hole, so it is asserted against rather than merely avoided.
    return adminDb.$queryRaw<{ tablename: string; policyname: string; cmd: string }[]>`
        SELECT tablename, policyname, cmd
          FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename IN ('workspace', 'organization', 'workspace_membership',
                             'organization_membership')
           AND cmd IN ('INSERT', 'UPDATE', 'DELETE')
           AND (coalesce(qual, '') LIKE '%system_admin%'
                OR coalesce(with_check, '') LIKE '%system_admin%')
      `.then((rows) => {
      expect(
        rows.map((r) => `${r.tablename}.${r.policyname} (${r.cmd})`),
        'a tenant-root WRITE policy now reads app.system_admin — see MOTIR-2865',
      ).toEqual([]);
    });
  });
});

describe('the scanner itself', () => {
  it('rules correctly on a fixture carrying every verdict', () => {
    // THE NEGATIVE CASE, as a permanent test rather than a one-off check, and run
    // against a fixture ROOT so proving the detector works can never leave a stray
    // unbound system context in a real service.
    const root = 'tests/rls/__fixtures__/systemContexts';
    const byEnclosing = new Map(scanSystemContexts(root).map((s) => [s.enclosing, s]));
    const site = (fn: string) => byEnclosing.get(fn);

    // Pinned INDIVIDUALLY. One `toEqual` over the set would pass for the wrong
    // reason the day the scan returns nothing at all.
    expect(site('systemOnlyRead')?.verdict, 'a plain gated read under the flag').toBe(
      'system-only',
    );

    // ⚠️ THE JOIN CASES — the three shapes an arm inventory clears and the query
    // does not. Each must report the JOINED model too, not only the FROM clause.
    expect(site('systemOnlyJoinedRead')?.systemOnlyModels, 'an `include` is a join').toEqual([
      'gadget',
      'widget',
    ]);
    expect(
      site('systemOnlyRelationFilterRead')?.systemOnlyModels,
      'a relation FILTER is a join — this is `findLivePairs`',
    ).toEqual(['gadget', 'widget']);
    expect(
      site('systemOnlyRawJoin')?.systemOnlyModels,
      'a raw-SQL JOIN is a join — this is `sumForPeriodByMetaSplit`',
    ).toEqual(['gadget', 'widget']);

    // The binding, and its POSITION.
    expect(site('bindsBeforeRead')?.verdict, 'bound before the read').toBe('binds-tenant');
    expect(
      site('bindsAfterRead')?.verdict,
      'a binding AFTER the read cannot retroactively bind it — a whole-site boolean ' +
        'gets this wrong, and every site this card fixed binds MID-BLOCK',
    ).toBe('system-only');
    expect(
      site('discoversThenBinds')?.systemOnlyModels,
      'the connection-tier read before the bind is system-only BY DESIGN; only the ' +
        'tenant read after it is bound',
    ).toEqual([]);

    // Nothing gated to be blind to.
    expect(site('systemNonGated')?.verdict).toBe('no-gated-statement');

    // One hop into a same-file helper.
    expect(site('systemOnlyViaHelper')?.verdict, 'one hop into a forwarding helper').toBe(
      'system-only',
    );

    // A tenant-bound context is not a system context, so it is not reported.
    expect(byEnclosing.has('bound'), 'withWorkspaceServiceContext is not a system context').toBe(
      false,
    );

    // THE DEPTH, pinned from both sides. Two hops is IN reach — that is where the
    // `sweepRepo` -> `applyOne` -> `resolveChangeRequestWorkItem` miss lived, and
    // finding it is why the walk is recursive at all. Four is OUT, so the bound is
    // a decision rather than an accident of how deep the tree happened to go.
    expect(site('systemTwoHops')?.verdict, 'two hops — the real miss lived here').toBe(
      'system-only',
    );
    expect(site('systemThreeHops')?.verdict, 'three hops — the last one in reach').toBe(
      'system-only',
    );
    expect(
      site('systemFourHops')?.verdict,
      'four hops is out of reach by design — if this changed, MAX_HELPER_HOPS moved',
    ).toBe('no-gated-statement');

    // Mutual recursion terminates and still reports what it reaches. Without the
    // visited set the bounded walk would be finite but would re-enter `ping` on
    // every level, which is the shape that turns a scan into a hang.
    expect(site('systemMutualRecursion')?.verdict, 'ping/pong terminates').toBe('system-only');
  });

  it('actually finds the sites it is pointed at (a live negative)', () => {
    // A scanner that silently returns nothing passes forever. Pin that it walks the
    // real tree, resolves the schema, and classifies in more than one direction.
    const all = scanSystemContexts();
    expect(all.length).toBeGreaterThan(50);
    expect(all.some((s) => s.verdict === 'binds-tenant')).toBe(true);
    expect(systemOnlyReads().length).toBeGreaterThan(0);
    // Every reported site names a real file and a real enclosing function.
    expect(all.filter((s) => s.enclosing === '<module>')).toEqual([]);
  });
});
