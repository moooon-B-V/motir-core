import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOG, type PermissionKey } from '@/lib/permissions/catalog';

// THE STORY TEST GATE for MOTIR-2256 (Subtask MOTIR-2302) — the ARCHITECTURE half.
//
// This story's characteristic failure is not an untested branch. It is a policy
// answer derived somewhere the model does not know about, and a coverage number
// is blind to that by construction: a module-private `assertCanManage` that
// re-derives the admin rule from scratch is fully covered by its own service's
// tests and still wrong. Six of them existed when this story started —
// `projectMembersService`, `componentsService`, `customFieldsService`,
// `boardsService`, `workflowsService`, `estimationService` — plus
// `workItemsService`, found by the first guard below and folded in rather than
// exempted. They agreed with `lib/permissions/resolve.ts` by coincidence, and
// nothing kept them that way.
//
// So the guards here answer three questions no coverage report can:
//   1. does anything still derive an administrative answer for itself?
//   2. is every administrative key actually WIRED, not merely marked enforced?
//   3. did the split OVER-tighten — is a read now behind a manage key?
//
// (2) and (3) plus the route→service→gate seams run against real Postgres in
// `storyGate.integration.test.ts`; this file is the pure, filesystem half.

const ROOT = join(__dirname, '..', '..');

/** The twelve administrative keys MOTIR-2256 splits out of `project:administer`. */
const ADMINISTRATIVE_KEYS: readonly PermissionKey[] = [
  'member:manage',
  'project:manage_access',
  'board:configure',
  'workflow:manage',
  'automation:manage',
  'field:manage',
  'component:manage',
  'label:manage',
  'estimation:manage',
  'repository:manage',
  'repository:manage_access',
  'ai:configure',
];

function walk(dir: string, hit: (p: string) => void): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, hit);
    else hit(p);
  }
}

/**
 * Every `.ts`/`.tsx` under `lib/` and `app/`, read ONCE at module load with its
 * comments already stripped.
 *
 * ⚠️ COMPUTED ONCE, DELIBERATELY. The first version re-read the tree and
 * re-stripped comments inside each guard's loop — 12 keys × ~1,500 files × 10 MB
 * of lazy block-comment matching — and the suite HUNG rather than failing, which is
 * the same shape `noUngovernedOperation.test.ts` records about its own shared
 * `g`-flagged regex. A guard that cannot finish is worse than one that is absent,
 * because it looks like infrastructure trouble rather than a test to fix.
 */
const SOURCES: { path: string; code: string }[] = (() => {
  const out: { path: string; code: string }[] = [];
  for (const root of ['lib', 'app']) {
    walk(join(ROOT, root), (p) => {
      if (!p.endsWith('.ts') && !p.endsWith('.tsx')) return;
      out.push({
        path: relative(ROOT, p).replace(/\\/g, '/'),
        code: stripComments(readFileSync(p, 'utf8')),
      });
    });
  }
  return out;
})();

/**
 * Strip comments so a file that DESCRIBES a policy derivation — every one of the
 * adapters this story wrote does, at length — is not mistaken for one that
 * PERFORMS it. Without this the guard fires on its own documentation, which is
 * the fastest way to get a guard deleted.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * The modules ALLOWED to derive a policy answer: the permission model itself and
 * the predicate façade over it.
 */
const POLICY_OWNERS = [
  'lib/permissions/catalog.ts',
  'lib/permissions/builtinRoles.ts',
  'lib/permissions/resolve.ts',
  'lib/projects/access.ts',
  // The two role predicates the model is BUILT FROM. They define
  // `isWorkspaceManager` / `isOwnerRole`; they do not decide anything.
  'lib/projects/roles.ts',
  'lib/workspaces/roles.ts',
];

/**
 * Known-legitimate derivations, BY NAME with a reason — never a directory glob.
 * A glob is a place to put things you would rather not think about, and it grows
 * until the guard means nothing (the same argument
 * `noUngovernedOperation.test.ts` makes about its allowlist).
 *
 * Every entry here is a domain OUTSIDE MOTIR-2256's twelve keys. When MOTIR-2291
 * wires `sprint:manage`, `report:view` and `saved_filter:manage`, its cards delete
 * these lines — which is exactly the signal this list is meant to carry, and the
 * `sprintsService` line is the first one MOTIR-2350 collected.
 */
const ALLOWED_DERIVATIONS: { file: string; why: string }[] = [
  {
    file: 'lib/savedFilters/access.ts',
    why: 'the saved-filter ROW-LEVEL tier — an owner manages their own filter, an admin any project-shared one. MOTIR-2352 wired `saved_filter:manage` beside it as the project-level question; this derivation answers the per-ROW one and stays',
  },
  {
    file: 'lib/services/jobsDashboardService.ts',
    why: 'a WORKSPACE-level jobs dashboard, gated on the workspace role. No project is resolved, so no project permission can govern it (the `repository:connect` argument, MOTIR-2294)',
  },
  {
    file: 'lib/services/projectAccessService.ts',
    why: 'the enforcement half of the model itself — it resolves the three facts and applies `lib/permissions/resolve.ts`',
  },
];

/**
 * The shapes that DERIVE an administrative answer. Deliberately narrow: each is
 * the actor's OWN membership being tested, not a target's role being read (
 * `projectMembersService`'s last-admin guard reads `existing.role === 'admin'`
 * about the PERSON BEING CHANGED, which is business logic, not a gate).
 */
const DERIVATION_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'isWorkspaceManager(...) used as a gate', re: /\bisWorkspaceManager\s*\(/ },
  { label: 'isOwnerRole(...) used as a gate', re: /\bisOwnerRole\s*\(/ },
  {
    label: "the actor's own membership compared to 'admin'",
    re: /\b(?:ws|project|workspace)?[Mm]embership\??\.role\s*===\s*'admin'/,
  },
];

/**
 * The RENDER-SIDE derivations still living in `app/(authed)/**` — a page working
 * out `canManage` / `isAdmin` to decide whether to draw an editable control.
 *
 * ⚠️ PINNED, NOT EXEMPTED, and the difference matters. These are not a second
 * SERVER policy: every one of them sits in front of a surface whose writes are
 * gated by `assertPermission`, so a page that guesses wrong shows the wrong
 * affordance and the server still refuses. That makes them a UI-consistency
 * problem rather than a security one — which is precisely why hiding what an
 * actor cannot reach is MOTIR-2258's story and not this one's.
 *
 * The list is exact, so a NEW one fails this suite, and MOTIR-2258's definition
 * of done is that it reaches zero. An exception list would have let the set grow
 * quietly; a pin makes it a worklist.
 */
const UI_AFFORDANCE_DERIVATIONS = [
  'app/(authed)/items/[key]/page.tsx',
  'app/(authed)/settings/project/board/page.tsx',
  'app/(authed)/settings/project/components/page.tsx',
  'app/(authed)/settings/project/estimation/page.tsx',
  'app/(authed)/settings/project/fields/page.tsx',
  'app/(authed)/settings/project/members/page.tsx',
  'app/(authed)/settings/project/workflow/page.tsx',
  // Workspace-level, so no project permission could govern it either way — the
  // same argument MOTIR-2294 made about `repository:connect`.
  'app/(authed)/settings/workspace/jobs/page.tsx',
];

function derivations(): { path: string; label: string }[] {
  const allowed = new Set([...POLICY_OWNERS, ...ALLOWED_DERIVATIONS.map((a) => a.file)]);
  const found: { path: string; label: string }[] = [];
  for (const { path, code } of SOURCES) {
    if (allowed.has(path)) continue;
    for (const { label, re } of DERIVATION_PATTERNS) {
      if (re.test(code)) found.push({ path, label });
    }
  }
  return found;
}

describe('guard 1 — nothing derives an administrative answer for itself', () => {
  it('NO SERVER-side policy derivation survives outside the model', () => {
    // The hard tier. A second implementation of the policy under `lib/` is the
    // failure this story exists to end — six of them were deleted here, and the
    // seventh (`workItemsService`) was found by this very assertion.
    const offenders = derivations()
      .filter((d) => d.path.startsWith('lib/'))
      .map((d) => `${d.path} — ${d.label}`);
    expect(
      offenders,
      'a file under lib/ outside lib/permissions/** and lib/projects/access.ts derives an ' +
        'administrative answer for itself. Route it through ' +
        'projectAccessService.assertPermission, or add it to ALLOWED_DERIVATIONS by NAME with a ' +
        'reason — never a directory glob.',
    ).toEqual([]);
  });

  it('the RENDER-side derivations are exactly the pinned set — MOTIR-2258 empties it', () => {
    const found = [
      ...new Set(
        derivations()
          .filter((d) => d.path.startsWith('app/'))
          .map((d) => d.path),
      ),
    ].sort();
    expect(
      found,
      'a page derives an administrative answer to decide what to DRAW. That is not a second ' +
        'server policy (the writes are gated either way), but it is the drift that makes the UI ' +
        'and the server disagree — MOTIR-2258 owns removing them. Adding one is a regression; ' +
        'removing one means updating UI_AFFORDANCE_DERIVATIONS in the same change.',
    ).toEqual([...UI_AFFORDANCE_DERIVATIONS].sort());
  });

  it('every named exception still EXISTS and still derives — a stale allowance is a lie', () => {
    // An exception whose file was deleted or already fixed makes the list read as
    // "we looked and decided", when nobody has looked since. It must fail.
    for (const { file } of ALLOWED_DERIVATIONS) {
      const code = stripComments(readFileSync(join(ROOT, file), 'utf8'));
      const derives = DERIVATION_PATTERNS.some((p) => p.re.test(code));
      expect(derives, `${file} no longer derives a policy answer — delete its exception`).toBe(
        true,
      );
    }
  });

  it('THE GUARD CAN ACTUALLY FAIL — a synthetic derivation is caught, and prose is not', () => {
    // Positive control: the real shape, in code.
    const offending = `
      const m = await workspaceMembershipRepository.findByUserAndWorkspace(userId, workspaceId);
      if (!isOwnerRole(m?.role)) throw new SomeForbiddenError();
    `;
    expect(DERIVATION_PATTERNS.some((p) => p.re.test(stripComments(offending)))).toBe(true);

    // Negative control 1: the SAME words inside a comment. Every adapter this
    // story wrote documents the gate it replaced, so a guard that fires on prose
    // fires on its own evidence and gets deleted.
    const documented = `
      /**
       * Until this card the body resolved isOwnerRole(membership?.role) — the
       * workspace OWNER, and nobody else.
       */
      await projectAccessService.assertPermission(projectId, ctx, 'board:configure');
    `;
    expect(DERIVATION_PATTERNS.some((p) => p.re.test(stripComments(documented)))).toBe(false);

    // Negative control 2: reading the TARGET's role is business logic, not a gate
    // (the last-admin guard in projectMembersService).
    const lastAdminGuard = `if (existing.role === 'admin' && role !== 'admin') { … }`;
    expect(DERIVATION_PATTERNS.some((p) => p.re.test(stripComments(lastAdminGuard)))).toBe(false);
  });
});

describe('guard 2 — every administrative key is ENFORCED and actually WIRED', () => {
  it('marks all twelve `enforcement: enforced`', () => {
    for (const key of ADMINISTRATIVE_KEYS) {
      expect(PERMISSION_CATALOG[key].enforcement, `${key} is still planned`).toBe('enforced');
    }
  });

  it('finds each of the twelve as a LITERAL in a gate call outside tests/', () => {
    // The orphan guard at full strength for this story's keys: a card can mark a
    // key enforced and forget to wire it, and nothing else would notice — the
    // catalog would advertise a permission no gate consults, which is exactly the
    // lie `lib/permissions/catalog.ts`'s opening rule forbids.
    const sources = SOURCES.filter(
      (f) => !f.path.startsWith('lib/permissions/') && !f.path.includes('/dto/'),
    );
    const unwired: string[] = [];
    for (const key of ADMINISTRATIVE_KEYS) {
      // A plain substring test, not a regex: the key is a fixed string, and the
      // shape that matters is that some non-model file NAMES it.
      const wired = sources.some((f) => f.code.includes(`'${key}'`));
      if (!wired) unwired.push(key);
    }
    expect(
      unwired,
      'these keys are marked `enforced` but appear in no gate call — either wire them or mark ' +
        'them `planned` again',
    ).toEqual([]);
  });

  it('THE GUARD CAN ACTUALLY FAIL — a key nothing consults is reported', () => {
    // A key from MOTIR-2291's eight that is justified by the inventory and
    // deliberately unwired. It is the honest negative control, and when a card
    // wires it this assertion flips and asks to be updated — which is exactly
    // what happened: the control was `import:run` until MOTIR-2353 wired it and
    // `work_item:delete` until MOTIR-2354 did, each time moving on rather than
    // being deleted. MOTIR-2356 retires it for good.
    // ⚠️ ONLY `ai:plan` IS LEFT, and it is a control of a different kind: its
    // operations ARE wired (MOTIR-2355 / -2357 / -2358), and the FLAG is what
    // MOTIR-2359 and then MOTIR-2356 still owe. So the assertion inverts — the
    // key is consulted and still `planned`, which is exactly the seam that lets
    // naming and wiring land separately. MOTIR-2356 retires this control with the
    // arm it belongs to.
    const wired = SOURCES.filter((f) => !f.path.startsWith('lib/permissions/')).some((f) =>
      f.code.includes("'ai:plan'"),
    );
    expect(wired, 'ai:plan should be consulted by the cards that wired it').toBe(true);
    expect(PERMISSION_CATALOG['ai:plan'].enforcement).toBe('planned');
  });
});

describe('the story leaves exactly MOTIR-2291 behind', () => {
  it('every remaining `planned` key is one of the eight member-facing ones', () => {
    const stillPlanned = Object.values(PERMISSION_CATALOG)
      .filter((d) => d.enforcement === 'planned')
      .map((d) => d.key)
      .sort();
    // The eight MOTIR-2291 keys, MINUS the ones its own cards have since wired.
    // Each wiring card deletes its key from this list in the same change, so the
    // array is the story's remaining worklist and MOTIR-2356 empties it.
    expect(stillPlanned).toEqual(
      [
        // 'work_item:delete' — wired by MOTIR-2354.
        // 'work_item:triage' — wired by MOTIR-2354.
        // 'sprint:manage' — wired by MOTIR-2350.
        // 'report:view' — wired by MOTIR-2351.
        // 'saved_filter:manage' — wired by MOTIR-2352.
        // 'import:run' — wired by MOTIR-2353.
        'ai:plan',
        // 'ai:view_plan' — wired by MOTIR-2363.
      ].sort(),
    );
  });
});

/**
 * The service METHODS that can now raise `PermissionDeniedError` — those whose
 * body calls `assertPermission`, directly or through a module-local helper in the
 * same file (the adapters MOTIR-2296/2297/2298 kept for readability).
 *
 * The same-file hop is the one MOTIR-2304 taught the ungoverned-operation walk;
 * without it `boardsService.addColumn` looks unreachable because its gate sits
 * behind `assertBoardConfigAdmin`.
 */
function raisingMethods(): Set<string> {
  const dir = join(ROOT, 'lib', 'services');
  const raising = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const svc = file.slice(0, -3);
    const src = readFileSync(join(dir, file), 'utf8');

    const locals = new Map<string, string>();
    const localRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/gm;
    for (let m = localRe.exec(src); m !== null; m = localRe.exec(src)) {
      const body = bodyAfterSignature(src, m.index + m[0].length);
      if (body) locals.set(m[1]!, body);
    }

    const methodRe = /^ {2}(?:async\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/gm;
    for (let m = methodRe.exec(src); m !== null; m = methodRe.exec(src)) {
      const name = m[1]!;
      if (['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) continue;
      const body = bodyAfterSignature(src, m.index + m[0].length);
      if (!body) continue;
      let hit = body.includes('assertPermission(');
      if (!hit) {
        for (const [localName, localBody] of locals) {
          if (
            new RegExp(`(?<![.\\w$])${localName}\\s*\\(`).test(body) &&
            localBody.includes('assertPermission(')
          ) {
            hit = true;
            break;
          }
        }
      }
      if (hit) raising.add(`${svc}.${name}`);
    }
  }
  return raising;
}

/** A method/function body, given the offset just past its signature's opening paren. */
function bodyAfterSignature(src: string, afterOpenParen: number): string | null {
  let depth = 1;
  let i = afterOpenParen;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') depth -= 1;
  }
  if (depth > 0) return null;
  const open = src.indexOf('{', i);
  if (open < 0) return null;
  let braces = 0;
  let j = open;
  for (; j < src.length; j++) {
    if (src[j] === '{') braces += 1;
    else if (src[j] === '}' && --braces === 0) break;
  }
  return src.slice(open, j + 1);
}

/** Whether a route file, or a `@/lib/**` module it imports, knows the error. */
function mapsPermissionDenied(src: string): boolean {
  if (src.includes('PermissionDeniedError')) return true;
  const importRe = /from '(@\/lib\/[^']+)'/g;
  for (let m = importRe.exec(src); m !== null; m = importRe.exec(src)) {
    const mod = join(ROOT, `${m[1]!.replace('@/', '')}.ts`);
    try {
      if (readFileSync(mod, 'utf8').includes('PermissionDeniedError')) return true;
    } catch {
      // a directory import or a .tsx module — not an error mapper
    }
  }
  return false;
}

describe('guard 3 — every route that can RAISE the new refusal can also MAP it', () => {
  it('finds no route reaching an assertPermission method without a PermissionDeniedError arm', () => {
    // ⚠️ THIS GUARD EXISTS BECAUSE THE GAP IT CHECKS SHIPPED. The domain cards
    // re-pointed nine services to `assertPermission`, which raises a NEW error
    // class — and six error mappers still knew only `NotProjectAdminError`, so
    // the refusal fell through to a **500** instead of a 403. Every service test
    // stayed green, because they exercise the SERVICE; only the route knows the
    // mapper. CI found it across `epic6-journey` (Vitest + E2E), the components
    // routes and the estimation route.
    //
    // Method-precise on purpose. At SERVICE granularity this flags five read
    // paths — `workflowsService.getWorkflow`, `estimationService.rollupForSprint`
    // and friends — that never reach a gate, and a guard with five standing false
    // positives is a guard that gets deleted.
    const raising = raisingMethods();
    expect(
      raising.size,
      'no service appears to call assertPermission — the walk is broken',
    ).toBeGreaterThan(10);

    const offenders: string[] = [];
    let reached = 0;
    walk(join(ROOT, 'app', 'api'), (p) => {
      if (!p.endsWith(`${'route'}.ts`)) return;
      const src = readFileSync(p, 'utf8');
      const called = new Set(
        [...src.matchAll(/\b([a-z][A-Za-z0-9]*Service)\.([A-Za-z_]\w*)\s*\(/g)].map(
          (m) => `${m[1]}.${m[2]}`,
        ),
      );
      const hits = [...called].filter((k) => raising.has(k));
      if (hits.length === 0) return;
      reached += 1;
      if (!mapsPermissionDenied(src)) {
        offenders.push(`${relative(ROOT, p).replace(/\\/g, '/')} — reaches ${hits.join(', ')}`);
      }
    });

    expect(reached, 'no route reaches a gated method — the walk is broken').toBeGreaterThan(10);
    expect(
      offenders,
      'these routes can receive a PermissionDeniedError and have no arm for it, so the refusal ' +
        'becomes a 500 instead of a 403. Add the error to the route or to the mapper it imports.',
    ).toEqual([]);
  });
});
