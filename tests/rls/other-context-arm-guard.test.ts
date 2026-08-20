import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { OTHER_CONTEXTS, scanContexts, schemaMap, type ContextDescriptor } from './contextArmScan';
import { armedTables, rlsEnabledTables } from './policyArms';

// The REMAINING context families (MOTIR-2959 step 4) — every `with*Context`
// helper the tree has, adjudicated on the same axis as its two siblings.
//
//   system-context-arm-guard — `withSystemContext`                 (app.system_admin)
//   org-context-arm-guard    — the org-SERVICE pair                (app.organization_id)
//   THIS ONE                 — workspace, workspace+user, org+user, user
//
// ── Why one guard for four descriptors, and why no CEILING ──────────────────
// MOTIR-2959 asked for these to sit "enumerated-but-unadjudicated behind their
// own ceiling IF their verdict count is large — a ceiling that can fall and
// never rise is the division of labour MOTIR-2784 established, and it is better
// than a third hand sweep."
//
// That "if" is a QUERY, not a characterisation, and it was answered before the
// mechanism was chosen (`notes.html` #317 — a COUNT and a COMPOSITION are two
// measurements in one sentence, and the reader inherits the confidence of the
// half that earned it). Measured on `origin/main` @ `7de5856f`:
//
//   descriptor                sites   context-only   UNARMED (site, table) pairs
//   workspace-service           893            866                            0
//   workspace-user              384            335                            0
//   org-user                     19             15                            0
//   user                         39             27                            1
//
// **One pair.** A ceiling exists to bound a population nobody can afford to read;
// a population of one is a verdict to write down, and it is written down below.
// The 1201 `context-only` workspace sites are not a backlog — 64 of the 72
// RLS-protected tables carry an `app.workspace_id` arm, which is what a
// workspace-tier product should look like, and the guard says so by finding
// nothing.
//
// ⚠️ THE COST IS REAL, AND THE FIRST VERSION OF THIS FILE FAILED CI ON IT.
// `beforeAll` took 196 s against a 180 s budget on the Vitest 3/3 shard and took
// the run red. The cause was not the budget: `scanContexts` parsed all 3085 files
// in `lib/` + `app/` + `tests/` and only THEN asked whether the text mentioned
// the descriptor's helper, so four descriptors meant four full parses of a tree
// in which 318 files mention any helper at all. The parse cache and the
// text-test-before-parse in `contextArmScan.ts` are the fix, and they are load-
// bearing rather than tidy: the four scans went 8.5 s -> 1.26 s locally, and the
// single-descriptor system guard 2.5 s -> 0.86 s with them.
//
// The budget below stays at 180 s, which is now ~7x headroom at CI's measured
// ~20x factor over this box, and this file stays SEPARATE from the two guards
// that must stay cheap. Raising a budget is the wrong knob for work that is
// being done four times — every sibling guard says so about `testTimeout`, and
// it is exactly as true one level up.

/** Why a context-only read of an UNARMED table is nonetheless acceptable. */
type Verdict =
  /** The table has RLS disabled — `policyGatedModels` over-approximates on purpose. */
  | 'no-rls'
  /**
   * Admitted by a policy that reads NO GUC AT ALL — the public arms. An arm
   * inventory keyed on a setting name cannot see these, so they surface as
   * findings and are cleared here.
   */
  | 'guc-less-arm'
  /** CONFIRMED blind under `motir_app`, with a card that owns the fix. */
  | 'blind-carded';

/**
 * One entry per (descriptor, site, model). Keyed `<descriptor>::<site.key> :: <model>`.
 *
 * ⚠️ ONE ENTRY, and it is a FALSE POSITIVE OF THE ARM INVENTORY rather than a
 * blind read — which is exactly the third legitimate shape `contextArmScan`'s
 * header names and the reason these families are adjudicated instead of adopted.
 */
const DELIBERATELY_UNARMED: Record<string, { verdict: Verdict; why: string }> = {
  'user::lib/services/publicRequestsService.ts#toggleUpvote :: workItem': {
    verdict: 'guc-less-arm',
    why:
      '`work_item_public_project_read` admits this row and reads NO GUC — it fires when ' +
      "`app.workspace_id` is EMPTY and the item's project is public, which is exactly the " +
      'state `withUserContext` leaves the transaction in. A public request is a work item in ' +
      'a public project by definition, so the `lockById` FOR UPDATE finds its row. Settled by ' +
      'the suite rather than by reading: four files exercise `toggleUpvote` under `motir_app` ' +
      '(`tests/publicRequests/upvoteComment.test.ts`, `tests/publicProjects/publicRequestDetail' +
      '.test.ts`, `tests/publicProjects/publicAccessAndProjection.test.ts`, ' +
      '`tests/permissions/publicProjectAccess.test.ts`) and `main` is green — a blind lock ' +
      'would take every one of them with it.',
  },
};

let rlsTables: Set<string>;
const armed = new Map<string, Set<string>>();

function findingsFor(descriptor: ContextDescriptor): string[] {
  const { tableOf } = schemaMap();
  const armedHere = armed.get(descriptor.id)!;
  const out: string[] = [];
  for (const site of scanContexts(descriptor)) {
    for (const model of site.contextOnlyModels) {
      const table = tableOf.get(model);
      if (!table || !rlsTables.has(table) || armedHere.has(table)) continue;
      if (DELIBERATELY_UNARMED[`${descriptor.id}::${site.key} :: ${model}`]) continue;
      out.push(
        `${descriptor.id}::${site.key} :: ${model} -> "${table}" has RLS and no arm reading ` +
          `${descriptor.gucs.join(' / ')} (reached via ${site.via.join(', ')})`,
      );
    }
  }
  return out;
}

beforeAll(async () => {
  rlsTables = await rlsEnabledTables();
  for (const d of OTHER_CONTEXTS) {
    scanContexts(d);
    const set = new Set<string>();
    for (const guc of d.gucs) for (const t of await armedTables(guc)) set.add(t);
    armed.set(d.id, set);
  }
}, 180_000);

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('every remaining context family reads through an arm that names its GUC', () => {
  for (const descriptor of OTHER_CONTEXTS) {
    it(`${descriptor.id} — ${descriptor.label}`, () => {
      expect(
        findingsFor(descriptor),
        `A \`${descriptor.label}\` block reads a table whose policies do not read ` +
          `${descriptor.gucs.join(' or ')}. Under \`motir_app\` that read returns ZERO ROWS and ` +
          `raises NOTHING — the class that cost MOTIR-2864, MOTIR-2910 and MOTIR-2956, each ` +
          `found by a test going red rather than by anyone reading a policy.\n\n` +
          `Before adjudicating: check for a GUC-LESS arm. The public-project policies admit ` +
          `rows without reading any setting, so an inventory keyed on a setting NAME cannot ` +
          `see them and reports a healthy read as blind. That is a \`guc-less-arm\` verdict, ` +
          `and it owes the policy name.\n\n` +
          `Otherwise the disposition is the sibling guards': bind something narrower, arm the ` +
          `table (FOR SELECT, every table the query TOUCHES), or record the verdict here with ` +
          `the card that owns it.`,
      ).toEqual([]);
    });
  }

  it('has no adjudication left for a pair the scan no longer reports', () => {
    // The mirror, and the half that rots silently.
    const { tableOf } = schemaMap();
    const live = new Set(
      OTHER_CONTEXTS.flatMap((d) =>
        scanContexts(d).flatMap((s) => s.contextOnlyModels.map((m) => `${d.id}::${s.key} :: ${m}`)),
      ),
    );
    expect(
      Object.keys(DELIBERATELY_UNARMED).filter((k) => !live.has(k)),
      'a verdict for a pair the scan no longer reports — delete it',
    ).toEqual([]);
    const wrong = Object.entries(DELIBERATELY_UNARMED)
      .filter(
        ([k, v]) => v.verdict === 'no-rls' && rlsTables.has(tableOf.get(k.split(' :: ')[1]!) ?? ''),
      )
      .map(([k]) => k);
    expect(wrong, 'adjudicated `no-rls`, but the table has RLS enabled').toEqual([]);
  });
});

describe('the four descriptors actually reach the tree', () => {
  it('each finds sites, and none keys as `<module>`', () => {
    // A descriptor whose helper is renamed finds NOTHING and passes forever —
    // the way a guard over an absent population goes quietly useless. The floors
    // are an order of magnitude below the populations at `7de5856f`
    // (893 / 384 / 19 / 39) so ordinary movement cannot reach them.
    const floors: Record<string, number> = {
      'workspace-service': 250,
      'workspace-user': 100,
      'org-user': 6,
      user: 12,
    };
    for (const d of OTHER_CONTEXTS) {
      const sites = scanContexts(d);
      expect(sites.length, `${d.id} — ${d.label} reaches the tree`).toBeGreaterThan(floors[d.id]!);
      expect(
        sites.filter((s) => s.enclosing === '<module>'),
        `${d.id} — every site names a real enclosing function`,
      ).toEqual([]);
    }
  });
});
