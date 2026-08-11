import { describe, expect, it } from 'vitest';
import { homeTabHref, parseHomeTab } from '@/lib/home/tab';

// The Home tab axis (Story MOTIR-2649 · Subtask MOTIR-2653) — the one place
// that decides what a tab IS and how it is spelled in a URL. Pure, so it tests
// without a browser or a database.

describe('parseHomeTab', () => {
  it('reads the Watching tab', () => {
    expect(parseHomeTab('watching')).toBe('watching');
  });

  it('LANDS rather than 404s on anything else', () => {
    // Every one of these can arrive from a hand-edited URL or a stale bookmark,
    // and this is a LANDING page: the cost of being strict is that someone's
    // first screen after signing in is an error.
    expect(parseHomeTab(undefined)).toBe('work');
    expect(parseHomeTab('')).toBe('work');
    expect(parseHomeTab('work')).toBe('work');
    expect(parseHomeTab('Watching')).toBe('work'); // case-sensitive by design
    expect(parseHomeTab('nonsense')).toBe('work');
  });

  it('takes the first value when Next hands it a repeated param', () => {
    expect(parseHomeTab(['watching', 'work'])).toBe('watching');
    expect(parseHomeTab([])).toBe('work');
  });
});

describe('homeTabHref', () => {
  it('spells My work as the ABSENCE of the param', () => {
    // One canonical URL per tab: a link to Home and a link to My work are the
    // same link, so they cannot drift apart in a nav, a test, or a bookmark.
    expect(homeTabHref('work')).toBe('/home');
    expect(homeTabHref('watching')).toBe('/home?tab=watching');
  });

  it('carries a page cursor alongside the tab', () => {
    expect(homeTabHref('work', 'abc')).toBe('/home?cursor=abc');
    expect(homeTabHref('watching', 'abc')).toBe('/home?tab=watching&cursor=abc');
  });

  it('drops an absent cursor rather than emitting an empty param', () => {
    expect(homeTabHref('work', null)).toBe('/home');
    expect(homeTabHref('watching', '')).toBe('/home?tab=watching');
  });

  it('escapes a cursor that is not URL-safe', () => {
    // The cursor is base64url today and therefore safe, but the href builder
    // must not be the thing that assumes so.
    expect(homeTabHref('work', 'a b&c=d')).toBe('/home?cursor=a+b%26c%3Dd');
  });
});
