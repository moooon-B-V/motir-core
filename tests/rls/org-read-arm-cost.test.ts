import { afterAll, describe, expect, it } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// THE COST OF AN ARM — Story MOTIR-4669 · the fix in
// `20260906180000_org_read_arms_resolve_the_org_once`.
//
// A row-level-security policy is not a feature of the surface that motivated it.
// It is an expression Postgres evaluates on EVERY read of the table, for ever,
// by every caller — most of whom have never heard of the story that added it.
//
// The four org-read arms this story shipped resolved the caller's organisation
// with a subquery that read `workspace` and also mentioned the row being
// filtered. Correlated, so the planner cannot hoist it: once per candidate row.
// And `workspace` is RLS-enabled WITH FORCE, so each of those evaluations
// layered `workspace`'s own policies — one of which tests
// `organization_membership` — inside the visibility test of every row of four of
// the busiest tables in the schema.
//
// Measured on one file that touches no repository surface at all
// (`tests/github/ciGreenPromotion.test.ts`): 8.3s with no arms, 23.4s with them.
// In CI, twelve shards contending for one Postgres, that 3× pushed EIGHT shards
// over the 15s per-test timeout — in `cli-story`, `completeSessionRefusals`,
// `work-loop-conformance`, files with nothing to do with repositories. The
// failure was a wall of unattributable timeouts, which is the worst shape a
// regression can take: nothing named the cause.
//
// ⚠️ WHAT THIS GUARD PINS IS THE SHAPE, NOT A DURATION. A timing assertion on a
// shared CI box is a flake generator. The shape is checkable and it is the whole
// fix: the caller's workspace GUC is read in exactly ONE place — inside
// `app_caller_organization_id()`, which takes no argument, so
// `(SELECT app_caller_organization_id())` is uncorrelated and Postgres evaluates
// it once per query. An arm that names `app.workspace_id` in its own predicate
// has, by construction, re-correlated the lookup.

interface PolicyRow {
  polname: string;
  qual: string | null;
}

/** The four arms this story added, and the tables they widen reads on. */
const ORG_READ_ARMS = [
  'github_repo_org_read',
  'github_pull_request_org_read',
  'github_check_run_org_read',
  'project_repository_org_read',
] as const;

async function arms(): Promise<PolicyRow[]> {
  return adminDb.$queryRaw<PolicyRow[]>`
    SELECT polname, pg_get_expr(polqual, polrelid) AS qual
      FROM pg_policy
     WHERE polname = ANY(${[...ORG_READ_ARMS]}::text[])
     ORDER BY polname
  `;
}

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('the org read arms resolve the organisation ONCE, not once per row', () => {
  it('all four exist', async () => {
    expect((await arms()).map((p) => p.polname).sort()).toEqual([...ORG_READ_ARMS].sort());
  });

  it('⚠️ none of them reads `app.workspace_id` in its own predicate', async () => {
    // The regression, stated as the thing that is now false. Every arm shipped
    // with `w."id" = current_setting('app.workspace_id', true)` INSIDE a
    // correlated subquery over `workspace`; the fix moved that one read into
    // `app_caller_organization_id()`. So an arm naming the GUC directly has
    // re-inlined it — the exact defect, wearing whatever new syntax.
    const offenders = (await arms())
      .filter((p) => (p.qual ?? '').includes('app.workspace_id'))
      .map((p) => p.polname);
    expect(
      offenders,
      'An org read arm resolves the caller organisation through ' +
        '`(SELECT app_caller_organization_id())`, which is uncorrelated and therefore ' +
        'evaluated once per query. Reading `app.workspace_id` inside the policy puts the ' +
        '`workspace` lookup back in the per-row path — and `workspace` is RLS-enabled with ' +
        'FORCE, so that lookup carries its own policies with it. This is not a micro- ' +
        'optimisation: it tripled the runtime of test files that touch no repository at all.',
    ).toEqual([]);
  });

  it('all four call the shared resolver', async () => {
    for (const p of await arms()) {
      expect(p.qual ?? '', p.polname).toContain('app_caller_organization_id');
    }
  });

  it('⚠️ the resolver is STABLE and SECURITY INVOKER — the default, deliberately', async () => {
    // A `SECURITY DEFINER` variant was measured and bought nothing (8.4s vs
    // 8.8s): the gain is the InitPlan, not an RLS bypass. So the function keeps
    // the property the original migration documented — the workspace lookup runs
    // under the CALLER's own policies, resolving because `workspace_active`
    // admits `id = app.workspace_id`. Turning on SECURITY DEFINER here would add
    // a privilege boundary in exchange for nothing.
    const [fn] = await adminDb.$queryRaw<
      { provolatile: string; prosecdef: boolean; proconfig: string[] | null }[]
    >`
      SELECT provolatile::text, prosecdef, proconfig
        FROM pg_proc
       WHERE proname = 'app_caller_organization_id'
    `;
    expect(fn, 'app_caller_organization_id() is missing').toBeTruthy();
    expect(fn!.prosecdef, 'the resolver must stay SECURITY INVOKER').toBe(false);
    expect(fn!.provolatile, 'STABLE — it reads a GUC and a table').toBe('s');
    expect(fn!.proconfig?.join(','), 'search_path is pinned').toContain('search_path');
  });

  it('⚠️ the arms are FOR SELECT, and the FOR ALL policies are untouched', async () => {
    // The half that is about authority rather than cost, restated here because
    // this file rewrites all four predicates: DELETE is authorised by `USING`
    // alone, so an org arm that were `FOR ALL` would hand a sibling workspace a
    // delete it never had.
    const rows = await adminDb.$queryRaw<{ polname: string; polcmd: string }[]>`
      SELECT polname, polcmd::text
        FROM pg_policy
       WHERE polname = ANY(${[...ORG_READ_ARMS]}::text[])
    `;
    for (const r of rows) expect(r.polcmd, r.polname).toBe('r');
  });
});
