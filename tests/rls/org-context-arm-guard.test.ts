import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDb } from '../helpers/adminDb';
import { ORG_SERVICE_CONTEXT, contextOnlyReads, scanContexts, schemaMap } from './contextArmScan';
import { armedTables, rlsEnabledTables } from './policyArms';

// The ORG-CONTEXT ARM guard (MOTIR-2959) — the same question one axis over.
//
//   singleton-read-guard      — can this read be bound?         (a `tx` parameter)
//   call-site-guard           — do its callers bind it?         (a `tx` argument)
//   bare-transaction-guard    — what did the transaction bind?  (a `set_config`)
//   system-context-arm-guard  — does a policy read `app.system_admin`?
//   THIS ONE                  — does a policy read `app.organization_id`?
//
// ── Why it exists, and why it is a SECOND guard rather than more sites ──────
// MOTIR-2956: the free-tier 2 GB storage cap silently never fired, for any
// organization, on any tier with a finite cap. `entitlementsService
// .assertWithinStorageCap` opened `withOrgServiceWriteContext`, bound
// `app.organization_id`, and summed `attachment` ⨝ `workspace` — neither of
// which had a policy reading that GUC. The sum came back 0 and 0 is under every
// cap. Above those three lines sat a comment naming that exact failure mode: the
// safeguard and the defect were the same three lines, and every reviewer who
// looked at them saw an author who had understood the risk.
//
// That card SWEPT the family by hand — twelve call sites, one broken, eleven
// written down in `docs/rls-runtime-role-inventory.md`. **A hand sweep is a
// snapshot.** The thirteenth call site, or a JOIN added to an existing
// repository method, restores the class in silence. This guard is the sweep
// re-derived on every run, which is the difference between a document and a
// ratchet.
//
// ⚠️ THE ASSERTION IS PER (TABLE, CONTEXT) AND IT READS `pg_policies`, NOT THE
// MIGRATIONS — `tests/rls/policyArms.ts`, which also records what that inventory
// can and cannot answer.
//
// ⚠️ AND IT ADJUDICATES THE WHOLE QUERY, NOT THE FROM CLAUSE. `notes.html` #269,
// and here it is load-bearing rather than theoretical: `sumSizeByOrganization`
// is `FROM "attachment" JOIN "workspace"`, so arming `attachment` alone would
// have left the sum at zero — the fix reading as applied while changing nothing.
// `the JOIN target is adjudicated too` below proves the guard sees it, by
// reconstructing the arm set as it stood before that migration.

/** Why an org-context read of an UNARMED table is nonetheless acceptable. */
type Verdict =
  /**
   * NOT GATED AFTER ALL — the model is in `policyGatedModels` only because that
   * set OVER-APPROXIMATES on purpose. The table has RLS disabled, so no arm is
   * owed. The reason must carry the MEASUREMENT (`pg_class.relrowsecurity`).
   */
  | 'no-rls'
  /**
   * CONFIRMED blind under `motir_app`, with a card that owns the fix. Empty
   * today and meant to stay that way: this is where a NEW finding lands while
   * its card is in flight, not a parking space.
   */
  | 'blind-carded';

/**
 * ⚠️ EMPTY IS THE HEADLINE, and it is a measurement rather than an aspiration.
 * MOTIR-2956 closed at one broken site out of twelve and armed both of its
 * tables; nothing has been blind since. An entry appearing here without one of
 * the first two dispositions in the failure message below is how this class
 * grows back.
 */
const DELIBERATELY_ORG_ONLY: Record<string, Verdict> = {};

/**
 * The MOTIR-2956 SWEEP, re-derived. One entry per `lib/` + `app/` call site of
 * `withOrgServiceWriteContext` / `bindOrganizationContext`, keyed
 * LINE-INDEPENDENTLY as `file#enclosing` exactly as the sibling guards key
 * theirs — several sites collapse onto one key on purpose (`chargeForMeteredRun`
 * binds three times), because the adjudication is of the METHOD.
 *
 * `tables` is what must carry an `app.organization_id` read arm, and `source`
 * says how it was established:
 *
 * - **`scan`** — the scanner reports exactly these, and the assertion below
 *   holds it to that. Twelve of the thirteen.
 * - **`hand`** — ⚠️ THE INSTRUMENT'S BLIND SPOT, NAMED RATHER THAN INHERITED
 *   (`notes.html` #268 / #273). The walk follows a `tx` into a REPOSITORY method
 *   or a helper it can resolve by NAME; a `tx` handed to a SERVICE method
 *   (`organizationsService.ensureOrgMembership(…, tx)`) is a property-access
 *   callee on an object the scan does not model, so it is stepped over and the
 *   site reports reaching nothing. `workspacesService#addMember` is that site,
 *   and MOTIR-2956's sweep read it by hand. Widening the walk to service objects
 *   would change the `SYSTEM_CONTEXT` axis too and is a card of its own; what is
 *   NOT acceptable is letting the sweep's twelfth verdict disappear because the
 *   machine cannot see it.
 */
const ORG_SWEEP: Record<string, { tables: string[]; source: 'scan' | 'hand'; why: string }> = {
  'lib/repositories/organizationRepository.ts#lockByIdForUpdate': {
    tables: ['organization'],
    source: 'scan',
    why:
      'THE DEFECT MOTIR-3710 FIXED, and the one entry in this sweep that is not a READ. ' +
      'The `SELECT "id" FROM "organization" … FOR UPDATE` that every §4 count cap serializes ' +
      'on matched ZERO rows from `withWorkspaceContext`: Postgres applies the UPDATE policy ' +
      'USING clause to a `FOR UPDATE`, `organization_mutate_active` reads app.organization_id, ' +
      'and that context binds user / workspace / project only — so the lock filtered out ' +
      'silently while `organization_membership_visible` kept the row READABLE. The method now ' +
      'binds the GUC itself, which is why it is a call site here at all. The arm asserted ' +
      'below is `organization_active`; the UPDATE arm the lock needs is not a SELECT policy ' +
      'and so is out of `armedTables` reach — the probe in ' +
      '`tests/entitlementsService.test.ts` is what re-measures THAT, on every run.',
  },
  'lib/services/billingPropagationService.ts#setScaledTrackerState': {
    tables: ['organization'],
    source: 'scan',
    why: 'UPDATE + RETURNING on the org row — organization_mutate_active / organization_active',
  },
  'lib/services/billingPropagationService.ts#setAiIncludedSeat': {
    tables: ['organization'],
    source: 'scan',
    why: 'UPDATE + RETURNING on the org row — the same pair',
  },
  'lib/services/billingService.ts#syncScaledTrackerSeatQuantity': {
    tables: ['organization', 'organization_membership'],
    source: 'scan',
    why: 'a `bindOrganizationContext` inside a `withSystemContext` block — organization_active / org_membership_visible_active_or_own',
  },
  'lib/services/ciActionsGateService.ts#syncForOrganization': {
    tables: ['organization'],
    source: 'scan',
    why: 'organization_active',
  },
  'lib/services/ciAllowanceService.ts#getEntitlementState': {
    tables: ['ci_period_charge', 'organization', 'organization_membership'],
    source: 'scan',
    why: 'organization_active / org_membership_visible_active_or_own / ci_period_charge_org_or_system',
  },
  'lib/services/ciAllowanceService.ts#chargeForMeteredRun': {
    tables: ['ci_period_charge', 'organization_membership'],
    source: 'scan',
    why: 'three binds in one method (the charge, the settle, the pending debit) — one adjudication',
  },
  'lib/services/ciAllowanceService.ts#settlePendingDebit': {
    tables: ['ci_period_charge'],
    source: 'scan',
    why: 'ci_period_charge_org_or_system',
  },
  'lib/services/ciMinutesMeterService.ts#isMeta': {
    tables: ['organization'],
    source: 'scan',
    why: 'organization_active',
  },
  'lib/services/ciRunnerAdmissionService.ts#resolveCaps': {
    tables: ['organization'],
    source: 'scan',
    why: 'organization_active',
  },
  'lib/services/entitlementsService.ts#tierForOrg': {
    tables: ['organization'],
    source: 'scan',
    why: 'organization_active',
  },
  'lib/services/entitlementsService.ts#assertWithinStorageCap': {
    tables: ['attachment', 'workspace'],
    source: 'scan',
    why:
      'THE DEFECT MOTIR-2956 FIXED. `sumSizeByOrganization` is FROM "attachment" JOIN ' +
      '"workspace", and BOTH needed the arm — 20260818010000_attachment_org_service_read_arm ' +
      'adds attachment_org_service_read and workspace_org_service_read, FOR SELECT, each ' +
      'guarded on app.user_id being empty so it fires only for the userless service path.',
  },
  'lib/services/organizationRepoService.ts#listInventory': {
    tables: ['github_repo'],
    source: 'scan',
    why:
      "THE SIXTEENTH (MOTIR-4680) — the organisation Git page's one read. It COMPOSES " +
      '`listRepositoryUsage` (adjudicated below, and where the `project_repository` arm is ' +
      'accounted for) and binds the org GUC once more of its own to re-read `github_repo` for ' +
      'the row fields the usage shape does not carry. github_repo_org_read (MOTIR-4677) is the ' +
      'arm. ⚠️ The INDEX-ledger half is deliberately NOT here: `job_run` is read under ' +
      '`withSystemContext`, per workspace, because the ledger is workspace-keyed and an ' +
      "organisation is not — that is the system-context guard's axis, not this one.",
  },
  'lib/services/organizationRepoService.ts#listRepositoryUsage': {
    tables: ['github_repo', 'project_repository'],
    source: 'scan',
    why:
      'THE FIFTEENTH (MOTIR-4679) — `Used by N projects`, which asks WHICH PROJECTS across the ' +
      'organisation hold each repository. Both tables answer only under an org arm: ' +
      'github_repo_org_read (MOTIR-4677) and project_repository_org_read (this card, ' +
      "20260906000000). Without the second, `project_repository`'s sole policy is " +
      '`FOR ALL USING (workspace_id = app.workspace_id)` with no system arm — so the read ' +
      'returned ZERO rows and every inventory row would have said "Used by no project yet", ' +
      'which is the MOTIR-2956 shape one table over. The PROJECT rows are read separately, ' +
      'under the system arm `project_workspace_or_system_read` already carries.',
  },
  'lib/services/organizationRepoService.ts#disconnectFromOrganisation': {
    tables: ['github_repo', 'project_repository'],
    source: 'scan',
    why:
      'TWO binds in one method — the repo lookup and the affected-links enumeration — one ' +
      'adjudication, and the same two arms as the read above. ⚠️ Only the READS are org-bound: ' +
      'the org arms are `FOR SELECT` only (permissive policies OR-combine, so widening the ' +
      'write arm would hand a sibling workspace a DELETE it never had), so the clear is one ' +
      "WORKSPACE-bound write per affected workspace. That split is the method's shape, not an " +
      'oversight.',
  },
  'lib/services/organizationRepoService.ts#inProjectOrg': {
    tables: ['github_repo'],
    source: 'hand',
    why:
      'THE FOURTEENTH (MOTIR-4678), and the walk reports NOTHING for it — the bind sits in a ' +
      'helper whose body then invokes a CALLBACK PARAMETER, so the scan sees only the ' +
      '`resolveOrganizationId -> workspaceRepository.findByIdInTx` that runs BEFORE the bind ' +
      'and steps over every statement that runs after it. Declaring `[]` would have recorded ' +
      'the blind spot as a verdict, so this is read by hand.\n\n' +
      'What the bound transaction touches: `github_repo` (listByOrganization — the org-spanning ' +
      'inventory this whole card exists for; findById / findByRepoIdAndProvider on the write ' +
      'paths), `project_repository` (listByProject, the name + claim guards, findLastPosition, ' +
      'create) and `organization_membership` (assertOrgAdmin).\n\n' +
      'ONLY `github_repo` is declared, and the reason is that `bindOrganizationContext` ADDS a ' +
      'GUC rather than replacing one: this site binds it INSIDE a `withWorkspaceContext` ' +
      'transaction, so app.user_id / app.workspace_id / app.project_id are all still set. ' +
      '`project_repository` is workspace-keyed and answers under its own arm; ' +
      '`organization_membership` answers under org_membership_visible_active_or_own, whose ' +
      'app.user_id half is bound. `github_repo` is the one read that genuinely spans the ' +
      "organisation's OTHER workspaces, and MOTIR-4677's github_repo_org_read (FOR SELECT) is " +
      'the arm that admits it — without which the picker returns a SUBSET and looks like a ' +
      'short list rather than a bug.',
  },
  'lib/services/workspacesService.ts#addMember': {
    tables: ['organization_membership'],
    source: 'hand',
    why:
      'the upward org auto-join INSERT, reached through `organizationsService.ensureOrgMembership` ' +
      '— a SERVICE call the walk cannot follow, so the scan reports no in-window model here. ' +
      'org_membership_insert_active_or_bootstrap admits the write; the read arm asserted below ' +
      'is org_membership_visible_active_or_own.',
  },
};

let rlsTables: Set<string>;
let orgArmed: Set<string>;

/**
 * The findings, given an arm set — every (site, table) pair where the table has
 * RLS, carries no arm, and nobody has adjudicated it.
 *
 * Parameterised on `armed` for the two negative proofs below, which reconstruct
 * the arm set as it stood before a migration. A guard that has never been SEEN
 * to fail is not evidence, and the cheapest honest way to see it fail is to take
 * an arm away rather than to break a call site and put it back.
 */
function findings(armed: ReadonlySet<string>): string[] {
  const { tableOf } = schemaMap();
  const out: string[] = [];
  for (const site of scanContexts(ORG_SERVICE_CONTEXT)) {
    for (const model of site.contextOnlyModels) {
      const table = tableOf.get(model);
      if (!table) {
        out.push(`${site.key} :: ${model} — no table in prisma/schema.prisma`);
        continue;
      }
      if (!rlsTables.has(table)) continue; // over-approximation; nothing to be blind to
      if (armed.has(table)) continue;
      if (DELIBERATELY_ORG_ONLY[`${site.key} :: ${model}`]) continue;
      out.push(
        `${site.key} :: ${model} -> "${table}" has RLS and NO app.organization_id read arm ` +
          `(reached via ${site.via.join(', ')})`,
      );
    }
  }
  return out;
}

// WARM THE SCANS ONCE, in a hook with its own budget — the reason every sibling
// guard gives: the compiler-API walk over `lib/` + `app/` + `tests/` is a couple
// of seconds bare, and under `vitest run --coverage` the v8 provider instruments
// it heavily enough to blow the repo's 15 s `testTimeout`, so `pnpm test` is
// green while the coverage lane is red. Both roots are warmed — the fixture tree
// is a SEPARATE cache key, on purpose, so a single unkeyed cache could never
// hand the fixture the real repo's answer.
//
// ⚠️ Do NOT "fix" a recurrence by raising `testTimeout`: that is a global knob
// and this is one expensive fixture.
beforeAll(async () => {
  scanContexts(ORG_SERVICE_CONTEXT);
  scanContexts(ORG_SERVICE_CONTEXT, 'tests/rls/__fixtures__/orgContexts');
  rlsTables = await rlsEnabledTables();
  orgArmed = await armedTables(ORG_SERVICE_CONTEXT.gucs[0]!);
}, 120_000);

afterAll(async () => {
  await adminDb.$disconnect();
});

describe('every org-context read touches a table whose policy set reads app.organization_id', () => {
  it('has no unadjudicated (site, table) pair', () => {
    expect(
      findings(orgArmed),
      'A `withOrgServiceWriteContext` / `bindOrganizationContext` block reads a table whose ' +
        'policies do not read `app.organization_id`. Under `motir_app` that read returns ZERO ' +
        'ROWS and raises NOTHING — which is how the free-tier storage cap stopped being ' +
        'enforced without one line of code looking wrong (MOTIR-2956).\n\n' +
        'The disposition is one of three, and the FIRST is nearly always right:\n' +
        '  1. BIND THE RIGHT THING — if the table is workspace-scoped, the caller wants\n' +
        '     `withWorkspaceServiceContext` / `bindWorkspaceContext`, not the org GUC.\n' +
        '     Additive, widens nothing.\n' +
        '  2. ARM THE TABLE — ONLY when the read genuinely spans the org and there is no\n' +
        '     narrower context. `FOR SELECT` only, and guard it on `app.user_id` being\n' +
        "     EMPTY (the `coalesce(current_setting(…), '') = ''` idiom) so it fires for\n" +
        '     the userless service path and NOT for `withOrgContext`, whose readers are\n' +
        '     member-scoped by design. ⚠️ ARM EVERY TABLE THE QUERY TOUCHES, joins\n' +
        '     included — arming the FROM clause alone leaves the answer at zero, which is\n' +
        '     the fix reading as applied while changing nothing.\n' +
        '  3. ADJUDICATE it here, with the measurement and the card that owns it.\n\n' +
        'Adding an entry to DELIBERATELY_ORG_ONLY without one of the first two is how this ' +
        'class grows back.',
    ).toEqual([]);
  });

  it('has no adjudication left for a pair the scan no longer reports', () => {
    // The mirror, and the half that rots silently: an entry whose site was fixed
    // or deleted keeps a permanent "this is fine" on record for a shape nobody
    // can find any more.
    const { tableOf } = schemaMap();
    const live = new Set(
      scanContexts(ORG_SERVICE_CONTEXT).flatMap((s) =>
        s.contextOnlyModels.map((m) => `${s.key} :: ${m}`),
      ),
    );
    expect(
      Object.keys(DELIBERATELY_ORG_ONLY).filter((k) => !live.has(k)),
      'a verdict for a pair the scan no longer reports — delete it',
    ).toEqual([]);
    const wrong = Object.entries(DELIBERATELY_ORG_ONLY)
      .filter(([k, v]) => v === 'no-rls' && rlsTables.has(tableOf.get(k.split(' :: ')[1]!) ?? ''))
      .map(([k]) => k);
    expect(wrong, 'adjudicated `no-rls`, but the table has RLS enabled').toEqual([]);
  });
});

describe("MOTIR-2956's twelve-row hand sweep, re-derived on every run", () => {
  const runtimeSites = () =>
    scanContexts(ORG_SERVICE_CONTEXT).filter(
      (s) => s.file.startsWith('lib/') || s.file.startsWith('app/'),
    );

  it('every runtime call site carries a verdict — a THIRTEENTH fails here', () => {
    // The ratchet the document could not be. `docs/rls-runtime-role-inventory.md`
    // recorded twelve callers read by hand on 2026-08-17; a caller added since is
    // indistinguishable from a swept one when the record is prose.
    const unswept = [...new Set(runtimeSites().map((s) => s.key))].filter((k) => !ORG_SWEEP[k]);

    expect(
      unswept,
      'A `lib/` or `app/` caller of `withOrgServiceWriteContext` / `bindOrganizationContext` ' +
        'has no entry in ORG_SWEEP.\n\n' +
        'Read the tables its statements TOUCH — joins included — against the policies on ' +
        '`origin/main`, then add the row. This is the step MOTIR-2956 performed by hand for ' +
        'twelve callers; the whole point of this guard is that the thirteenth does not get ' +
        'to skip it.',
    ).toEqual([]);
  });

  it('no swept row survives the call site it was written for', () => {
    const live = new Set(runtimeSites().map((s) => s.key));

    expect(
      Object.keys(ORG_SWEEP).filter((k) => !live.has(k)),
      'a sweep row for a call site the scan no longer reports — the method was renamed, ' +
        'moved or deleted. Delete the row (or re-key it); a verdict nobody can locate is ' +
        'the document rotting again, one file over.',
    ).toEqual([]);
  });

  it('a `scan`-sourced row declares exactly what the scanner reports', () => {
    // What bounds the hand half. Without this, any row could quietly become
    // hand-written and the sweep would drift back into transcription.
    const { tableOf } = schemaMap();
    const byKey = new Map<string, Set<string>>();
    for (const s of runtimeSites()) {
      const set = byKey.get(s.key) ?? new Set<string>();
      for (const m of s.contextOnlyModels) set.add(tableOf.get(m) ?? m);
      byKey.set(s.key, set);
    }

    const drift = Object.entries(ORG_SWEEP)
      .filter(([, v]) => v.source === 'scan')
      .flatMap(([k, v]) => {
        const actual = [...(byKey.get(k) ?? [])].sort();
        const declared = [...v.tables].sort();
        return JSON.stringify(actual) === JSON.stringify(declared)
          ? []
          : [`${k}: declared ${JSON.stringify(declared)}, scan reports ${JSON.stringify(actual)}`];
      });

    expect(
      drift,
      'A row marked `source: "scan"` declares tables the scanner does not report. Either the ' +
        'query changed (update the row) or the walk lost sight of it — and the second is the ' +
        'dangerous one, because a shrinking `tables` list reads exactly like a simplified ' +
        'query. If the walk genuinely cannot see it, mark the row `hand` and say what was ' +
        'read, so the gap is visible instead of absorbed.',
    ).toEqual([]);
  });

  it('every table in the sweep carries an org read arm — the twelve verdicts, re-checked', () => {
    // This is what the document could only assert once. Every ✓ in its table is
    // re-measured against `pg_policies` on every run, so an arm dropped by a
    // later migration turns this red rather than turning a cap off.
    const missing = Object.entries(ORG_SWEEP).flatMap(([key, v]) =>
      v.tables.filter((t) => rlsTables.has(t) && !orgArmed.has(t)).map((t) => `${key} :: "${t}"`),
    );

    expect(
      missing,
      'A table MOTIR-2956 recorded as org-armed no longer carries a permissive SELECT/ALL ' +
        'policy reading `app.organization_id`. Under `motir_app` that caller now reads zero ' +
        'rows and raises nothing.',
    ).toEqual([]);
  });
});

describe('the guard has been SEEN to fail', () => {
  // A guard that has never fired is a guard nobody has evidence for. Both proofs
  // take an ARM AWAY rather than breaking a call site, because the arm set is
  // data and the call sites are the thing under test — and because the two
  // policies below are exactly the ones MOTIR-2956 had to add, so removing them
  // reconstructs the tree as it stood at the defect.

  it('the JOIN target is adjudicated too, not just the FROM clause', async () => {
    // ⚠️ `notes.html` #269, proven rather than asserted. `sumSizeByOrganization`
    // is `FROM "attachment" JOIN "workspace"`. Keep `attachment`'s arm and take
    // `workspace`'s away — the FROM clause armed, the JOIN target not — and the
    // guard must still report the site. An arm inventory that only described the
    // FROM clause would call this healthy, which is precisely how the fix could
    // have shipped while the sum stayed at zero.
    // ⚠️ TWO policy names, not one, since MOTIR-3512. Reconstructing "the arm
    // set as it stood before that migration" means removing EVERY org arm
    // `workspace` has acquired since, and it now has two:
    // `workspace_org_service_read` (userless, MOTIR-2956) and
    // `workspace_org_member_read` (user-bound, MOTIR-3512). Excluding only the
    // first leaves the table armed and the control proves nothing — which is
    // the control working, not a reason to weaken it.
    const withoutJoinArm = await armedTables(ORG_SERVICE_CONTEXT.gucs[0]!, [
      'workspace_org_service_read',
      'workspace_org_member_read',
    ]);
    expect(withoutJoinArm.has('attachment'), 'the FROM clause is still armed').toBe(true);
    expect(withoutJoinArm.has('workspace'), 'the JOIN target is not').toBe(false);

    expect(findings(withoutJoinArm)).toEqual([
      'lib/services/entitlementsService.ts#assertWithinStorageCap :: workspace -> "workspace" ' +
        'has RLS and NO app.organization_id read arm ' +
        '(reached via attachmentRepository.sumSizeByOrganization)',
    ]);
  });

  it('a swept call site whose table loses its arm is reported', async () => {
    // The synthetic regression on a site that is NOT the known defect, so the
    // proof is about the mechanism rather than about one query.
    // `ci_period_charge_org_or_system` is the arm three `ciAllowanceService`
    // binds and one test file rely on; without it every one of them is blind.
    const withoutChargeArm = await armedTables(ORG_SERVICE_CONTEXT.gucs[0]!, [
      'ci_period_charge_org_or_system',
    ]);
    const reported = findings(withoutChargeArm).filter((f) => f.includes('ci_period_charge'));

    expect(reported.length).toBeGreaterThan(0);
    expect(
      reported.some((f) => f.startsWith('lib/services/ciAllowanceService.ts#chargeForMeteredRun')),
      'the metered-charge caller goes blind and is named',
    ).toBe(true);
  });
});

describe('the descriptor itself', () => {
  it('rules correctly on a fixture carrying every verdict', () => {
    // THE NEGATIVE CASE, as a permanent test rather than a one-off check, and run
    // against a fixture ROOT so proving the detector works can never leave a stray
    // unbound org context in a real service.
    const root = 'tests/rls/__fixtures__/orgContexts';
    const byEnclosing = new Map(
      scanContexts(ORG_SERVICE_CONTEXT, root).map((s) => [s.enclosing, s]),
    );
    const site = (fn: string) => byEnclosing.get(fn);

    // Pinned INDIVIDUALLY. One `toEqual` over the set would pass for the wrong
    // reason the day the scan returns nothing at all.
    expect(site('orgOnlyRead')?.verdict, 'a plain gated read under the org binding').toBe(
      'context-only',
    );

    // ⚠️ THE JOIN CASE — the shape an arm inventory clears and the query does not.
    expect(site('orgJoinedRead')?.contextOnlyModels, 'an `include` is a join').toEqual([
      'gadget',
      'widget',
    ]);

    expect(site('orgNonGated')?.verdict).toBe('no-gated-statement');
    expect(site('orgViaHelper')?.verdict, 'one hop into a forwarding helper').toBe('context-only');

    // ⚠️ THE `bind` ENTRY'S WINDOW, pinned from BOTH sides — the half that is new
    // in this descriptor. A `bind` binds on an already-open transaction, so its
    // window opens AT THE CALL and runs to the end of the enclosing function:
    // the read above it belongs to the enclosing context, the read below it to
    // this one. A window that opened at the top of the block would report
    // `gadget` as org-bound when the GUC was not yet set — a claim in the
    // dangerous direction, because it reads as coverage.
    expect(
      site('bindsMidBlock')?.contextOnlyModels,
      'only the read AFTER the bind is under `app.organization_id`',
    ).toEqual(['widget']);
    expect(
      site('bindsMidBlock')?.models,
      'and the read before it is still SEEN — reported, just not in the window',
    ).toEqual(['gadget', 'widget']);
    expect(site('bindsAfterEveryRead')?.verdict, 'every gated read sits above the bind').toBe(
      'narrowed',
    );
    expect(site('bindsAfterEveryRead')?.contextOnlyModels).toEqual([]);

    // A user-bound org context is a DIFFERENT descriptor, so it is not reported —
    // the boundary MOTIR-2956 drew, made structural.
    expect(
      byEnclosing.has('orgUserRead'),
      'withOrgContext binds a user too and is `ORG_USER_CONTEXT`',
    ).toBe(false);

    // THE WALL (MOTIR-2910), under a `bind` entry this time.
    expect(
      site('bindsThenUnresolved')?.unresolvedCalls,
      'a tx passed to a callback parameter must be REPORTED, not stepped over',
    ).toEqual(['resolveContext']);
  });

  it('actually finds the sites it is pointed at (a live negative)', () => {
    // A scanner that silently returns nothing passes forever. Pin that it walks
    // the real tree, resolves the schema, and classifies in more than one
    // direction. The floor is an order of magnitude below the population (31 at
    // `7de5856f`) so ordinary movement cannot reach it.
    const all = scanContexts(ORG_SERVICE_CONTEXT);
    expect(all.length).toBeGreaterThan(15);
    expect(contextOnlyReads(ORG_SERVICE_CONTEXT).length).toBeGreaterThan(10);
    expect(all.some((s) => s.verdict === 'narrowed')).toBe(true);
    // Every reported site names a real file and a real enclosing function.
    expect(all.filter((s) => s.enclosing === '<module>')).toEqual([]);
  });
});
