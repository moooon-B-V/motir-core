import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declaringFiles, stripComments, ungatedRouteGroups } from '../helpers/twoFactorGuardSweeps';

// Story MOTIR-1215 · Subtask MOTIR-3648 — the gate is ONE helper with a call
// site per signed-in route group, and copies of the same three lines are how one
// route group quietly stays open.
//
// ⚠️ THERE WERE FOUR UNTIL MOTIR-4732; there are THREE. `app/(planning)` was
// retired when the planning workspace became an overlay mounted inside
// `app/(authed)`, so it inherits that group's gate instead of running its own —
// which is why the enumeration below is measured from the filesystem and only
// the named list had to move.
//
// So the set is MEASURED rather than remembered: enumerate the route-group
// layouts under `app/` from the filesystem and fail when one neither calls
// `assertTwoFactorCompliance` nor appears below with a reason. A new signed-in
// route group added without the gate turns the suite red on the day it lands,
// not on the day somebody audits the family.

const ROOT = process.cwd();
const APP = join(ROOT, 'app');
const HELPER = 'assertTwoFactorCompliance';

/** Source with comments stripped — a mention in prose is not a call. */
const code = (rel: string): string => stripComments(readFileSync(join(ROOT, rel), 'utf8'));

/**
 * The groups that do NOT gate, each with the reason.
 *
 * ⚠️ ASSERTED TIGHT IN BOTH DIRECTIONS below, so this cannot rot into a mute
 * button: an unlisted ungated group fails, and a listed group that HAS started
 * gating fails too.
 */
const EXEMPT: { group: string; why: string }[] = [
  {
    group: '(auth)',
    why: 'Serves people who are NOT signed in — and it must stay exempt for a second reason: the forced-enrolment screen this gate redirects TO lives in this group, so gating it would make the redirect target redirect to itself. The screen carries its own three gates instead (anonymous → /sign-in, compliant → their destination, otherwise render).',
  },
  {
    group: '(public)',
    why: 'Anonymous by design — public project pages, /explore, the changelog and its feeds. There is no session to hold, and holding one would gate a surface a signed-out reader sees anyway. It also has NO group layout at all, so there is no choke point to gate even if it wanted one; the entry is here to say that is correct rather than an omission.',
  },
];

/** A group's layout source, or `null` when the group has none (`(public)`). */
function layoutSource(group: string): string | null {
  const rel = `app/${group}/layout.tsx`;
  try {
    statSync(join(ROOT, rel));
  } catch {
    return null;
  }
  return code(rel);
}

describe('the 2FA enforcement gate covers every signed-in route group', () => {
  it('every route-group layout either CALLS the helper or is exempt with a reason', () => {
    // ⚠️ The SWEEP lives in `tests/helpers/twoFactorGuardSweeps.ts`, taking the
    // app directory as a parameter, so this guard can be WATCHED FAILING over a
    // synthetic tree — `tests/integration/twoFactorEnforcementStoryGate.test.ts`
    // builds one with an ungated group in it. The exemption list, its reasons
    // and the both-directions assertions stay here.
    const ungated = ungatedRouteGroups(APP, new Set(EXEMPT.map((e) => e.group))).map(
      (group) =>
        `app/${group}/layout.tsx — call ${HELPER}(userId) after the session read, or add it to EXEMPT`,
    );

    expect(ungated).toEqual([]);
  });

  it('the three signed-in groups call it, named individually', () => {
    // The enumeration above cannot tell "all three gate" from "there are no
    // groups"; this is the positive statement of the same fact.
    for (const group of ['(authed)', '(onboarding)', '(admin)']) {
      expect(code(`app/${group}/layout.tsx`), group).toContain(HELPER);
    }
  });

  it('⚠️ the PLANNING surface did not lose its gate when its group did (MOTIR-4732)', () => {
    // Dropping `(planning)` from the list above would be a quiet loss of
    // coverage if the surface had simply gone ungated. It did not: the workspace
    // is an overlay mounted by `app/(authed)/layout.tsx`, and the one path left
    // at `/planning` is a forward that lives INSIDE that group. Both halves are
    // asserted, because either one alone is satisfiable by a mistake — a deleted
    // group with no replacement page, or a page that reappears outside the gate.
    expect(layoutSource('(planning)')).toBeNull();
    expect(statSync(join(ROOT, 'app/(authed)/planning/page.tsx')).isFile()).toBe(true);
    expect(code('app/(authed)/layout.tsx')).toContain(HELPER);
  });

  it('an EXEMPT entry that has started gating is a stale exemption, and fails', () => {
    // Tight the other way, so the list only ever shrinks. A group with no layout
    // has nothing to read and nothing to have started doing.
    for (const { group } of EXEMPT) {
      const src = layoutSource(group);
      if (src === null) continue;
      expect(src, `${group} now calls the helper — remove it from EXEMPT`).not.toContain(HELPER);
    }
  });

  it('(public) genuinely has no group layout — the exemption is not hiding one', () => {
    // If it ever gains one, that layout becomes a choke point and this test
    // fails, which is the moment to decide whether it gates.
    expect(layoutSource('(public)')).toBeNull();
  });

  it('⚠️ (auth) is exempt, and the reason names the redirect LOOP it prevents', () => {
    // The load-bearing half of that exemption: the screen the gate redirects to
    // lives in this group. Gating it would send a held visitor to a page that
    // holds them again.
    const auth = EXEMPT.find((e) => e.group === '(auth)');
    expect(auth).toBeTruthy();
    expect(auth!.why).toMatch(/redirect target/i);
  });

  it('the helper is declared in exactly ONE module', () => {
    expect(declaringFiles(join(ROOT, 'lib'), ROOT, HELPER)).toEqual(['lib/auth/twoFactorGate.ts']);
  });
});

describe('⚠️ the gate runs AFTER the session read and never as a fifth sequential trip', () => {
  it('(authed) — the call sits inside the existing Promise.all wave', () => {
    // MOTIR-3433's wave is a documented performance fix, and this gate runs on
    // every signed-in page load in the product. An `await` on its own line above
    // the wave would add a fifth round trip to every one of them.
    const src = code('app/(authed)/layout.tsx');
    const session = src.indexOf('await getSession()');
    const wave = src.indexOf('await Promise.all([');
    const call = src.indexOf(`${HELPER}(session.user.id)`);

    expect(session).toBeGreaterThan(-1);
    expect(wave).toBeGreaterThan(session);
    // Inside the wave, not before it.
    expect(call).toBeGreaterThan(wave);
    expect(call).toBeLessThan(src.indexOf('])', wave));
    // …and NOT awaited on its own line.
    expect(src).not.toMatch(new RegExp(`await ${HELPER}\\(`));
  });

  it('(onboarding) — after the session read, before children render', () => {
    for (const group of ['(onboarding)']) {
      const src = code(`app/${group}/layout.tsx`);
      const session = src.indexOf('await getSession()');
      const call = src.indexOf(`await ${HELPER}(`);
      const render = src.indexOf('return children');
      expect(call, group).toBeGreaterThan(session);
      expect(render, group).toBeGreaterThan(call);
    }
  });

  it('(admin) — after the staff gate, before the audit write', () => {
    // Platform staff are NOT exempt: this console reaches every tenant's data,
    // so it is the last place a second factor should be optional.
    const src = code('app/(admin)/layout.tsx');
    const staff = src.indexOf('await requirePlatformStaff()');
    const call = src.indexOf(`await ${HELPER}(`);
    const audit = src.indexOf('platformAuditService.record');
    expect(call).toBeGreaterThan(staff);
    expect(audit).toBeGreaterThan(call);
  });
});
