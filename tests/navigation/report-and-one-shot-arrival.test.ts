import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3447 — the report and one-shot surfaces at arrival.
//
// One of the three earns a frame and gets it; the two chart pages get no diff,
// and the reason is a contradiction inside the card rather than an omission —
// recorded below so it is not re-litigated by the next reader.

const ROOT = join(__dirname, '..', '..');
const AUTHED = join(ROOT, 'app', '(authed)');

/** Source with COMMENTS removed — every assertion here reads CODE, not prose. */
const read = (...seg: string[]) =>
  readFileSync(join(AUTHED, ...seg), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('/invite/accept arrives on its own frame (MOTIR-3447)', () => {
  const src = read('invite', 'accept', 'page.tsx');

  it('renders the drawn frame as the boundary fallback', () => {
    expect(src).toContain('<Suspense fallback={<InviteFrame />}>');
    // The frame is the design's, composed from the card chrome the four bodies
    // share: a headline bar, two subhead bars, one control-height block.
    expect(src).toContain('function InviteFrame()');
    expect(src).toContain('h-11 w-3/4 rounded-(--radius-control) sm:h-15');
    expect(src).toContain('h-(--height-btn-md)');
  });

  it('keeps the SESSION redirect in the page and the invite read behind the boundary', () => {
    // The session check decides the RESPONSE and must bounce an unauthenticated
    // visitor rather than frame them. `inspectInvite` decides only WHICH BODY —
    // this route answers 200 for every token outcome and calls notFound()
    // nowhere — so it is free to sit behind a boundary.
    //
    // ⚠️ Asserted STRUCTURALLY, not by source position: `InviteOutcome` is a
    // function DECLARATION and sits above the page in the file, so a
    // "read appears after the boundary" index check is about layout rather than
    // execution and fails on correct code. (It did, on the first run.)
    const page = src.slice(src.indexOf('export default async function InviteAcceptPage'));
    expect(page).toContain("redirect('/sign-in')");
    expect(page).not.toContain('inspectInvite');
    expect(page).toContain('<InviteOutcome');

    const outcome = src.slice(
      src.indexOf('async function InviteOutcome'),
      src.indexOf('export default async function InviteAcceptPage'),
    );
    expect(outcome).toContain('workspaceInvitesService.inspectInvite');
  });

  it('never calls notFound(), which is why the frame is legal here', () => {
    expect(src).not.toContain('notFound(');
  });

  it('still renders every one of the four terminal outcomes', () => {
    for (const state of [
      '<ExpiredState />',
      '<UsedState />',
      '<WrongEmailState',
      '<AcceptInviteButton',
    ]) {
      expect(src).toContain(state);
    }
    // …and the token-less case is answered ABOVE the boundary, unchanged: there
    // is nothing to resolve, so there is nothing to frame.
    expect(src.indexOf('if (!token)')).toBeLessThan(src.indexOf('<Suspense'));
  });
});

describe('the two chart pages get NO boundary (MOTIR-3447)', () => {
  // ⚠️ NOT AN OMISSION — the card contradicts itself here, precisely and
  // narrowly, and this records which half won.
  //
  //   AC: "Each chart page's chrome — heading, sprint picker, period controls —
  //        renders BEFORE its series resolves."
  //   Boundary: "does not change any chart component or its internal loading
  //        state."
  //
  // The sprint picker is a `Combobox` INSIDE `BurndownReport` — the chart
  // component. Painting it before the series therefore requires splitting that
  // component, which the boundary forbids. The boundary clause won, because
  // wrapping the whole component instead would take the picker behind the
  // fallback with it and buy nothing the AC was asking for.
  it('/reports/burndown has no boundary and no loading.tsx', () => {
    expect(read('reports', 'burndown', 'page.tsx')).not.toContain('<Suspense');
    expect(existsSync(join(AUTHED, 'reports', 'burndown', 'loading.tsx'))).toBe(false);
  });

  it('/sprints/[id]/report has no boundary and no loading.tsx', () => {
    expect(read('sprints', '[id]', 'report', 'page.tsx')).not.toContain('<Suspense');
    expect(existsSync(join(AUTHED, 'sprints', '[id]', 'report', 'loading.tsx'))).toBe(false);
  });

  it('/sprints/[id]/report keeps its four reads in one wave', () => {
    // Measured: already concurrent. The design entry asked for the GATE to be
    // narrowed (notFound() fires on `!report`, so velocity and cycle are held
    // by a decision they do not inform) — but the page cannot render until all
    // four resolve anyway, because `SprintReport` takes all four as props, and
    // splitting that is the same forbidden component change.
    const src = read('sprints', '[id]', 'report', 'page.tsx');
    const wave = src.match(/await Promise\.all\(\[[\s\S]*?\n\s*\]\)/)?.[0] ?? '';
    for (const call of ['getSprintReport', 'getWorkflow', 'getVelocity', 'getSprintCycleGraph']) {
      expect(wave).toContain(call);
    }
  });

  it('/reports/burndown keeps its series read genuinely serial', () => {
    // Nothing to parallelise: the cycle read takes `selected.id`, and the
    // selection comes from the sprint list that also decides the no-sprints
    // empty state.
    const src = read('reports', 'burndown', 'page.tsx');
    expect(src.indexOf('sprintsService.listByProject')).toBeLessThan(
      src.indexOf('getSprintCycleGraph'),
    );
  });
});
