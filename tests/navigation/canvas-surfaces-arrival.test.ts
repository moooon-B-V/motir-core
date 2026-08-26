import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3445 — the four CANVAS surfaces at arrival.
//
// Each of these pages is chrome around a client canvas that fetches its own
// data, so what the server does before rendering is the whole cost. Two of the
// four were issuing independent reads in sequence; two were already one wave.
// A collapsed `Promise.all` produces byte-identical output — its only symptom is
// a round trip — so the shape is asserted where the shape lives, in the idiom of
// `tests/navigation/loading-boundary-guard.test.ts`.

const ROOT = join(__dirname, '..', '..');
const AUTHED = join(ROOT, 'app', '(authed)');

/**
 * Source with its COMMENTS removed — every assertion here reads CODE.
 *
 * All four files discuss their own read chains in prose, so an `indexOf` over
 * the raw text finds the sentence about a call long before the call.
 */
const read = (...seg: string[]) =>
  readFileSync(join(AUTHED, ...seg), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/** The single `Promise.all([...])` block whose text contains every needle. */
function waveContaining(src: string, ...needles: string[]): string | null {
  for (const m of src.matchAll(/await Promise\.all\(\[[\s\S]*?\n\s*\]\)/g)) {
    if (needles.every((n) => m[0].includes(n))) return m[0];
  }
  return null;
}

describe('/roadmap — its two reads stay SERIAL, deliberately (MOTIR-3445)', () => {
  const src = read('roadmap', 'page.tsx');

  // ⚠️ THIS PAGE GETS NO DIFF, AND THAT IS THE MEASURED RESULT.
  //
  // `getProjectRoadmap` and `getActiveSprint` are independent, so collapsing
  // them into one wave looks like the obvious win — and it was built, and it
  // broke `tests/planning/roadmapPageStreaming.test.tsx`'s assertion that the
  // EMPTY branch calls no sprint read.
  //
  // That assertion is not incidental. The page returns early for an empty
  // roadmap, so today a first-run project pays ONE read; a `Promise.all` makes
  // it pay two. `roadmapPageStreaming.test.tsx` exists precisely because
  // "/roadmap already pays two reads before it paints, and MOTIR-2069 is the
  // record of what a third one costs on a flagship surface" — and the empty
  // branch is the ONBOARDING path, where that cost lands on the reader who has
  // least reason to wait.
  //
  // So the trade is refused: a round trip saved on populated projects is not
  // worth one added to every empty one, on the one surface with a guard file
  // saying so. The serial pair below is correct as it stands.
  it('reads the roadmap root before the active sprint, with the sprint skipped when empty', () => {
    const roots = src.indexOf('workItemsService.getProjectRoadmap');
    const sprint = src.indexOf('sprintsService.getActiveSprint');
    expect(roots).toBeGreaterThan(-1);
    expect(sprint).toBeGreaterThan(roots);
    // The early return between them is what keeps the empty branch to one read.
    expect(src.slice(roots, sprint)).toContain('isEmpty');
  });

  it('keeps the browse gate ahead of both', () => {
    expect(src.indexOf('projectAccessService.getCapabilities')).toBeLessThan(
      src.indexOf('workItemsService.getProjectRoadmap'),
    );
    expect(src).toContain('caps.canBrowse');
  });
});

describe('/plans/[id] — the two follow-on reads are one wave (MOTIR-3445)', () => {
  const src = read('plans', '[id]', 'page.tsx');

  it('issues the project resolution and the establish view together', () => {
    const wave = waveContaining(src, 'assertProjectInWorkspace', 'getEstablishView');
    expect(
      wave,
      'the project resolution and the establish view must resolve in one wave',
    ).not.toBeNull();
  });

  it('keeps the establish read CONDITIONAL on an approved plan', () => {
    // The card is explicit that no conditional read may become unconditional.
    const wave = waveContaining(src, 'assertProjectInWorkspace', 'getEstablishView')!;
    expect(wave).toContain("review.status === 'approved'");
  });

  it('keeps the 404 gate ahead of the wave', () => {
    expect(src.indexOf('getPlanReview')).toBeLessThan(src.indexOf('Promise.all'));
    expect(src).toContain('notFound()');
  });
});

describe('the two pages that were ALREADY one wave (MOTIR-3445)', () => {
  // Measured, not assumed: both of these were already concurrent when the card
  // was picked up, so the card ships no diff for them and this records why.
  // A page reported as already concurrent having no diff is a correct outcome.
  it('/plans resolves its page and its counts together', () => {
    const wave = waveContaining(
      read('plans', 'page.tsx'),
      'plansService.listPlans',
      'plansService.countPlansByStatus',
    );
    expect(wave).not.toBeNull();
  });

  it('/boards resolves its seven filter-chrome reads together', () => {
    const wave = waveContaining(
      read('boards', 'page.tsx'),
      'assignableMembersService.list',
      'workflowsService.getWorkflow',
      'sprintsService.listByProject',
      'customFieldsService.listFields',
      'componentsService.listComponents',
      'labelsService.resolveByIds',
      'projectAccessService.getSavedFilterCapabilities',
    );
    expect(wave).not.toBeNull();
  });
});

describe('no route boundary is added to any of the four (MOTIR-3445)', () => {
  // Rule 5 of design/shell/design-notes.md § WHICH SURFACES EARN A FRAME: one
  // mechanism, not two. `/plans/[id]` additionally calls notFound(), where a
  // route boundary is PROHIBITED rather than merely declined.
  it.each([['roadmap'], ['plans'], ['boards']])('%s has no loading.tsx', (seg) => {
    expect(existsSync(join(AUTHED, seg, 'loading.tsx'))).toBe(false);
  });

  it('plans/[id] has no loading.tsx', () => {
    expect(existsSync(join(AUTHED, 'plans', '[id]', 'loading.tsx'))).toBe(false);
  });
});
