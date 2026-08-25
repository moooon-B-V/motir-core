// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shallowPush, shallowReplace } from '@/lib/navigation/shallowUrl';

// MOTIR-3434 — the shallow-URL helper and the three call sites that adopted it.
//
// The property under test is NEGATIVE, which is why it needs a test at all: the
// three switches must change the URL and NOT ask the server. Nothing about a
// `router.push` looks wrong, which is how three separate authors on three
// separate stories each reached for it — so the assertion is that the router is
// never called, and that `history.pushState` is.
//
// The end-to-end version of this (zero document/RSC requests across a real
// switch, and Back restoring the previous view in a real browser) belongs to the
// story's Playwright card, MOTIR-3438. What is asserted here is the URL
// CONSTRUCTION — set, unset-on-default, other params preserved — which is where
// a regression would actually be introduced and which a browser test would be a
// slow way to cover.

const pushState = vi.spyOn(window.history, 'pushState');
const replaceState = vi.spyOn(window.history, 'replaceState');

beforeEach(() => {
  pushState.mockClear();
  replaceState.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('shallowUrl (MOTIR-3434)', () => {
  it('pushes a history entry without a navigation', () => {
    shallowPush('/plans/abc?view=canvas');
    expect(pushState).toHaveBeenCalledWith(null, '', '/plans/abc?view=canvas');
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('replaces when the caller explicitly means to', () => {
    shallowReplace('/roadmap');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/roadmap');
    expect(pushState).not.toHaveBeenCalled();
  });
});

// ── The URL each switch constructs ─────────────────────────────────────────
//
// Each of the three components derives its view from `useSearchParams` and
// writes it back with the same three-step shape: copy the current params, set
// or DELETE its own key, and push `path?query` — or a bare `path` when the
// query empties. The rules that matter, and that a careless edit breaks:
//
//   · the DEFAULT value writes a CLEAN url (no param), so every existing link
//     to the page stays byte-identical;
//   · every OTHER param survives (a filter, a sort, a page, a peek);
//   · it is a PUSH, so Back undoes it.
//
// Reproduced here as the pure functions they are, so the three are asserted
// against ONE table rather than three near-identical component harnesses.

/** `ChildPanel.changeView` / `PlanDetail.onViewChange` — the set-or-delete shape. */
function switchUrl(
  pathname: string,
  current: string,
  key: string,
  next: string,
  defaultValue: string,
): string {
  const params = new URLSearchParams(current);
  if (next === defaultValue) params.delete(key);
  else params.set(key, next);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

describe('the URL each shallow switch constructs (MOTIR-3434)', () => {
  it.each([
    // [name, pathname, existing query, key, next, default, expected]
    [
      'Children → graph sets the param',
      '/items/MOTIR-1',
      '',
      'children',
      'graph',
      'list',
      '/items/MOTIR-1?children=graph',
    ],
    [
      'Children → list (the default) writes a CLEAN url',
      '/items/MOTIR-1',
      'children=graph',
      'children',
      'list',
      'list',
      '/items/MOTIR-1',
    ],
    [
      'plan detail → canvas sets the param',
      '/plans/abc',
      '',
      'view',
      'canvas',
      'list',
      '/plans/abc?view=canvas',
    ],
    [
      'plan detail → the pinned default writes a CLEAN url',
      '/plans/abc',
      'view=canvas',
      'view',
      'list',
      'list',
      '/plans/abc',
    ],
    [
      'roadmap → sprint sets the param',
      '/roadmap',
      '',
      'scope',
      'sprint',
      'project',
      '/roadmap?scope=sprint',
    ],
    [
      'roadmap → project (the default) writes a CLEAN url',
      '/roadmap',
      'scope=sprint',
      'scope',
      'project',
      'project',
      '/roadmap',
    ],
  ])('%s', (_name, pathname, current, key, next, def, expected) => {
    expect(switchUrl(pathname, current, key, next, def)).toBe(expected);
  });

  it('preserves every OTHER param — a switch is not a filter reset', () => {
    // The case that breaks if someone "simplifies" the copy into a fresh
    // URLSearchParams: the reader's filter, sort and open peek all survive.
    expect(
      switchUrl('/items/MOTIR-1', 'peek=MOTIR-9&sort=key&page=3', 'children', 'graph', 'list'),
    ).toBe('/items/MOTIR-1?peek=MOTIR-9&sort=key&page=3&children=graph');
    // …and they survive the DELETE branch too.
    expect(
      switchUrl(
        '/items/MOTIR-1',
        'peek=MOTIR-9&children=graph&sort=key',
        'children',
        'list',
        'list',
      ),
    ).toBe('/items/MOTIR-1?peek=MOTIR-9&sort=key');
  });

  it('routes the constructed URL through shallowPush, never a navigation', () => {
    const href = switchUrl('/plans/abc', 'x=1', 'view', 'canvas', 'list');
    shallowPush(href);
    expect(pushState).toHaveBeenCalledWith(null, '', '/plans/abc?x=1&view=canvas');
  });
});
