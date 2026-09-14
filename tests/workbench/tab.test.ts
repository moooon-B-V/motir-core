import { describe, expect, it } from 'vitest';
import { WORKBENCH_TABS, parseWorkbenchTab, workbenchTabHref } from '@/lib/workbench/tab';

// The Workbench tab axis (Story MOTIR-2649 · MOTIR-2653, widened to five tabs by
// Story MOTIR-4777 · MOTIR-4782) — the one place that decides what a tab IS and
// how it is spelled in a URL. Pure, so it tests without a browser or a database.

describe('WORKBENCH_TABS — the strip order (MOTIR-5217)', () => {
  it('is the design order: what waits on you, what moves, what to start, then the rest', () => {
    expect(WORKBENCH_TABS).toEqual(['approvals', 'in-progress', 'todo', 'finished', 'watching']);
  });

  it('says nothing about the landing — the order and the address are separate decisions', () => {
    // To approve LEADS the strip, but a bare request is not answered from the
    // array's first member: the landing cascade decides it, from the counts.
    expect(WORKBENCH_TABS[0]).toBe('approvals');
    expect(WORKBENCH_TABS.map((tab) => workbenchTabHref(tab))).toEqual([
      '/workbench?tab=approvals',
      '/workbench?tab=in-progress',
      '/workbench?tab=todo',
      '/workbench?tab=finished',
      '/workbench?tab=watching',
    ]);
  });
});

describe('parseWorkbenchTab', () => {
  it('reads EVERY tab by its own slug — To do and To approve included (MOTIR-5218)', () => {
    expect(parseWorkbenchTab('approvals')).toBe('approvals');
    expect(parseWorkbenchTab('in-progress')).toBe('in-progress');
    expect(parseWorkbenchTab('todo')).toBe('todo');
    expect(parseWorkbenchTab('finished')).toBe('finished');
    expect(parseWorkbenchTab('watching')).toBe('watching');
  });

  it('names NO tab for anything else — STRICT, so the page can run the cascade (MOTIR-5221)', () => {
    // Every one of these can arrive from a hand-edited URL or a stale bookmark.
    // The page still LANDS rather than 404s, but the landing is the cascade's
    // (`lib/workbench/landing.ts`), so the parse must be able to say "none" —
    // a lenient parse would hide exactly the case the resolver exists for.
    expect(parseWorkbenchTab(undefined)).toBeNull();
    expect(parseWorkbenchTab('')).toBeNull();
    expect(parseWorkbenchTab('Watching')).toBeNull(); // case-sensitive by design
    expect(parseWorkbenchTab('nonsense')).toBeNull();
    expect(parseWorkbenchTab('to-approve')).toBeNull(); // the LABEL is not a slug
  });

  it('takes the first value when Next hands it a repeated param', () => {
    expect(parseWorkbenchTab(['watching', 'finished'])).toBe('watching');
    expect(parseWorkbenchTab([])).toBeNull();
    expect(parseWorkbenchTab(['nonsense', 'todo'])).toBeNull();
  });
});

describe('workbenchTabHref', () => {
  it('spells EVERY tab as `?tab=` — the one-URL-per-tab rule is TOTAL (MOTIR-5218)', () => {
    // The bare path is an entrance that names no tab, so no tab may be spelled
    // as it — To do included, which used to be the special case.
    expect(workbenchTabHref('todo')).toBe('/workbench?tab=todo');
    expect(workbenchTabHref('in-progress')).toBe('/workbench?tab=in-progress');
    expect(workbenchTabHref('finished')).toBe('/workbench?tab=finished');
    expect(workbenchTabHref('watching')).toBe('/workbench?tab=watching');
  });

  it('addresses To approve by its SET, not by its label', () => {
    // The strip reads "To approve" and the URL says `approvals`: a label names
    // an action, a slug names the set (`design/workbench/design-notes.md`
    // § The tab strip). The two are allowed to differ; what is not allowed is a
    // second spelling of either.
    expect(workbenchTabHref('approvals')).toBe('/workbench?tab=approvals');
  });

  it('round-trips every tab through its own href, and no href is the bare path', () => {
    // Totality, rather than five hand-written pairs: a sixth tab added to the
    // union round-trips here or fails here, and it cannot silently borrow the
    // bare path.
    for (const tab of WORKBENCH_TABS) {
      const href = workbenchTabHref(tab);
      const param = new URL(href, 'https://x').searchParams.get('tab');
      expect(param, `${tab} has no ?tab=`).not.toBeNull();
      expect(parseWorkbenchTab(param ?? undefined), `${tab} does not round-trip`).toBe(tab);
    }
  });

  it('carries a PAGE alongside the tab', () => {
    expect(workbenchTabHref('todo', 3)).toBe('/workbench?tab=todo&page=3');
    expect(workbenchTabHref('watching', 3)).toBe('/workbench?tab=watching&page=3');
  });

  it('emits NO param for page one — one canonical URL per view', () => {
    // A link to a tab and a link to its first page must be the SAME link, or the
    // product has two spellings for one view (MOTIR-4853). The pager's own `1`
    // button navigates here.
    expect(workbenchTabHref('todo', 1)).toBe('/workbench?tab=todo');
    expect(workbenchTabHref('watching', 1)).toBe('/workbench?tab=watching');
  });

  it('drops an absent or degenerate page rather than emitting an empty param', () => {
    expect(workbenchTabHref('todo')).toBe('/workbench?tab=todo');
    expect(workbenchTabHref('todo', null)).toBe('/workbench?tab=todo');
    // 0 and a negative are what a hand-edited URL produces; `parsePage` already
    // answers 1 for them, and the builder must not emit them either.
    expect(workbenchTabHref('watching', 0)).toBe('/workbench?tab=watching');
    expect(workbenchTabHref('watching', -5)).toBe('/workbench?tab=watching');
  });
});
