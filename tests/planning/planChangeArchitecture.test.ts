import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

// Story-7.30 ARCHITECTURE + CONTRACT guards (MOTIR-1732) — the half of the
// story-level gate a coverage number cannot see. Coverage says every line ran;
// it says nothing about a client component that reached past the HTTP boundary,
// a route that grew a transaction, or a removal that left a key nothing renders.
// Each guard below is a STANDING invariant, asserted by reading the source the
// way a reviewer would — the `render-single-source` / `i18n-catalog` pattern.

const ROOT = process.cwd();

const planEditsEn = (en as unknown as Record<string, Record<string, string>>)['planEdits']!;
const planEditsZh = (zh as unknown as Record<string, Record<string, string>>)['planEdits']!;
const planningWorkspaceEn = (en as unknown as Record<string, Record<string, unknown>>)[
  'planningWorkspace'
]!;
const planningWorkspaceZh = (zh as unknown as Record<string, Record<string, unknown>>)[
  'planningWorkspace'
]!;

/** Every leaf key path in a catalog subtree, sorted — nesting-aware parity. */
function keyPaths(node: unknown, prefix = ''): string[] {
  if (node === null || typeof node !== 'object') return [prefix];
  return Object.entries(node as Record<string, unknown>)
    .flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k))
    .sort();
}

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SOURCE_FILES = ['app', 'components', 'lib'].flatMap((d) => collectSourceFiles(join(ROOT, d)));

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/** A repo-relative file with its comments stripped — for guards that assert the
 *  ABSENCE of something the file legitimately still discusses in prose. */
function codeOf(rel: string): string {
  return read(join(ROOT, rel))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/[^\n]*$/gm, '');
}

function isClientModule(text: string): boolean {
  // The directive must be the module's FIRST statement, so a mention further
  // down — inside a comment, a string, or this very file — is not one.
  //
  // Scanned rather than matched: the obvious regex for "skip leading whitespace
  // and comments" puts an ambiguous alternation under a `*`
  // (`(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*`), which a source file made of many
  // `*//*` repetitions can force into exponential backtracking — a real ReDoS
  // CodeQL flags (js/redos). This walk is linear and never backtracks.
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
    } else if (text.startsWith('//', i)) {
      const newline = text.indexOf('\n', i + 2);
      if (newline === -1) return false;
      i = newline + 1;
    } else if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) return false;
      i = close + 2;
    } else {
      // The first thing that is neither whitespace nor a comment decides it.
      return text.startsWith("'use client'", i) || text.startsWith('"use client"', i);
    }
  }
  return false;
}

// ─────────── Guard 1 — no client component reaches the service layer ───────────

describe('the client/server boundary holds', () => {
  it("no 'use client' module imports a service, a repository, or the Prisma singleton", () => {
    // The conversation rail, the canvas and the host are client islands; every
    // read/write they make is an HTTP hop to a route (`planChangeClient`). An
    // import of `@/lib/services/*` from a client module compiles and even runs
    // during SSR — then fails in the browser, or worse, bundles the DB client
    // and the tenant scoping into the page. Repo-wide, because the invariant is
    // not this story's alone.
    const offenders = SOURCE_FILES.filter((file) => {
      const text = read(file);
      if (!isClientModule(text)) return false;
      return /from '@\/lib\/(services|repositories)\/|from '@\/lib\/db'/.test(text);
    }).map((f) => relative(ROOT, f));

    expect(offenders).toEqual([]);
  });

  it('the story’s own client modules talk to the routes, not to the service', () => {
    // Named explicitly so the guard above cannot pass by accident if one of
    // these ever stops being a client module.
    const storyClientModules = [
      'components/planning/PlanningWorkspaceHost.tsx',
      'components/planning/PlanChangeRail.tsx',
      'components/planning/PlanChangeCanvas.tsx',
      'components/planning/PlanChangeConfirmBar.tsx',
      'lib/hooks/usePlanChangeConversation.ts',
      // The `@`-mention target picker (MOTIR-1491) joins the same island: its
      // search is the shipped mention-search ROUTE, never the service behind it.
      'components/planning/PlanChangeComposer.tsx',
      'components/planning/TargetSearchListbox.tsx',
      'components/planning/PlanningTargetChip.tsx',
      'components/planning/PlanningTargetNode.tsx',
      'lib/hooks/useWorkItemTargetSearch.ts',
    ];

    for (const rel of storyClientModules) {
      const text = read(join(ROOT, rel));
      expect(isClientModule(text), `${rel} is a client module`).toBe(true);
      expect(text, `${rel} must not import the service layer`).not.toMatch(
        /from '@\/lib\/(services|repositories)\/|from '@\/lib\/db'/,
      );
    }

    // …and the one module that IS allowed to speak HTTP names the shipped
    // endpoints, so the seam test's URLs are the product's URLs.
    const client = read(join(ROOT, 'lib/planning/planChangeClient.ts'));
    expect(client).toContain('/api/ai/plan-change/session');
    expect(client).toContain('/api/ai/plan-change/session/turns');
    expect(client).toContain('/api/ai/plan-change/session/submit');
    // A TARGETED turn (MOTIR-1491) rides the shipped contextual route — the
    // picker added no endpoint of its own.
    expect(client).toContain('/ai/plan');
  });
});

// ─────── Guard 1b — the conversation confirms the PLAN, through ONE gate ───────

describe('the plan-change conversation reviews and confirms the PLAN (MOTIR-1746)', () => {
  // The whole defect: every plan-edit handler in motir-ai returns
  // `planDelta: { operations: [] }` and writes its output as PlanItem proposals
  // instead, so a surface that reads the delta can only ever show "nothing was
  // proposed" — while the proposals sit in the Plan unread. These are STANDING
  // invariants, not one-off assertions: a future edit that reaches back for the
  // delta re-opens exactly that bug, silently.
  const CONVERSATION_MODULES = [
    'lib/hooks/usePlanChangeConversation.ts',
    'components/planning/PlanningWorkspaceHost.tsx',
    'components/planning/PlanChangeRail.tsx',
    'components/planning/PlanChangeCanvas.tsx',
    'components/planning/PlanChangeConfirmBar.tsx',
    'components/planning/planChangeLevel.tsx',
    'components/planning/PlanChangeDiffNode.tsx',
    'lib/planning/planChangeDiff.ts',
    // The OTHER two entrances, moved off the same dead delta by MOTIR-1747: the
    // item-scoped expand/replan dock and the `/ready` expansion nudge.
    'lib/hooks/usePlanEditsJob.ts',
    'components/planning/PlanEditsReviewDock.tsx',
    'app/(authed)/ready/_components/ExpansionNudgeBanner.tsx',
    'app/(authed)/ready/_components/ExpansionNudgeReview.tsx',
  ];

  it.each(CONVERSATION_MODULES)('%s reads no planDelta and calls no delta approve', (rel) => {
    const text = read(join(ROOT, rel));
    // A prose mention in the header comment is the RECORD of why; an import or a
    // call is the regression. So match code, not commentary.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');
    expect(code, `${rel} must not read the job's planDelta`).not.toMatch(/planDelta/);
    expect(code, `${rel} must not call the delta approve`).not.toMatch(
      /approvePlanDelta|plan-delta\/approve/,
    );
  });

  it('every AI-planning entrance confirms through the SAME client', () => {
    // FOUR entrances (the rail, the item-scoped dock, the `/ready` nudge and
    // `/plans/[id]`), ONE gate: all go through `planReviewClient` →
    // `POST /api/plans/[id]/approve` → `materialize`. A second write path is how
    // the same proposal lands twice.
    for (const rel of [
      'lib/hooks/usePlanChangeConversation.ts',
      'lib/hooks/usePlanEditsJob.ts',
      'app/(authed)/ready/_components/ExpansionNudgeBanner.tsx',
      'components/planning/PlanDetail.tsx',
    ]) {
      expect(read(join(ROOT, rel)), rel).toMatch(/from '@\/lib\/planning\/planReviewClient'/);
    }
    const client = read(join(ROOT, 'lib/planning/planReviewClient.ts'));
    expect(client).toContain('/approve');
    expect(client).toContain('/decline');
  });

  it('EXACTLY ONE proposal→tree write path survives, repo-wide (MOTIR-1747)', () => {
    // The bug this closes: two independent paths turned proposals into work
    // items — `approvePlan` → `materialize` (live) and `approveDelta` (dead,
    // because every planner returns an empty delta). The dead one is gone, and
    // this asserts it stays gone WITHOUT naming the files that used to hold it:
    // a scan of the whole app/components/lib tree, so a reintroduction anywhere
    // fails here.
    const offenders = SOURCE_FILES.filter((file) => {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');
      return /planDelta|approvePlanDelta|plan-delta\/approve|approveDelta/.test(code);
    }).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);

    // The route, the service method, the client helper and the shape gate are
    // deleted — not merely unreferenced.
    for (const gone of [
      'app/api/ai/plan-delta/approve/route.ts',
      'lib/ai/planDelta.ts',
      'lib/ai/planDeltaGate.ts',
    ]) {
      expect(existsSync(join(ROOT, gone)), `${gone} must not exist`).toBe(false);
    }

    // …and no OTHER endpoint persists proposals: the only route that materializes
    // a plan is the plans approve route the four entrances share.
    const approveRoutes = SOURCE_FILES.filter((file) => {
      if (!relative(ROOT, file).startsWith(`app${sep}api`)) return false;
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/[^\n]*$/gm, '');
      return /plansService\.approvePlan\(|materializePlan\(/.test(code);
    }).map((f) => relative(ROOT, f));
    expect(approveRoutes).toEqual([join('app', 'api', 'plans', '[id]', 'approve', 'route.ts')]);
  });
});

// ─────────── Guard 2 — the story's routes stay a thin HTTP layer ───────────

describe('the story’s routes are HTTP-only (4-layer)', () => {
  const STORY_ROUTES = [
    'app/api/ai/plan-change/session/route.ts',
    'app/api/ai/plan-change/session/turns/route.ts',
    'app/api/ai/plan-change/session/submit/route.ts',
    // The BOUNDARY MAILBOX's two doors (Story MOTIR-4054 · MOTIR-4067) — the
    // INGEST a session posts a mid-run turn to, and the READ DOOR motir-ai
    // consumes at a phase boundary. Listed here rather than left implicit: the
    // read door WRITES (it stamps what it returns as consumed), which is exactly
    // the shape most likely to grow a `$transaction` in the route.
    'app/api/ai/plan-change/session/mailbox/route.ts',
    'app/api/internal/ai/plan-change-mailbox/route.ts',
  ];

  it.each(STORY_ROUTES)('%s calls no db.* and opens no $transaction', (rel) => {
    const text = read(join(ROOT, rel));
    expect(text).not.toMatch(/from '@\/lib\/db'/);
    expect(text).not.toMatch(/\bdb\.[a-zA-Z]/);
    expect(text).not.toMatch(/\$transaction/);
    // Prisma is a repository-only import.
    expect(text).not.toMatch(/from '@prisma\/client'/);
  });

  it('the workspace’s own server read goes through a service, never Prisma', () => {
    // ⚠️ RE-POINTED (MOTIR-4732). This read `app/(planning)/planning/page.tsx`,
    // the route host, which is deleted — the workspace is an OVERLAY, a client
    // island, and a client island may not reach a service at all. So the one
    // server read it makes is an HTTP door (MOTIR-4727), and the 4-layer
    // invariant lands there instead: a route handler may call services, and what
    // it may not do is skip them.
    // Comment-stripped, like every other guard in this file: the handler's own
    // header states the rule it follows, and prose describing a trap must not
    // trip the trap's test.
    const text = codeOf('app/api/work-items/planning-anchor/route.ts');
    expect(text).toMatch(/from '@\/lib\/services\//);
    expect(text).not.toMatch(/from '@\/lib\/db'/);
    expect(text).not.toMatch(/\$transaction/);
  });

  it('the transaction lives in the SERVICE, and every repository write requires a tx', () => {
    const service = read(join(ROOT, 'lib/services/planChangeSessionsService.ts'));
    expect(service).toMatch(/withWorkspaceContext/);
    // Same for the mailbox's service (MOTIR-4067): the `seq` allocation is
    // read-derived, so its transaction and its row lock live here or nowhere.
    const mailbox = read(join(ROOT, 'lib/services/planChangeMailboxService.ts'));
    expect(mailbox).toMatch(/withWorkspaceContext/);
    expect(mailbox).toMatch(/lockById/);

    for (const rel of [
      'lib/repositories/planChangeSessionRepository.ts',
      'lib/repositories/planChangeTurnRepository.ts',
      'lib/repositories/planChangeMailboxRepository.ts',
    ]) {
      const repo = read(join(ROOT, rel));
      // No optional `tx?` on a write — the compile-time guarantee the 4-layer
      // rule buys. (Reads legitimately take `tx?`.)
      expect(repo, `${rel} must not own a transaction`).not.toMatch(/\$transaction/);
      for (const method of ['create', 'update']) {
        const signature = new RegExp(`async ${method}\\([\\s\\S]*?\\): Promise`);
        const match = signature.exec(repo);
        if (!match) continue;
        expect(match[0], `${rel}#${method} must REQUIRE a tx`).toMatch(
          /tx: Prisma\.TransactionClient/,
        );
      }
    }
  });
});

// ────── Guard 2b — the workspace OPENS before its data arrives (MOTIR-2069) ──────

describe('the workspace is not hostage to the roadmap read', () => {
  it('the overlay shows the workspace SKELETON while it waits', () => {
    // ⚠️ RE-POINTED (MOTIR-4732). The route had `app/(planning)/loading.tsx` for
    // exactly one reason: without a boundary, Next held the NAVIGATION on the
    // previous route until the page's slowest await settled — the whole "loads
    // first, then opens" defect. An overlay has no navigation to hold, so the
    // boundary is gone with the group and the SHAPE it showed is not: the
    // overlay renders the same skeleton inside the dialog while a work-item
    // launch resolves its anchor.
    const overlay = read(join(ROOT, 'components/planning/PlanningWorkspaceOverlay.tsx'));
    expect(overlay).toMatch(/PlanningWorkspaceSkeleton/);
    expect(existsSync(join(ROOT, 'app/(planning)'))).toBe(false);
  });

  it('the overlay reads NO roadmap data — the blocking, duplicate read stays gone', () => {
    // Both files keep a prose RECORD of the defect in their header comments, so
    // these read CODE only — the same comment-stripping the delta guards use.
    const overlay = codeOf('components/planning/PlanningWorkspaceOverlay.tsx');
    // The exact shape that caused the bug: the root level read inline to
    // pre-compute `hasItems`. The canvas reads that same level itself, so
    // whatever mounts it must not read it at all.
    expect(overlay).not.toMatch(/getProjectRoadmap/);
    expect(overlay).not.toMatch(/fetchRoadmapLevel/);
    expect(overlay).not.toMatch(/hasItems/);
  });

  it('the canvas owns the loading and empty states the page used to pre-decide', () => {
    const host = read(join(ROOT, 'components/planning/PlanningWorkspaceHost.tsx'));
    // Mounted unconditionally — no `hasItems ? canvas : empty` branch to revive.
    expect(host).toMatch(/loadingFallback=\{<PlanningCanvasSkeleton \/>\}/);
    expect(host).toMatch(/emptyRoot=\{/);

    // …and the canvas honours both, with the shipped behaviour as the default so
    // the other four consumers of the reusable canvas are untouched.
    const canvas = read(join(ROOT, 'components/planning/ProjectRoadmapCanvas.tsx'));
    expect(canvas).toMatch(/loadingFallback \?\? <Spinner/);
    expect(canvas).toMatch(/!drilled && emptyRoot/);
    expect(read(join(ROOT, 'components/planning/PlanChangeCanvas.tsx'))).toMatch(
      /loadingFallback=\{loadingFallback\}/,
    );
  });

  it('the ACCESS gate still resolves BEFORE the workspace renders', () => {
    // The other half of the invariant, and it SURVIVED the move (MOTIR-4732): a
    // `no-access` actor must never be shown a workspace frame for a project they
    // cannot browse, and a null-marker project must still forward. What changed
    // is where the inputs come from — the shell's session and its permission
    // provider, both resolved above this component — so the assertion is that
    // the gate is consulted and its arms are honoured before the host mounts.
    const overlay = read(join(ROOT, 'components/planning/PlanningWorkspaceOverlay.tsx'));
    const gateAt = overlay.indexOf('resolvePlanningHostGate({');
    expect(gateAt).toBeGreaterThan(-1);
    // Both arms are honoured, and the host is mounted only past them.
    expect(overlay).toMatch(/gate === 'no-access'/);
    expect(overlay).toMatch(/gate === 'onboarding'/);
    expect(overlay.indexOf('<PlanningWorkspaceHost')).toBeGreaterThan(gateAt);
    const beforeGate = overlay.slice(0, gateAt);
    // The provider is read ABOVE the gate — that is the ordering half.
    expect(beforeGate).toMatch(/useProjectAccess\(\)/);
    // An awaited ACCESS read before the gate — whichever capability reader it is.
    // MOTIR-2250 moved this to `getSettingsCapabilities`, a superset over the SAME
    // `resolveInputs` round-trip, so the audit-coverage banner's `canManage` gate
    // costs no EXTRA read on this page's critical path. The invariant this guards
    // is "the access read resolves before anything renders", not the method name —
    // but it stays pinned to the reader so a future edit cannot drop it — and
    // the gate's browse input is named by the PERMISSION its own server check
    // asserts, not by a rank.
    expect(overlay).toMatch(/canBrowse: can\('project:browse'\)/);
    // ⚠️ And it must remain exactly ONE access read. On the route this meant one
    // awaited `projectAccessService` round-trip; in the overlay it is stronger
    // and free — the shell resolved the whole permission set once, for every
    // affordance on the page, and this component reads it out of context. So
    // there is no access QUERY on this path at all, which is what it now says.
    expect(overlay).not.toMatch(/projectAccessService/);
    expect((overlay.match(/= useProjectAccess\(\)/g) ?? []).length).toBe(1);
    // …and the redirect for a never-onboarded project is still on this path.
    //
    // ⚠️ MATCHED ON THE CONSTANT, NOT ON THE LITERAL (MOTIR-4403). This read
    // `/redirect\('\/onboarding'\)/` until the onboarding entrance got one
    // owner: the entrance is now `ONBOARDING_ENTRY_PATH`, imported from
    // `lib/navigation/landing.ts`, and `tests/navigation/landing-owner-guard.
    // test.ts` FAILS on a re-typed `'/onboarding'` anywhere under `app/`. So the
    // old pattern asserted the presence of the exact string a sibling guard now
    // forbids — two guards that cannot both be satisfied. The invariant this one
    // is about is unchanged and is what it still checks: the never-onboarded
    // redirect is on this path, above the render.
    // ⚠️ AND IT IS A `router.push` NOW, NOT A `redirect` (MOTIR-4732). The route
    // was a Server Component; the overlay is a client island, and a client
    // forwards by pushing. The invariant is the same one and is what is checked:
    // a never-onboarded project leaves for onboarding rather than being shown a
    // workspace, and the destination is the OWNED constant rather than a
    // re-typed literal.
    expect(overlay).toMatch(/router\.push\(ONBOARDING_ENTRY_PATH\)/);
    expect(overlay).toMatch(
      /import \{ ONBOARDING_ENTRY_PATH \} from '@\/lib\/navigation\/landing'/,
    );
  });

  it('the host takes no roadmap data at all', () => {
    // The prop whose await held the paint. Its absence is the invariant: a host
    // that cannot be handed roadmap data cannot be blocked waiting for it.
    expect(codeOf('components/planning/PlanningWorkspaceHost.tsx')).not.toMatch(/hasItems/);
  });

  it('the skeleton is presentational only — no strings to translate, no client JS', () => {
    const skeleton = read(join(ROOT, 'components/planning/PlanningWorkspaceSkeleton.tsx'));
    expect(isClientModule(skeleton)).toBe(false);
    expect(skeleton).not.toMatch(/useTranslations|\bt\(/);
    // It composes the REAL frame rather than redrawing one, so the two cannot
    // drift apart.
    expect(skeleton).toMatch(/from '@\/components\/planning\/PlanningWorkspace'/);
    // Colour through --el-* fills only; no invented colour, no raw Tailwind palette.
    expect(skeleton).not.toMatch(/bg-(gray|slate|zinc|neutral|stone)-\d/);
  });
});

// ─────────── Guard 3 — MOTIR-1731's removal left nothing dangling ───────────

describe('retiring “Augment from prompt” left no dangling key or import', () => {
  const RETIRED_KEYS = ['augmentPromptLabel', 'augmentPromptPlaceholder', 'augmentPromptSubmit'];

  it.each(RETIRED_KEYS)('planEdits.%s is gone from BOTH catalogs', (key) => {
    // Removing it from en.json only would pass the catalog PARITY gate in the
    // wrong direction on the next add; removing it from neither leaves a string
    // translators keep maintaining for a door that no longer exists.
    expect(planEditsEn).not.toHaveProperty(key);
    expect(planEditsZh).not.toHaveProperty(key);
  });

  it('no source file still asks for a retired key', () => {
    const offenders = SOURCE_FILES.filter((file) => {
      const text = read(file);
      return RETIRED_KEYS.some((key) => text.includes(key));
    }).map((f) => relative(ROOT, f));

    expect(offenders).toEqual([]);
  });

  it('the removed component is gone and nothing imports it', () => {
    const offenders = SOURCE_FILES.filter((file) => /AugmentPromptButton/.test(read(file))).map(
      (f) => relative(ROOT, f),
    );
    // The only surviving mention is the NOTE recording why the door was retired
    // — a breadcrumb, not an import. It sat in `PlanEditsLauncher.tsx` until
    // MOTIR-4258 deleted that file with the ⋯ menu that mounted it, and moved to
    // `WorkItemPlanEntrance` — the door that REPLACED both retired ones, and so
    // the file a reader asking "why is there only one?" actually opens. The
    // assertion is pinned to exactly one carrier on purpose: a breadcrumb in two
    // places is a breadcrumb that can rot in one of them.
    const carrier = join('components', 'planning', 'WorkItemPlanEntrance.tsx');
    expect(offenders).toEqual([carrier]);

    const entrance = read(join(ROOT, carrier));
    expect(entrance).not.toMatch(/^import[^\n]*AugmentPromptButton/m);
    expect(entrance).not.toMatch(/<AugmentPromptButton/);
  });

  it('the surfaces it was mounted on no longer reference it', () => {
    for (const rel of [
      join('app', '(authed)', 'backlog', 'page.tsx'),
      join('app', '(authed)', 'items', '_components', 'IssueListToolbar.tsx'),
    ]) {
      expect(read(join(ROOT, rel)), rel).not.toMatch(/AugmentPrompt/);
    }
  });

  it('the augment JOB path is UNTOUCHED — only the door was retired', () => {
    // The conversation submits to exactly this endpoint. If the removal had
    // swept the route too, the whole story would be dead and every seam test
    // above would be asserting a stub.
    const routes = SOURCE_FILES.filter((f) =>
      relative(ROOT, f).startsWith(join('app', 'api', 'ai', 'augment')),
    );
    expect(routes.length).toBeGreaterThan(0);
    expect(read(join(ROOT, 'lib/services/aiPlanEditsService.ts'))).toMatch(/submitAugment/);
  });
});

// ─────────── Guard 4 — the story's i18n additions are catalog-complete ───────────

describe('the story’s new copy exists in every locale', () => {
  it('planningWorkspace exists in en AND zh with the same key set', () => {
    // The i18n-catalog test proves whole-file parity; this states the story's
    // OWN namespace so a future removal can't pass parity by deleting both
    // halves of a key the UI still renders. `planningWorkspace` is the one
    // namespace this story added (MOTIR-1729); the conversation's copy
    // (MOTIR-1730) extends the existing `planEdits` namespace.
    expect(planningWorkspaceEn).toBeDefined();
    expect(planningWorkspaceZh).toBeDefined();
    expect(keyPaths(planningWorkspaceZh)).toEqual(keyPaths(planningWorkspaceEn));
    expect(keyPaths(planningWorkspaceEn).length).toBeGreaterThan(0);
  });

  it('the rail’s conversation copy matches key-for-key across locales, nesting included', () => {
    // `planningWorkspace.conversation` is a NESTED subtree (turn labels, the
    // composer, the confirm bar's plural forms, the starters, the progress
    // narration). Whole-file parity is proven elsewhere; this walks the story's
    // own subtree so a zh block that lost a nested group cannot pass.
    const enConv = (planningWorkspaceEn as Record<string, unknown>)['conversation'];
    const zhConv = (planningWorkspaceZh as Record<string, unknown>)['conversation'];
    expect(enConv).toBeDefined();
    expect(keyPaths(enConv)).toEqual(keyPaths(zhConv));
    expect(keyPaths(enConv).length).toBeGreaterThan(10);
    for (const required of ['opener', 'turn', 'turnRefine', 'submitted', 'starters.addWork']) {
      expect(keyPaths(enConv)).toContain(required);
    }
  });

  it('every planningWorkspace key the OVERLAY names actually resolves', () => {
    // ⚠️ RE-POINTED (MOTIR-4732): the page that named these keys is deleted, and
    // the overlay is what names them now.
    const page = read(join(ROOT, 'components/planning/PlanningWorkspaceOverlay.tsx'));
    const ns = (en as unknown as Record<string, Record<string, string>>)['planningWorkspace']!;
    const used = [...page.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    for (const key of used) expect(ns, `planningWorkspace.${key}`).toHaveProperty(key);
  });
});

// A guard on the guards: the scan must actually be looking at files.
describe('the source scan is not vacuous', () => {
  it('walked the app, components and lib trees', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(200);
    expect(SOURCE_FILES.some((f) => f.endsWith(`planning${sep}launcher.ts`))).toBe(true);
  });

  it('classifies client modules correctly — a false-everywhere scanner would pass guard 1 vacuously', () => {
    expect(isClientModule("'use client';\nexport const a = 1;\n")).toBe(true);
    expect(isClientModule('"use client";\n')).toBe(true);
    expect(isClientModule("// a leading comment\n\n'use client';\n")).toBe(true);
    expect(isClientModule("/* block */ 'use client';\n")).toBe(true);
    expect(isClientModule("/* one */\n// two\n/* three */\n'use client';\n")).toBe(true);

    // A mention that is NOT the first statement — the false positives the walk
    // exists to reject (this very file contains one).
    expect(isClientModule("import x from 'y';\n'use client';\n")).toBe(false);
    expect(isClientModule("// mentions 'use client' in prose\nexport const a = 1;\n")).toBe(false);
    expect(isClientModule('const s = "\'use client\'";\n')).toBe(false);
    expect(isClientModule('')).toBe(false);
    expect(isClientModule('   \n\n')).toBe(false);
    // Unterminated comments: bail rather than loop or mis-read past them.
    expect(isClientModule("/* never closed\n'use client';")).toBe(false);
    expect(isClientModule('// no trailing newline')).toBe(false);
  });

  it('classifies in linear time on the input that made the old regex backtrack', () => {
    // The js/redos repro: many `*//*` repetitions with no directive after them.
    // Exponential backtracking would hang here; the walk returns immediately.
    const adversarial = `/*${'*//*'.repeat(2000)}`;
    const started = process.hrtime.bigint();
    expect(isClientModule(adversarial)).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(1000);
  });
});
