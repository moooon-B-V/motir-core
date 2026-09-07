import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { aiCalloutActions } from '@/lib/planning/aiCallout';
import { planningOverlaySearch, type PlanningLaunchContext } from '@/lib/planning/launcher';

// ⚠️ RE-POINTED (MOTIR-4730). `aiCalloutActions` takes the resolved OVERLAY
// address now instead of a context — the workspace is a layer on the current
// page and only a component can read that address. These guards are about the
// registry's INVARIANTS, not about who computes the href, so they pass the
// address a door would actually produce.
function overlayHref(context: PlanningLaunchContext, page = '/backlog'): string {
  return `${page}?${planningOverlaySearch(context).toString()}`;
}

// The story's CONTRACT guards (MOTIR-1343 · MOTIR-1822) — the half of the gate a
// coverage number cannot see. Coverage says every line ran; it says nothing
// about a second href appearing in the callout registry, an intent value
// arriving in `PlanningMode`, or a route growing a transaction.
//
// ⚠️ EVERY GUARD BELOW EXISTS BECAUSE THE DESIGN IT PROTECTS WAS ALREADY BUILT
// ONCE AND DELETED. MOTIR-1343's first two plans specified an "ask mode": a new
// `PlanningMode` value, a `?mode=ask` href, a host branch to "ask chrome". Both
// were struck out at a higher rung — the callout's rows share ONE href *because
// the user can switch topic mid-conversation* — and MOTIR-1971 was filed when
// the correction reached one story body and left the premise in its subtasks.
// A deleted design is exactly what a later change re-introduces by accident, and
// only an explicit assertion catches it.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** `source` with its `//` and block comments removed — so a guard reads what the
 *  file DOES, and prose describing the trap never trips the trap's own test. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('one surface, no mode', () => {
  it('⭐ every callout row carries the SAME href, in every context', () => {
    for (const context of [
      { kind: 'project' },
      { kind: 'roadmap' },
      { kind: 'work-item', itemKey: 'PAY-7' },
      { kind: 'convention-refine', repoKey: 'motir-core' },
    ] as const) {
      const hrefs = aiCalloutActions(overlayHref(context)).map((a) => a.href);
      expect(hrefs.length).toBeGreaterThan(1);
      expect(new Set(hrefs).size).toBe(1);
    }
  });

  it('⭐ no row carries a mode, an intent, or a query of its own', () => {
    for (const action of aiCalloutActions(overlayHref({ kind: 'project' }))) {
      expect(action.href).not.toContain('intent=');
      expect(action.href).not.toContain('mode=ask');
      // The registry entry is a LABEL plus the shared href — no third field
      // through which a row could start choosing what the thread is about.
      expect(Object.keys(action).sort()).toEqual([
        'descriptionKey',
        'href',
        'icon',
        'id',
        'titleKey',
      ]);
    }
  });

  it('⭐ `PlanningMode` holds no intent value — it answers WHERE FROM, not WHAT FOR', () => {
    // Read from the SOURCE, deliberately: the union is not exported as a value,
    // and MOTIR-1820's criteria say `launcher.ts` is not to be touched — so a
    // guard that needed a new export would be the guard changing the thing it
    // guards.
    //
    // Every member is an origin. `ask` (or `question`, or `help`) here would be
    // a category error rather than a small addition: `resolvePlanningMode`
    // derives this from where the workspace was LAUNCHED FROM, so an intent in
    // the union is a value nothing can legitimately produce.
    const declaration = /export type PlanningMode =([^;]+);/.exec(read('lib/planning/launcher.ts'));
    expect(declaration, 'the PlanningMode union moved — re-point this guard').toBeTruthy();
    const members = [...declaration![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
    expect(members).toEqual(['contextual', 'generation', 'project', 'replan', 'roadmap']);
  });

  it('⭐ the ask door reads no `intent` from its request body', () => {
    // A hint on the wire is the mode re-entering through the back door
    // (`conversation-turn-intent.md` §5). The route suite asserts the BEHAVIOUR;
    // this asserts the route never even names the field, so nobody adds a read
    // "just for logging" and leaves a live parameter behind.
    const route = code(read('app/api/ai/ask/route.ts'));
    expect(route).not.toMatch(/\bintent\b/);
  });
});

describe('layering — the ask surface obeys the 4-layer contract', () => {
  const ROUTES = [
    'app/api/ai/ask/route.ts',
    'app/api/ai/ask/settle/route.ts',
    'app/api/ai/ask/[jobId]/stream/route.ts',
  ];

  it.each(ROUTES)('%s imports no `db` and opens no transaction', (path) => {
    const route = code(read(path));
    expect(route).not.toMatch(/from '@\/lib\/db'/);
    expect(route).not.toMatch(/\$transaction/);
    // …and it reaches Prisma through no other name either.
    expect(route).not.toMatch(/\bprisma\./);
  });

  it('the ask SERVICE calls motir-ai outside any transaction', () => {
    // A provider call inside a transaction holds a row lock for the length of a
    // model run. The service's own comment says the submit is a side effect
    // OUTSIDE the tx; this is the assertion that keeps it true.
    const service = code(read('lib/services/aiAskService.ts'));
    expect(service).not.toMatch(/\$transaction/);
  });
});

describe('i18n — the keys this story added, and the one it removed', () => {
  type Catalog = Record<string, Record<string, unknown>>;
  const enC = en as unknown as Catalog;
  const zhC = zh as unknown as Catalog;

  /** Every leaf key path under `obj`, dotted. */
  function leaves(obj: unknown, prefix = ''): string[] {
    if (typeof obj !== 'object' || obj === null) return [prefix];
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      leaves(v, prefix ? `${prefix}.${k}` : k),
    );
  }

  it('the ask row and the conversation copy exist in BOTH catalogs', () => {
    for (const path of [
      ['shell', 'aiCallout', 'actions', 'ask', 'title'],
      ['shell', 'aiCallout', 'actions', 'ask', 'description'],
      ['planningWorkspace', 'conversation', 'answeredFrom'],
      ['planningWorkspace', 'conversation', 'correctToPlan'],
      ['planningWorkspace', 'conversation', 'correctToAsk'],
      ['planningWorkspace', 'conversation', 'correcting'],
      ['planningWorkspace', 'conversation', 'handoff'],
      ['planningWorkspace', 'conversation', 'starters', 'blocked'],
      ['planningWorkspace', 'conversation', 'progress', 'reading'],
      ['planningWorkspace', 'conversation', 'progress', 'redirected'],
      ['planningWorkspace', 'conversation', 'error', 'askSilent'],
      ['planningWorkspace', 'footerRestingTitle'],
      ['planningWorkspace', 'footerRestingBody'],
    ]) {
      for (const [name, cat] of [
        ['en', enC],
        ['zh', zhC],
      ] as const) {
        const value = path.reduce<unknown>(
          (node, k) => (node as Record<string, unknown> | undefined)?.[k],
          cat,
        );
        expect(typeof value, `${name}.${path.join('.')}`).toBe('string');
      }
    }
  });

  it('⭐ `onboarding.chat.assistantInitial` is GONE from both — a removal has two sides', () => {
    // The mirror failure of a missing key: a `zh` entry left behind by the glyph
    // swap renders nothing and reads as translated. MOTIR-3185 deleted it from
    // both; this is what keeps it deleted.
    for (const [name, cat] of [
      ['en', enC],
      ['zh', zhC],
    ] as const) {
      const chat = (cat['onboarding'] as Record<string, unknown> | undefined)?.['chat'] as
        | Record<string, unknown>
        | undefined;
      expect(chat, `${name}.onboarding.chat`).toBeTruthy();
      expect(Object.keys(chat!), name).not.toContain('assistantInitial');
    }
  });

  it('the two catalogs agree on the conversation namespace, key for key', () => {
    const enKeys = leaves(enC['planningWorkspace']!['conversation']).sort();
    const zhKeys = leaves(zhC['planningWorkspace']!['conversation']).sort();
    expect(zhKeys).toEqual(enKeys);
  });
});
