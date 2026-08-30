import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  apiAuthFiles,
  callsGate,
  declaringFiles,
  SESSION_DOORS as DOORS,
  stripComments,
  ungatedApiFiles,
  walkSources as walk,
} from '../helpers/twoFactorGuardSweeps';

// Story MOTIR-1215 · Subtask MOTIR-3653 — the API half of 2FA enforcement, and
// the file that keeps route N+1 from quietly reopening the hole.
//
// ⚠️ THE THING THIS TEST EXISTS FOR: `app/api/**` authenticates through THREE
// helpers, not one, and only the first is greppable from a route's own source.
//
//   · `getSession()`          — personal / session-scoped routes
//   · `getWorkspaceContext()` — every tenant-scoped route; calls `getSession`
//                               INSIDE `lib/workspaces/index.ts`
//   · `getActiveProject()`    — every active-project route; calls
//                               `getWorkspaceContext`, which calls `getSession`
//
// An enumeration by `getSession` alone finds 86 files, looks complete, and
// leaves ~160 open — work items, projects, plans, sprints, boards, reports,
// dashboards, notifications, triage, the whole AI surface. That is not a corner
// of the API; it is most of it. So the enumeration below reads ALL THREE doors,
// and it is MEASURED from the filesystem rather than remembered.

const ROOT = process.cwd();
const API = join(ROOT, 'app', 'api');

/**
 * The files under `app/api/**` that read a session and do NOT gate — each with
 * the one-line reason it is safe.
 *
 * ⚠️ ASSERTED TIGHT IN BOTH DIRECTIONS, so it cannot rot into a mute button: an
 * unlisted ungated file fails, a listed file that has STARTED gating fails, and
 * a listed file that no longer reads a session fails. The list only shrinks.
 */
const EXEMPT: { file: string; why: string }[] = [
  {
    file: 'app/api/account/two-factor/status/route.ts',
    why: 'THE DEADLOCK. This is a route the escape hatch is made of — the Security pane reads its own posture through it — so gating it would refuse the person the one screen that can make them compliant. Reads and returns only the caller’s own 2FA state; it is not a scoped resource.',
  },
  {
    file: 'app/api/account/two-factor/backup-codes/route.ts',
    why: 'THE DEADLOCK, same reason — recovery codes are part of completing enrolment, and a held member must be able to finish.',
  },
  {
    file: 'app/api/account/two-factor/trusted-devices/route.ts',
    why: 'THE DEADLOCK, same reason — the trusted-device list is rendered by the same pane and cleared from it.',
  },
  {
    file: 'app/api/public/p/[identifier]/route.ts',
    why: 'The public project SUBJECT (MOTIR-3945) — anonymous-tolerant for the same reason as the four list reads beside it: an anonymous reader is the point of a public project page, and the session is read only to personalise (member visibility, `canManage`), never to authorise.',
  },
  {
    file: 'app/api/public/p/[identifier]/items/route.ts',
    why: 'Genuinely tolerates `session === null` (`session?.user.id ?? null`): an ANONYMOUS reader is the point of a public project page, and the session is read only to personalise, never to authorise.',
  },
  {
    file: 'app/api/public/p/[identifier]/tree/route.ts',
    why: 'Anonymous-tolerant public project surface, same shape.',
  },
  {
    file: 'app/api/public/p/[identifier]/roadmap/route.ts',
    why: 'Anonymous-tolerant public project surface, same shape.',
  },
  {
    file: 'app/api/public/p/[identifier]/changelog/route.ts',
    why: 'Anonymous-tolerant public project surface, same shape.',
  },
  {
    file: 'app/api/public/p/[identifier]/follow/route.ts',
    why: 'Anonymous-tolerant: a signed-out reader may follow a public project by email, so the session only names the actor when there is one.',
  },
  {
    file: 'app/api/public/p/[identifier]/subscribe/route.ts',
    why: 'Anonymous-tolerant, same shape as follow.',
  },
  {
    file: 'app/api/internal/ai/dev/noop/route.ts',
    why: 'SERVICE-authenticated, not cookie-authenticated: `app/api/internal/**` is called by motir-ai over a shared secret and there is no browser session to hold. This one reads a session only to label a dev fixture.',
  },
  {
    file: 'app/api/%5Ftest/_helpers.ts',
    why: 'Not a route and not shipped: the `_test` door is compiled out of a production build, and it is test scaffolding rather than a product surface.',
  },
];

/** Source with comments stripped — a mention in prose is not a call. */
const code = (abs: string): string => stripComments(readFileSync(abs, 'utf8'));

/**
 * Every file under `app/api/**` that AUTHENTICATES — either by reading one of
 * the three doors itself, or by calling a gate entry point that reads one for
 * it. The sweep lives in `tests/helpers/twoFactorGuardSweeps.ts`, taking the
 * directory as a parameter, so this guard can be WATCHED FAILING over a
 * synthetic tree (`tests/integration/twoFactorEnforcementStoryGate.test.ts`).
 */
const AUTHENTICATING = apiAuthFiles(ROOT, API);

describe('every session-reading route under app/api is gated or exempt with a reason', () => {
  it('⚠️ no ungated route — the guard the card exists for', () => {
    const ungated = ungatedApiFiles(ROOT, API, new Set(EXEMPT.map((e) => e.file))).map(
      (f) =>
        `${f.rel} — reads a session ${f.reads}× and does not gate. Use requireCompliantSession / requireCompliantWorkspaceContext, or refuseIfNonCompliant after this route's own refusal, or add it to EXEMPT with a reason.`,
    );

    expect(ungated).toEqual([]);
  });

  it('the enumeration is not vacuous — it finds the whole API, not a corner of it', () => {
    // A walk that silently found nothing would make the assertion above pass
    // with the hole wide open, which is the failure mode a guard test is least
    // able to notice about itself. Measured at the commit that landed this card:
    //
    //   199 authenticating files — 188 gated, 11 exempt
    //   298 gate call sites
    //    95 direct door reads left in route source (the exempt files, plus the
    //       routes that keep their own refusal and call `refuseIfNonCompliant`)
    //
    // The floors sit below those and are meant to catch a broken walk or a
    // renamed door, not to pin the exact counts — a new route should not have to
    // edit this test.
    expect(AUTHENTICATING.length).toBeGreaterThan(150);
    expect(AUTHENTICATING.filter((f) => f.gated).length).toBeGreaterThan(150);
    expect(AUTHENTICATING.reduce((n, f) => n + f.reads, 0)).toBeGreaterThan(60);
  });

  it('⚠️ it reads ALL THREE doors, not just getSession', () => {
    // The bug this whole card nearly shipped with: gating only the `getSession`
    // routes and calling the API closed. Each door must be represented in the
    // gated set by real files.
    for (const door of DOORS) {
      const viaDoor = walk(API).filter((abs) => {
        const src = code(abs);
        return src.includes(`await ${door}()`) && callsGate(src);
      });
      expect(viaDoor.length, `${door} — no gated file reads this door`).toBeGreaterThan(0);
    }
  });

  it('an EXEMPT entry that has started gating is stale, and fails', () => {
    for (const { file } of EXEMPT) {
      const found = AUTHENTICATING.find((f) => f.rel === file);
      expect(found, `${file} no longer reads a session — remove it from EXEMPT`).toBeTruthy();
      expect(found!.gated, `${file} now gates — remove it from EXEMPT`).toBe(false);
    }
  });

  it('every EXEMPT entry carries a real reason, not a placeholder', () => {
    for (const { file, why } of EXEMPT) {
      expect(why.length, file).toBeGreaterThan(40);
      expect(why, file).not.toMatch(/^(todo|tbd|n\/a|see above)/i);
    }
  });

  it('⚠️ the three enrolment routes are exempt, and the reason names the DEADLOCK', () => {
    // The load-bearing half of the exemption. Gate these and a held member can
    // never become compliant — the hold becomes permanent, which is worse than
    // no hold at all.
    for (const route of ['status', 'backup-codes', 'trusted-devices']) {
      const entry = EXEMPT.find((e) => e.file === `app/api/account/two-factor/${route}/route.ts`);
      expect(entry, route).toBeTruthy();
      expect(entry!.why, route).toMatch(/deadlock/i);
    }
  });
});

describe('⚠️ NO ROUTE GATES TWICE', () => {
  it('a folded route does not ALSO call the compliance half', () => {
    // The defect this catches was mine, and it was invisible in every test: the
    // session sweep folded a route's preamble into `requireCompliantSession`,
    // and the active-project sweep then inserted `refuseIfNonCompliant` below
    // it. 47 files, 57 sites. Both resolve the SAME person — `getActiveProject`
    // reaches `getSession` through `getWorkspaceContext`, so `ctx.userId` IS
    // `session.user.id` — so the second call costs a policy query per request on
    // the hot path and its `if (hold) return hold;` can never be true. A
    // permanently-false branch is also how `app/api/ai/ask/route.ts` fell under
    // its pinned 90% branch threshold, which is the only reason it was noticed.
    const doubled = walk(API)
      .map((abs) => ({ rel: relative(ROOT, abs).split(sep).join('/'), src: code(abs) }))
      .filter(
        (f) =>
          (f.src.includes('requireCompliantSession(') ||
            f.src.includes('requireCompliantWorkspaceContext(')) &&
          f.src.includes('refuseIfNonCompliant('),
      )
      .map(
        (f) =>
          `${f.rel} — the folded gate already refused this person; drop the refuseIfNonCompliant call`,
      );

    expect(doubled).toEqual([]);
  });

  it('every `refuseIfNonCompliant` call site keeps its OWN no-session arm', () => {
    // The other direction: the compliance half exists for a route whose
    // no-session answer is not the folded 401 — so a file calling it must still
    // read a door itself. One that reads none has lost its authentication.
    const orphaned = walk(API)
      .map((abs) => ({ rel: relative(ROOT, abs).split(sep).join('/'), src: code(abs) }))
      .filter((f) => f.src.includes('refuseIfNonCompliant('))
      .filter((f) => !DOORS.some((door) => f.src.includes(`await ${door}()`)))
      .map((f) => f.rel);

    expect(orphaned).toEqual([]);
  });
});

describe('⚠️ app/api/auth/** needs no exemption — it reads no session at all', () => {
  it("Better-Auth's own handler is structurally out of reach", () => {
    // It OWNS every enrolment ceremony (`/api/auth/two-factor/*`,
    // `/api/auth/passkey/*`), so gating it would deadlock enrolment one layer
    // below the three routes above. It never calls any of the three doors — it
    // IS the session authority — so it cannot appear in the enumeration, and
    // this test says that is measured rather than assumed.
    const authFiles = walk(join(API, 'auth'));
    expect(authFiles.length).toBeGreaterThan(0);
    for (const abs of authFiles) {
      const src = code(abs);
      for (const door of DOORS) {
        expect(src, relative(ROOT, abs)).not.toContain(`await ${door}()`);
      }
    }
  });
});

describe('ONE verdict, one predicate — there is no second implementation', () => {
  const libFiles = walk(join(ROOT, 'lib'));
  const declaring = (needle: string): string[] => declaringFiles(join(ROOT, 'lib'), ROOT, needle);

  it('`hasSecondFactor` — the compliance predicate — is declared once', () => {
    expect(declaring('hasSecondFactor')).toEqual(['lib/twoFactor/hasSecondFactor.ts']);
  });

  it('`resolveTwoFactorHold` — the API verdict — is declared once', () => {
    expect(declaring('resolveTwoFactorHold')).toEqual(['lib/auth/requireCompliantSession.ts']);
  });

  it("`requireCompliantWorkspaceContext` — the second door's gate — is declared once", () => {
    expect(declaring('requireCompliantWorkspaceContext')).toEqual([
      'lib/auth/requireCompliantSession.ts',
    ]);
  });

  it('every gate entry point routes through it rather than re-deciding', () => {
    // `resolveRequirement` is the service call that answers the question. Only
    // the ONE module holding the verdict may call it on the API side; a route
    // calling it directly would be a second implementation with its own drift.
    const callers = walk(ROOT === API ? ROOT : join(ROOT, 'app'))
      .concat(libFiles)
      .filter((abs) => code(abs).includes('resolveRequirement('))
      .map((abs) => relative(ROOT, abs).split(sep).join('/'))
      .sort();

    expect(callers).toEqual([
      // The page gate (MOTIR-3648) and the API gate (MOTIR-3653) — the two
      // halves of enforcement, and the forced-enrolment screen, which must
      // re-ask because it is the page the gate redirects TO.
      'app/(auth)/two-factor-required/page.tsx',
      'lib/auth/requireCompliantSession.ts',
      'lib/auth/twoFactorGate.ts',
      'lib/services/twoFactorPolicyService.ts',
    ]);
  });
});

describe('⚠️ the PAT surface is structurally out of scope', () => {
  it('app/api/v1/** never reads a browser session, so the gate cannot reach it', () => {
    // The scope decision, held in place by measurement. A PAT belongs to a
    // script or a CI job that cannot present a second factor, so holding it
    // would break every integration the day an admin turns the policy on. The
    // v1 family authenticates by bearer token through `authenticateApiToken`
    // and calls none of the three doors — which is what makes "unaffected" a
    // property of the tree rather than a promise. The end-to-end half is in
    // `tests/api/twoFactorApiRefusal.test.ts`.
    const v1 = walk(join(API, 'v1'));
    expect(v1.length).toBeGreaterThan(20);
    for (const abs of v1) {
      const src = code(abs);
      for (const door of DOORS) {
        expect(src, relative(ROOT, abs)).not.toContain(`await ${door}()`);
      }
    }
  });
});
