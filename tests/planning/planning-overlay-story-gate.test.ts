import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  OVERLAY_PARAM_NAMES,
  parsePlanningOverlay,
  withPlanningOverlay,
  withoutPlanningOverlay,
  resolvePlanningMode,
  type PlanningLaunchContext,
} from '@/lib/planning/launcher';
import { planningForwardTarget } from '@/app/(authed)/planning/page';

// STORY MOTIR-4725's GATE (MOTIR-4733) — the seams BETWEEN this story's cards,
// and the guarantees a coverage percentage cannot see.
//
// Every code card shipped its own units against a fixture its own author wrote.
// That is the expected normal, and it is exactly why this file exists: a fixture
// test proves a door writes an address of the shape its author imagined, never
// that the OVERLAY parses that address; it proves the anchor route answers, never
// that the overlay's seeds come out of the real answer.
//
// Split in two on purpose. What needs a DATABASE — the anchor route driven into
// the overlay's own seed composition — lives with the story's other real-Postgres
// seams in `tests/integration/planning/planChangeSeams.test.ts`. What is pure —
// the address round trip, the forward, and the contract guards — is here, so it
// runs in milliseconds and fails loudly.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source with comments stripped — a guard reads what a file DOES, and prose
 *  describing a trap must never trip the trap's own test. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/** Every launch context a shipped door can produce. */
const DOOR_CONTEXTS: PlanningLaunchContext[] = [
  { kind: 'project' },
  { kind: 'project', hasPlan: true },
  { kind: 'project', hasPlan: false },
  { kind: 'roadmap' },
  { kind: 'work-item', itemKey: 'MOTIR-12' },
  { kind: 'work-item', itemKey: 'MOTIR-12', hasPlan: true },
  { kind: 'convention-refine', repoKey: 'motir-core' },
];

/** Every host address a door can sit on, including the two that carry a query
 *  the overlay must not disturb. */
const HOST_ADDRESSES = [
  '/backlog',
  '/backlog?filter=type%3Acode&sort=rank',
  '/roadmap?item=MOTIR-12',
  '/items?peek=MOTIR-12',
  '/items/MOTIR-9#comments',
  '/boards',
  '/home',
];

// ───────── Seam 1 — door → address → overlay, every context × every host ─────────

describe('seam · what a DOOR writes is what the OVERLAY reads', () => {
  it.each(DOOR_CONTEXTS)('round-trips %j from every host page', (context) => {
    for (const host of HOST_ADDRESSES) {
      const address = withPlanningOverlay(host, context);
      const launch = parsePlanningOverlay(new URL(address, 'https://x').searchParams);

      expect(launch, `${host} → ${address}`).not.toBeNull();
      expect(launch!.mode).toBe(resolvePlanningMode(context));
      expect(launch!.from).toBe(context.kind);
      expect(launch!.itemKey).toBe(context.kind === 'work-item' ? context.itemKey : null);
      expect(launch!.repoKey).toBe(context.kind === 'convention-refine' ? context.repoKey : null);
    }
  });

  it.each(HOST_ADDRESSES)('leaves %s byte-identical after Close', (host) => {
    for (const context of DOOR_CONTEXTS) {
      expect(withoutPlanningOverlay(withPlanningOverlay(host, context))).toBe(host);
    }
  });

  it('opens nothing on a host address the overlay is not in', () => {
    // The shell's mount predicate. `/items?peek=` and `/roadmap?item=` are host
    // state, not launches — the whole reason the names are namespaced.
    for (const host of HOST_ADDRESSES) {
      expect(parsePlanningOverlay(new URL(host, 'https://x').searchParams)).toBeNull();
    }
  });
});

// ───────── Seam 2 — an OLD address → the forward → the overlay ─────────

describe('seam · an old /planning link still means what it meant', () => {
  const LEGACY = [
    { q: { mode: 'project', from: 'project' }, path: '/roadmap', mode: 'project' },
    { q: { mode: 'replan', from: 'project' }, path: '/roadmap', mode: 'replan' },
    { q: { mode: 'roadmap', from: 'roadmap' }, path: '/roadmap', mode: 'roadmap' },
    {
      q: { mode: 'contextual', from: 'work-item', item: 'MOTIR-12' },
      path: '/items/MOTIR-12',
      mode: 'contextual',
      itemKey: 'MOTIR-12',
    },
    {
      q: { mode: 'replan', from: 'work-item', item: 'MOTIR-12' },
      path: '/items/MOTIR-12',
      mode: 'replan',
      itemKey: 'MOTIR-12',
    },
    {
      q: { mode: 'contextual', from: 'convention-refine', repo: 'motir-core' },
      path: '/code-health',
      mode: 'contextual',
      repoKey: 'motir-core',
    },
    // A bare `/planning`, which the route accepted and defaulted.
    { q: {}, path: '/roadmap', mode: 'project' },
  ] as const;

  it.each(LEGACY)('forwards %j onto the host page it belonged to', (row) => {
    const url = new URL(planningForwardTarget(row.q), 'https://x');

    expect(url.pathname).toBe(row.path);
    const launch = parsePlanningOverlay(url.searchParams);
    expect(launch).not.toBeNull();
    expect(launch!.mode).toBe(row.mode);
    expect(launch!.itemKey).toBe('itemKey' in row ? row.itemKey : null);
    expect(launch!.repoKey).toBe('repoKey' in row ? row.repoKey : null);
  });

  it('does not let a hand-edited OLD address smuggle a target through', () => {
    // The anti-smuggling rule survives the migration in both directions: the
    // legacy parse drops the payload its origin does not own, and the overlay
    // writer never emits it.
    const url = new URL(
      planningForwardTarget({ mode: 'roadmap', from: 'roadmap', item: 'MOTIR-1' }),
      'https://x',
    );
    expect(parsePlanningOverlay(url.searchParams)!.itemKey).toBeNull();
  });

  it('percent-encodes an item key rather than pasting it into the path', () => {
    const url = new URL(
      planningForwardTarget({ mode: 'contextual', from: 'work-item', item: 'a b&c' }),
      'https://x',
    );
    expect(url.pathname).toBe('/items/a%20b%26c');
    expect(parsePlanningOverlay(url.searchParams)!.itemKey).toBe('a b&c');
  });
});

// ───────── Guards — the guarantees a percentage cannot see ─────────

const DOOR_FILES = [
  'components/planning/PlanWithAILauncher.tsx',
  'components/planning/WorkItemPlanEntrance.tsx',
  'components/planning/AiCalloutMenu.tsx',
  'app/(authed)/_components/AppCommandPalette.tsx',
];

describe('guard · no door navigates to open the workspace', () => {
  it.each(DOOR_FILES)('%s writes the address, it does not route to it', (rel) => {
    const src = code(rel);
    // Every door resolves through the ONE opener.
    expect(src, `${rel} must resolve through useOpenPlanningWorkspace`).toMatch(
      /useOpenPlanningWorkspace|aiCalloutActions/,
    );

    // ⚠️ THE RULE IS ABOUT THE OPENER'S OWN VALUES, NOT ABOUT A SPELLING. The
    // first draft of this guard looked for `router.push(…withPlanningOverlay…)`
    // and PASSED when the break was written the way a person would actually
    // write it — `onClick={() => router.push(href)}`, with `href` from the hook.
    // (Found by breaking it on purpose, which is the whole reason that step is
    // in the card.) So the check is on the two names the hook hands out: neither
    // may reach a server navigation.
    if (rel.endsWith('AppCommandPalette.tsx')) {
      // The palette is the one door that legitimately routes: it reaches a dozen
      // real destinations through `go()`. So the rule for it is named on the
      // planning ACTION — which must reach the opener, never `go`.
      const at = src.indexOf("id: 'plan-with-ai'");
      expect(at, 'the plan-with-ai action must exist').toBeGreaterThan(-1);
      const action = src.slice(at, src.indexOf('});', at));
      expect(action, 'the ⌘K action must open in place').toMatch(/openPlanningWorkspace\(\)/);
      expect(action, 'the ⌘K action must not navigate').not.toMatch(/\bgo\(|router\.push/);
      // …and it closes the palette FIRST, so focus return lands on its trigger.
      expect(action.indexOf('setOpen(false)')).toBeLessThan(
        action.indexOf('openPlanningWorkspace'),
      );
      return;
    }

    // The three DOOR COMPONENTS carry no router at all: they are links with a
    // click handler, and there is nothing on their surface to navigate to. That
    // is the strongest form of the rule and the one that actually holds — the
    // first draft looked for `router.push(…withPlanningOverlay…)` and PASSED on
    // the break a person would really write, `router.push(href)` with `href`
    // from the hook. (Found by breaking it on purpose, which is why the card
    // asks for that step.)
    expect(src, `${rel} must not import a router`).not.toMatch(/useRouter/);
    for (const value of ['href', 'open']) {
      expect(src, `${rel} must not route with the opener's \`${value}\``).not.toMatch(
        new RegExp(`push\\(\\s*${value}\\s*[),]`),
      );
    }
  });

  it('the opener writes SHALLOWLY, and adds no pending affordance', () => {
    const hook = code('lib/hooks/useOpenPlanningWorkspace.ts');
    expect(hook).toMatch(/shallowPush\(href\)/);
    expect(hook).not.toMatch(/router\.push/);
    // The visual half of the same rule: nothing to wait for, so nothing to show.
    expect(hook).not.toMatch(/aria-busy|isPending|Spinner/);
  });
});

describe('guard · the query names are ONE contract with TWO homes', () => {
  it('the launcher emits exactly the names design-notes.md records', () => {
    // The design decided them because three files read them and none of them
    // should be the one that picks. This is the assertion that fails when either
    // home is renamed without the other.
    const notes = read('design/ai-chat/design-notes.md');
    const section = notes.slice(
      notes.indexOf('#### The ADDRESS'),
      notes.indexOf('#### Arriving cold'),
    );
    expect(section.length).toBeGreaterThan(200);

    for (const name of Object.values(OVERLAY_PARAM_NAMES)) {
      expect(section, `design-notes.md must record \`${name}\``).toContain(`**\`${name}\`**`);
    }
    // …and the notes record no FIFTH name the launcher does not emit.
    const recorded = [...section.matchAll(/\| \*\*`(plan[A-Za-z]*)`\*\*/g)].map((m) => m[1]!);
    expect(new Set(recorded)).toEqual(new Set(Object.values(OVERLAY_PARAM_NAMES)));
  });

  it('none of the names is one a host route already owns', () => {
    for (const taken of ['item', 'peek', 'run', 'mode', 'from', 'repo', 'scope', 'filter']) {
      expect(Object.values(OVERLAY_PARAM_NAMES)).not.toContain(taken);
    }
  });
});

describe('guard · the abandoned path is GONE, and the forward is all that survives', () => {
  it('`app/(planning)/` does not exist and the forward does', () => {
    expect(existsSync(join(ROOT, 'app/(planning)'))).toBe(false);
    expect(existsSync(join(ROOT, 'app/(authed)/planning/page.tsx'))).toBe(true);
  });

  it('the launcher exports none of the route-era trio', () => {
    const launcher = read('lib/planning/launcher.ts');
    for (const name of [
      'PLANNING_WORKSPACE_PATH',
      'planningWorkspaceHref',
      'planningLaunchBackHref',
    ]) {
      expect(launcher).not.toMatch(new RegExp(`export (const|function) ${name}\\b`));
    }
  });

  it('the proxy keeps its `/planning` matcher entry — the sign-in bounce', () => {
    // A SUPPRESSOR: without it a cookie-less request to a bookmarked link gets
    // the segment's own gate instead of `/sign-in?next=/planning…`.
    expect(code('proxy.ts')).toMatch(/'\/planning\/:path\*'/);
  });
});

describe('guard · the overlay is mounted exactly ONCE, and the DOOR is what the AI gate holds', () => {
  it('lives in the authed layout and nowhere else', () => {
    const layout = code('app/(authed)/layout.tsx');
    expect((layout.match(/<PlanningWorkspaceOverlay/g) ?? []).length).toBe(1);
  });

  it('⚠️ mounts on an ACTIVE PROJECT, not on `showPlanWithAi`', () => {
    // This guard read `showPlanWithAi && activeProject` until
    // `plan-change-planner-turn.spec.ts` went red in the AI-OFF main lane.
    //
    // The retired `app/(planning)/planning/page.tsx` gated on session, active
    // project and `canBrowse` — never on `isMotirAiConfigured()` — so putting
    // the overlay behind the ORB's gate narrowed a surface the story was only
    // supposed to relocate, and made `/planning`'s forward land on a page where
    // nothing mounts. What a reader sees on arrival is
    // `resolvePlanningHostGate`'s answer, exactly as it was on the page.
    const layout = code('app/(authed)/layout.tsx');
    const at = layout.indexOf('<PlanningWorkspaceOverlay');
    const before = layout.slice(Math.max(0, at - 500), at);
    expect(before).toMatch(/\{activeProject \? \(/);
    expect(before).not.toMatch(/showPlanWithAi && activeProject/);
  });

  it('…and the DOOR is still held by it — the orb ships only where AI planning is wired', () => {
    // The other half, asserted so that widening the MOUNT cannot be read as
    // permission to widen the doors. A workspace with no motir-ai still offers
    // nobody a way in; it only stops swallowing an address somebody already has.
    const layout = code('app/(authed)/layout.tsx');
    expect(layout).toMatch(/\{showPlanWithAi \? <PlanWithAIFab \/> : null\}/);
  });
});

describe('guard · ONE Escape handler — the dialog’s', () => {
  it('the host registers no keydown listener of its own', () => {
    // Two handlers on one full-screen canvas inside a dialog is the collision
    // `design/runs/design-notes.md` warned about.
    const host = code('components/planning/PlanningWorkspaceHost.tsx');
    expect(host).not.toMatch(/addEventListener\('keydown'/);
    expect(host).not.toMatch(/event\.key !== 'Escape'/);
  });
});

describe('guard · the pure modules stay framework-free', () => {
  it.each(['lib/planning/aiCallout.ts', 'lib/planning/launcher.ts', 'lib/planning/planPending.ts'])(
    '%s imports no React and no server-only',
    (rel) => {
      const src = code(rel);
      expect(src).not.toMatch(/from ['"]react(-dom)?(\/[^'"]*)?['"]/);
      expect(src).not.toMatch(/['"]server-only['"]/);
      expect(src).not.toMatch(/from ['"]next\//);
      expect(read(rel).trimStart().startsWith("'use client'")).toBe(false);
    },
  );
});

describe('guard · the open-core boundary', () => {
  it('nothing on this story’s surface imports from motir-ai', () => {
    for (const rel of [
      'lib/planning/launcher.ts',
      'lib/planning/planPending.ts',
      'lib/planning/planningAnchorClient.ts',
      'lib/hooks/useOpenPlanningWorkspace.ts',
      'components/planning/PlanningWorkspaceOverlay.tsx',
      'components/planning/PlanCloseGuard.tsx',
      'components/planning/PlanningWorkspaceHost.tsx',
      'app/api/work-items/planning-anchor/route.ts',
      'app/(authed)/planning/page.tsx',
    ]) {
      expect(code(rel), `${rel} must not reach motir-ai`).not.toMatch(/motir-ai|@motir\/ai/);
    }
  });
});

describe('guard · the invariants the ignore directives stand on', () => {
  it('`URLSearchParams.getAll` never answers null — the launcher’s `??` arm is unreachable', () => {
    // `lib/planning/launcher.ts`'s `readParam` carries a `v8 ignore` citing this
    // test. The arm exists because the value crosses into a type that admits
    // `undefined`; the Web API's own contract is why it can never fire.
    const params = new URLSearchParams('a=1');
    expect(params.getAll('nothing-here')).toEqual([]);
    expect(params.getAll('a')).toEqual(['1']);
  });

  it('the anchor route catches exactly the three classes its one service call throws', () => {
    // `app/api/work-items/planning-anchor/route.ts` carries a `v8 ignore` on its
    // re-throw citing this test. Reaching that line would mean mocking
    // `workItemsService`, which is the one thing this gate forbids — a mocked
    // service is exactly what stops proving the 404 contract. So the invariant
    // is asserted instead: the catch names the classes, and the service throws
    // no fourth.
    const route = code('app/api/work-items/planning-anchor/route.ts');
    for (const cls of [
      'WorkItemNotFoundError',
      'ProjectAccessDeniedError',
      'ProjectNotFoundError',
    ]) {
      expect(route).toContain(cls);
    }
    const service = code('lib/services/workItemsService.ts');
    const body = service.slice(
      service.indexOf('async getWorkItemWithAncestors('),
      service.indexOf('async getWorkItemByProjectKindAndTitle('),
    );
    expect(body.length).toBeGreaterThan(100);
    const thrown = [...body.matchAll(/throw new (\w+)/g)].map((m) => m[1]!);
    expect(new Set(thrown)).toEqual(new Set(['WorkItemNotFoundError']));

    // …and `ProjectNotFoundError` — the third class the catch names, carrying
    // its own `v8 ignore` — is REAL but unreachable FROM HERE. `resolveInputs`
    // raises it for a cross-workspace project id, and `assertCanBrowse` calls
    // `resolveInputs`; what stops it is the ORDER inside the service, which
    // rejects a foreign tenant with `WorkItemNotFoundError` before the access
    // read happens. That ordering is a fact about another module rather than a
    // contract this handler owns, which is why the class is kept rather than
    // dropped — and why the assertion below is about the order, not the absence.
    expect(body).toMatch(/workItemRepository\.findByIdentifier/);
    expect(body.indexOf('findByIdentifier')).toBeLessThan(body.indexOf('assertCanBrowse'));
  });
});

describe('guard · this gate mocks nothing it is measuring', () => {
  it('no `vi.mock` of the store, the conversation or the launcher in this file', () => {
    const self = read('tests/planning/planning-overlay-story-gate.test.ts');
    expect(self).not.toMatch(/vi\.mock\(/);
  });
});
