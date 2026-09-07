import { describe, expect, it } from 'vitest';
import { WORKBENCH_TABS, parseWorkbenchTab, workbenchTabHref } from '@/lib/workbench/tab';

// The Workbench tab axis (Story MOTIR-2649 · MOTIR-2653, widened to five tabs by
// Story MOTIR-4777 · MOTIR-4782) — the one place that decides what a tab IS and
// how it is spelled in a URL. Pure, so it tests without a browser or a database.

describe('parseWorkbenchTab', () => {
  it('reads every addressable tab', () => {
    expect(parseWorkbenchTab('in-progress')).toBe('in-progress');
    expect(parseWorkbenchTab('finished')).toBe('finished');
    expect(parseWorkbenchTab('watching')).toBe('watching');
    expect(parseWorkbenchTab('approvals')).toBe('approvals');
  });

  it('LANDS rather than 404s on anything else', () => {
    // Every one of these can arrive from a hand-edited URL or a stale bookmark,
    // and this is a LANDING page: the cost of being strict is that someone's
    // first screen after signing in is an error.
    expect(parseWorkbenchTab(undefined)).toBe('todo');
    expect(parseWorkbenchTab('')).toBe('todo');
    expect(parseWorkbenchTab('Watching')).toBe('todo'); // case-sensitive by design
    expect(parseWorkbenchTab('nonsense')).toBe('todo');
  });

  it('does NOT address the default tab by name — `?tab=todo` is not a URL', () => {
    // The pair with the href assertion below: `todo` is spelled as the ABSENCE
    // of the param, so accepting it as a slug too would create a second URL for
    // the tab that has one.
    expect(parseWorkbenchTab('todo')).toBe('todo');
    expect(workbenchTabHref('todo')).toBe('/workbench');
  });

  it('takes the first value when Next hands it a repeated param', () => {
    expect(parseWorkbenchTab(['watching', 'finished'])).toBe('watching');
    expect(parseWorkbenchTab([])).toBe('todo');
  });
});

describe('workbenchTabHref', () => {
  it('spells To do as the ABSENCE of the param', () => {
    // One canonical URL per tab: a link to the Workbench and a link to To do are
    // the same link, so they cannot drift apart in a nav, a test, or a bookmark.
    expect(workbenchTabHref('todo')).toBe('/workbench');
    expect(workbenchTabHref('in-progress')).toBe('/workbench?tab=in-progress');
    expect(workbenchTabHref('finished')).toBe('/workbench?tab=finished');
    expect(workbenchTabHref('watching')).toBe('/workbench?tab=watching');
  });

  it('addresses the fifth tab by its SET, not by its label', () => {
    // The strip reads "To approve" and the URL says `approvals`: a label names
    // an action, a slug names the set (`design/workbench/design-notes.md`
    // § The tab strip). The two are allowed to differ; what is not allowed is a
    // second spelling of either.
    expect(workbenchTabHref('approvals')).toBe('/workbench?tab=approvals');
    expect(parseWorkbenchTab('to-approve')).toBe('todo');
  });

  it('round-trips every tab through its own href', () => {
    // Totality, rather than five hand-written pairs: a sixth tab added to the
    // union without a param entry fails here rather than silently landing on
    // To do.
    for (const tab of WORKBENCH_TABS) {
      const href = workbenchTabHref(tab);
      const param = new URL(href, 'https://x').searchParams.get('tab') ?? undefined;
      expect(parseWorkbenchTab(param), `${tab} does not round-trip`).toBe(tab);
    }
  });

  it('carries a page cursor alongside the tab', () => {
    expect(workbenchTabHref('todo', 'abc')).toBe('/workbench?cursor=abc');
    expect(workbenchTabHref('watching', 'abc')).toBe('/workbench?tab=watching&cursor=abc');
  });

  it('drops an absent cursor rather than emitting an empty param', () => {
    expect(workbenchTabHref('todo', null)).toBe('/workbench');
    expect(workbenchTabHref('watching', '')).toBe('/workbench?tab=watching');
  });

  it('escapes a cursor that is not URL-safe', () => {
    // The cursor is base64url today and therefore safe, but the href builder
    // must not be the thing that assumes so.
    expect(workbenchTabHref('todo', 'a b&c=d')).toBe('/workbench?cursor=a+b%26c%3Dd');
  });
});
