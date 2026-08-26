import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3444 — the two work-item LIST surfaces at arrival, and the one page this
// card deliberately does NOT touch.
//
// ── WHY THESE ARE SOURCE ASSERTIONS ────────────────────────────────────────
// Both halves decay silently and neither is visible to a functional test. A
// `loading.tsx` is a file nothing imports: adding one at `app/(authed)/items/`
// would compile, render, and pass every existing spec while replacing a toolbar
// the reader can already click with grey blocks. And a `Promise.all` collapsed
// back into two sequential awaits produces identical output — its only symptom
// is a round trip. So the shape is asserted where the shape lives, in the same
// idiom as `tests/navigation/loading-boundary-guard.test.ts` one file over.

const ROOT = join(__dirname, '..', '..');
const AUTHED = join(ROOT, 'app', '(authed)');

/**
 * Source with its COMMENTS removed.
 *
 * ⚠️ Every assertion below reads CODE, so it must not see prose. Both of these
 * files discuss `<Suspense>` in their header comments — `/items/page.tsx`
 * explains the boundary it ships, and the edit page explains the one it
 * deliberately does not — so a naive `indexOf('<Suspense')` finds the sentence
 * about the boundary long before the boundary, and `not.toContain` fails on a
 * file that contains no boundary at all. Both were caught by this test failing
 * on the first run, which is the only reason it is stated here rather than
 * discovered later on a false green.
 */
const read = (...seg: string[]) =>
  readFileSync(join(AUTHED, ...seg), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('/items is left alone on purpose (MOTIR-3444)', () => {
  // `/items` is the one heavy authed page that already arrives the way
  // MOTIR-3440 wants: its header and `[Filter] · [Tree ▾] · [+ New]` toolbar
  // render synchronously and only the table sits behind a boundary. A
  // `loading.tsx` at this segment would sit ABOVE all of it.
  //
  // This is a NON-CHANGE, which is exactly why it needs a test: there is no
  // diff for a reviewer to notice, and the file layout makes the wrong move the
  // convenient one — one file at `items/` would "cover" the two subjects this
  // card fixes and take the toolbar down with them.
  it('has no route-level loading boundary at the /items segment', () => {
    expect(existsSync(join(AUTHED, 'items', 'loading.tsx'))).toBe(false);
  });

  it('renders its toolbar BEFORE the boundary, with only the tree section behind it', () => {
    const src = read('items', 'page.tsx');

    const firstSuspense = src.indexOf('<Suspense');
    expect(firstSuspense).toBeGreaterThan(-1);

    // The applied-filter bar is the last piece of toolbar chrome the page emits.
    // It must be ABOVE the boundary, or the reader loses a usable control to a
    // skeleton.
    const toolbar = src.indexOf('<IssueAppliedFilterBar');
    expect(toolbar).toBeGreaterThan(-1);
    expect(toolbar).toBeLessThan(firstSuspense);

    // …and the table is the only thing BELOW it.
    expect(src.indexOf('<IssueTreeSection')).toBeGreaterThan(firstSuspense);
  });
});

describe('/items/[key]/edit — the form WAITS (MOTIR-3444)', () => {
  const src = read('items', '[key]', 'edit', 'page.tsx');

  // The design decision, asserted rather than commented: skeleton form fields
  // look responsive and cannot be typed into, and a field that swaps from
  // skeleton to populated mid-keystroke can eat what was typed. Here the
  // question does not even arise — `getIssueDetail` decides the 404, so it is a
  // gate read, and the same result carries every value the form renders.
  it('wraps no field in a boundary', () => {
    expect(src).not.toContain('<Suspense');
  });

  // The one read genuinely behind the gate is the assignee picker's option
  // list. It is made concurrent with the capability read rather than streamed:
  // one round trip instead of two, and the form still arrives complete.
  it('issues the capability read and the member list in ONE wave', () => {
    const wave = src.match(
      /const \[\{ canEdit \}, members\] = await Promise\.all\(\[[\s\S]*?\]\);/,
    );
    expect(wave, 'canEdit and members must resolve in one Promise.all').not.toBeNull();

    const block = wave![0];
    expect(block).toContain('projectAccessService.getCapabilities');
    expect(block).toContain('assignableMembersService.list');
  });

  // The gate itself must stay ahead of that wave: the 404 and the 308 are
  // decided by `getIssueDetail`, and nothing may be flushed until it returns.
  it('keeps the existence gate ahead of the concurrent wave', () => {
    expect(src.indexOf('getIssueDetail')).toBeLessThan(src.indexOf('Promise.all'));
    expect(src).toContain('notFound()');
    expect(src).toContain('permanentRedirect(');
  });
});

describe('/items/archived — reads already run in one wave (MOTIR-3444)', () => {
  // Measured rather than assumed: this page was already concurrent when the card
  // was picked up, so the card's concurrency half is a no-op here and the test
  // records that rather than a diff.
  //
  // ⚠️ Its BOUNDARY is NOT added by this card, and that is a reported
  // falsification rather than an omission — see MOTIR-3444's PR body and the
  // amended `design/work-items/design-notes.md` entry. The design cited
  // `IssueTreeSkeleton` as the stand-in; that component lays out the NINE
  // `buildIssueColumns` tracks at 40px rows, while this table is four or five
  // tracks (`minmax(0,1fr) 130px 175px 140px [150px]`) at 48px rows. Using it
  // would reproduce exactly the MOTIR-3452 defect its own header comment
  // documents.
  it('resolves the workflow and the archived page together', () => {
    const src = read('items', 'archived', 'page.tsx');
    const wave = src.match(/const \[workflow, archived\] = await Promise\.all\(\[[\s\S]*?\]\);/);
    expect(wave).not.toBeNull();
    expect(wave![0]).toContain('workflowsService.getWorkflow');
    expect(wave![0]).toContain('workItemsService.listArchivedWorkItems');
  });

  it('adds no boundary while its stand-in is undecided', () => {
    expect(existsSync(join(AUTHED, 'items', 'archived', 'loading.tsx'))).toBe(false);
    expect(read('items', 'archived', 'page.tsx')).not.toContain('<Suspense');
  });
});
