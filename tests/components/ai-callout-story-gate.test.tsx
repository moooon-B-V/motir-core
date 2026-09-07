// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl, enMessages } from '../helpers/renderWithIntl';
import { aiCalloutActions } from '@/lib/planning/aiCallout';
import { planningOverlaySearch, type PlanningLaunchContext } from '@/lib/planning/launcher';
import { PlanWithAIFab } from '@/components/planning/PlanWithAIFab';

// The doors resolve their href from the CURRENT address now (MOTIR-4730), so
// these need a router. `usePathname` / `useSearchParams` are all the hook reads.
const pathname = '/backlog';
const searchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// ⚠️ RE-POINTED (MOTIR-4730). The registry takes the resolved OVERLAY address
// now, not a context. These seams are about registry → menu → catalog, so they
// hand it the address a door on this page would actually write.
function overlayHref(context: PlanningLaunchContext, page = '/backlog'): string {
  return `${page}?${planningOverlaySearch(context).toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Story 7.24 · MOTIR-1813 — the ASSEMBLED SEAMS half of the story gate: the
// registry's REAL output driven back through its REAL consumers.
//
// The shell's own suite (`tests/components/ai-callout-menu.test.tsx`) mocks
// `@/lib/planning/aiCallout` so it can simulate a future action, and pins the
// shipped row against literal strings. That is the right shape for a unit — and
// it is exactly why it cannot be the seam: a registry key the catalog does not
// carry, or a registry href that stopped agreeing with `lib/planning/launcher.ts`,
// both survive a fixture. So this file installs NO mock. Every assertion below
// runs the shipped registry through the shipped menu, and every expected value
// is COMPUTED from the shipped modules rather than typed out — which is what
// makes them survive MOTIR-1343 / MOTIR-1344 adding a row.
//
// Not repeated here (the shell's units own them): the orb's markup and pulse,
// open-on-click, close-on-select, Escape-to-dismiss, and the simulated
// two-action render. The one behaviour of the set nothing drove is
// OUTSIDE-CLICK dismissal, which is asserted below.
// ─────────────────────────────────────────────────────────────────────────────

const shell = (enMessages as unknown as Record<string, unknown>)['shell'];

/** The English copy a message key resolves to — read from the real catalog. */
function copy(key: string): string {
  const leaf = key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      shell,
    );
  if (typeof leaf !== 'string') throw new Error(`shell.${key} is not a string`);
  return leaf;
}

function orb(): HTMLElement {
  return screen.getByRole('button', { name: copy('aiCallout.name') });
}

function openCallout(): HTMLElement {
  fireEvent.click(orb());
  return screen.getByRole('dialog', { name: copy('aiCallout.name') });
}

/**
 * Radix's dismissable layer attaches its `pointerdown` listener inside a
 * `setTimeout(…, 0)`, so that the very click which OPENED the panel cannot
 * immediately close it again. A synchronous outside click therefore lands
 * before anything is listening — which is a property of the test, not of the
 * product. Yield one macrotask so the layer is actually armed.
 */
async function armDismissLayer(): Promise<void> {
  // The yield runs inside `act` because arming the layer also settles Radix's
  // own presence/popper/focus-scope effects; outside an act scope those updates
  // land after the assertions that follow.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function rows(panel: HTMLElement): HTMLAnchorElement[] {
  return [...panel.querySelectorAll<HTMLAnchorElement>('a[data-action]')];
}

afterEach(cleanup);

// ─────────── Seam 1 — registry → menu ───────────

describe('the menu renders the REAL registry, row for row', () => {
  it('gives every registered action exactly one row, in registry order', () => {
    const context: PlanningLaunchContext = { kind: 'project' };
    const actions = aiCalloutActions(overlayHref(context));

    renderWithIntl(<PlanWithAIFab context={context} />);
    const panel = openCallout();

    // Derived from the registry, not asserted against a hardcoded count: when
    // MOTIR-1343 lands its entry, this test covers the new row automatically —
    // and fails the day a registered action renders zero rows or two.
    expect(rows(panel).map((r) => r.dataset['action'])).toEqual(actions.map((a) => a.id));
    for (const action of actions) {
      expect(
        panel.querySelectorAll(`a[data-action="${action.id}"]`),
        `one row for "${action.id}"`,
      ).toHaveLength(1);
    }
  });

  it('resolves each row’s title AND description through the shipped catalog', () => {
    const actions = aiCalloutActions(overlayHref({ kind: 'project' }));

    renderWithIntl(<PlanWithAIFab />);
    const panel = openCallout();

    // The seam a key added to the registry but missing from the catalog breaks:
    // next-intl renders the raw key, the row still exists, and only a comparison
    // against the CATALOG's own value notices.
    for (const action of actions) {
      const row = panel.querySelector<HTMLAnchorElement>(`a[data-action="${action.id}"]`)!;
      const title = copy(action.titleKey);
      const description = copy(action.descriptionKey);

      expect(row.textContent, `${action.id} title`).toContain(title);
      expect(row.textContent, `${action.id} description`).toContain(description);
      // …and neither is the key itself leaking through as its own value.
      expect(title).not.toBe(action.titleKey);
      expect(description).not.toBe(action.descriptionKey);
    }
  });

  it('offers ONLY registered actions — the panel adds no row of its own', () => {
    renderWithIntl(<PlanWithAIFab />);
    const panel = openCallout();

    // Every link inside the panel is a registry row: a hand-added footer link
    // ("Learn more", "Coming soon") would be a destination the registry never
    // authorised, and the design forbids exactly that.
    expect(panel.querySelectorAll('a')).toHaveLength(
      aiCalloutActions(overlayHref({ kind: 'project' })).length,
    );
  });
});

// ─────────── Seam 2 — registry → launcher ───────────

describe('every row’s href is the launcher’s own OVERLAY address', () => {
  const CONTEXTS: PlanningLaunchContext[] = [
    { kind: 'project' },
    { kind: 'project', hasPlan: true },
    { kind: 'work-item', itemKey: 'MOTIR-1813' },
    { kind: 'roadmap' },
    { kind: 'convention-refine', repoKey: 'motir-core' },
  ];

  it.each(CONTEXTS)('renders %j through the launcher, not a copy of it', (context) => {
    // Computed from the SHIPPED launcher module and compared against what the
    // DOM actually carries — so the day the overlay's query shape changes (or a
    // door stops resolving through the launcher), this fails instead of silently
    // rendering a stale address that literal-string assertions would happily
    // keep confirming.
    //
    // ⚠️ RE-POINTED (MOTIR-4730): the expected value is now the CURRENT PAGE
    // plus the overlay's parameters, not `/planning?…`. Every row still shares
    // exactly one of them, which is the invariant this test is really for.
    const expected = overlayHref(context);

    renderWithIntl(<PlanWithAIFab context={context} />);
    const panel = openCallout();

    const hrefs = rows(panel).map((r) => r.getAttribute('href'));
    expect(hrefs.length).toBeGreaterThan(0);
    // One destination, shared by every row — the callout is a capability list,
    // not a router.
    expect([...new Set(hrefs)]).toEqual([expected]);
  });

  it('defaults to the project entrance when the orb is mounted without a context', () => {
    renderWithIntl(<PlanWithAIFab />);
    const panel = openCallout();

    expect(rows(panel)[0]?.getAttribute('href')).toBe(overlayHref({ kind: 'project' }));
  });
});

// ─────────── Seam 3 — orb → menu: outside-click dismissal ───────────

describe('the callout dismisses on an outside click', () => {
  it('closes, collapses the trigger, and leaves focus where the user put it', async () => {
    // The orb is non-modal and floats over live content, so a click on the page
    // behind it is the most common way a user leaves the panel — more common
    // than Escape (which the shell's suite drives). Nothing covered it.
    renderWithIntl(<PlanWithAIFab />);
    openCallout();
    expect(orb().getAttribute('aria-expanded')).toBe('true');
    await armDismissLayer();

    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: copy('aiCallout.name') })).toBeNull();
    });
    // The trigger must go back to collapsed, or the orb keeps announcing an open
    // panel that is no longer there.
    expect(orb().getAttribute('aria-expanded')).toBe('false');

    // Focus does NOT snap back to the orb here — and that is the correct
    // contract, not an oversight. Escape is a request to go back, so it restores
    // focus to the trigger (the shell's suite asserts exactly that); an outside
    // click is a request to go THERE, so focus follows the click. Yanking it
    // back to a floating orb in the corner would fight the user's own pointer.
    // Pinned rather than left implicit, because "restore focus on close" is the
    // reflex a future edit would reach for.
    expect(document.activeElement).not.toBe(orb());
  });

  it('stays open when the click lands INSIDE the panel', async () => {
    // The complement, and the reason the guard above cannot just be "any
    // pointerdown closes it": the header is not a row, and clicking it (or the
    // panel padding) must not dismiss the menu the user is reading. Armed the
    // same way, so this is a genuine inside/outside discrimination rather than a
    // pass bought by an unarmed listener.
    renderWithIntl(<PlanWithAIFab />);
    const panel = openCallout();
    await armDismissLayer();

    fireEvent.pointerDown(panel);
    fireEvent.click(panel);

    expect(screen.getByRole('dialog', { name: copy('aiCallout.name') })).toBeTruthy();
    expect(orb().getAttribute('aria-expanded')).toBe('true');
  });
});
