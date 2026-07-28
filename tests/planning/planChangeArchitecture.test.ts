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
  ];

  it.each(STORY_ROUTES)('%s calls no db.* and opens no $transaction', (rel) => {
    const text = read(join(ROOT, rel));
    expect(text).not.toMatch(/from '@\/lib\/db'/);
    expect(text).not.toMatch(/\bdb\.[a-zA-Z]/);
    expect(text).not.toMatch(/\$transaction/);
    // Prisma is a repository-only import.
    expect(text).not.toMatch(/from '@prisma\/client'/);
  });

  it('the /planning host page reads through services, never Prisma', () => {
    // A Server Component may call services (that IS the 4-layer shape); what it
    // may not do is skip them.
    const text = read(join(ROOT, 'app/(planning)/planning/page.tsx'));
    expect(text).toMatch(/from '@\/lib\/services\//);
    expect(text).not.toMatch(/from '@\/lib\/db'/);
    expect(text).not.toMatch(/\$transaction/);
  });

  it('the transaction lives in the SERVICE, and every repository write requires a tx', () => {
    const service = read(join(ROOT, 'lib/services/planChangeSessionsService.ts'));
    expect(service).toMatch(/withWorkspaceContext/);

    for (const rel of [
      'lib/repositories/planChangeSessionRepository.ts',
      'lib/repositories/planChangeTurnRepository.ts',
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
    // The only surviving mention is the NOTE in the launcher recording why the
    // door was retired — a breadcrumb, not an import.
    expect(offenders).toEqual([join('components', 'planning', 'PlanEditsLauncher.tsx')]);

    const launcher = read(join(ROOT, 'components/planning/PlanEditsLauncher.tsx'));
    expect(launcher).not.toMatch(/^import[^\n]*AugmentPromptButton/m);
    expect(launcher).not.toMatch(/<AugmentPromptButton/);
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

  it('every planningWorkspace key the host page names actually resolves', () => {
    const page = read(join(ROOT, 'app/(planning)/planning/page.tsx'));
    const ns = (en as unknown as Record<string, Record<string, string>>)['planningWorkspace']!;
    const used = [...page.matchAll(/\bt\('([^']+)'\)/g)].map((m) => m[1]!);
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
