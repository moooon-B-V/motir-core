// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { REPO_ROOT, stripComments } from '../helpers/importGraph';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { clearLegalManifest, setLegalManifest } from '../helpers/legalManifest';
import { DOCS_URL_ENV, docsIndexUrl } from '@/lib/docs/links';
import { legalIndexUrl } from '@/lib/legal/links';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from '@/lib/hooks/useSidebarCollapsed';

// ═════════════════════════════════════════════════════════════════════════════
// MOTIR-4240 — THE STORY-LEVEL VITEST GATE for MOTIR-4237 (the Help menu).
//
// `HelpMenu.test.tsx` is the per-subtask floor MOTIR-4239 shipped with its code:
// it hands the component a STRING and asserts the row. That is the right test
// for that card and it is silent about everything this story actually changed,
// because the story is a RE-THREADING and every interesting failure in it lives
// at a seam a unit test stubs:
//
//   - a resolver that answers correctly while its answer never reaches the
//     anchor (an optional prop fed a hardcoded `null` compiles, and both unit
//     suites either side of it stay green);
//   - a context widened into a SECOND `ShortcutsCheatsheet` instance, or a `?`
//     key that quietly stops working — both green in isolation;
//   - a rail that keeps a departed row somewhere the component test for the
//     departed row no longer exists to notice, because that test was deleted
//     with the row (MOTIR-4239 removed `SidebarNav-docs-door.test.tsx` and
//     `SidebarNav-legal-door.test.tsx`).
//
// So this file drives the REAL resolvers, asserts ONE dialog behind TWO doors,
// and sweeps the rail in every shape it renders. It is deliberately NOT a second
// copy of the resolver suites (`tests/docs/docsLinks.test.ts`,
// `tests/legal/legalLinks.test.ts` already pin both resolvers' own arms) nor of
// the per-card floor — what it adds is the path BETWEEN them.
// ═════════════════════════════════════════════════════════════════════════════

let pathname = '/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

// Imported AFTER the `next/navigation` mock, like every other rail suite.
import {
  CommandPaletteProvider,
  useCommandPalette,
} from '@/app/(authed)/_components/CommandPaletteProvider';
import { HelpMenu } from '@/app/(authed)/_components/HelpMenu';
import { SidebarNav } from '@/app/(authed)/_components/SidebarNav';

const PROJECT = {
  id: 'p1',
  key: 'MOTIR',
  identifier: 'MOTIR',
  name: 'Motir',
  archivedAt: null,
} as unknown as ProjectDTO;

const USER = { name: 'Yue', email: 'yue@example.com' };
const ADMIN = [...BUILTIN_ROLE_PERMISSIONS.admin];
const MEMBER = [...BUILTIN_ROLE_PERMISSIONS.member];

/** A manifest whose documents share `<base>/<slug>` — `legalIndexUrl()` derives. */
const SHARED_STEM = [
  {
    slug: 'terms',
    title: 'Terms of Service',
    version: '1.0.0',
    effectiveDate: null,
    changeSummary: null,
    url: 'https://acme.example/legal/terms',
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    version: '1.0.0',
    effectiveDate: null,
    changeSummary: null,
    url: 'https://acme.example/legal/privacy',
  },
];

/**
 * A manifest of documents published at UNRELATED addresses — `legalIndexUrl()`'s
 * SECOND absent cause, and the one nothing else in this story exercises. Both
 * documents are configured and individually reachable; what does not exist is an
 * INDEX to point a single door at.
 */
const NO_SHARED_STEM = [
  {
    slug: 'terms',
    title: 'Terms of Service',
    version: '1.0.0',
    effectiveDate: null,
    changeSummary: null,
    url: 'https://acme.example/terms',
  },
  {
    slug: 'privacy',
    title: 'Privacy Policy',
    version: '1.0.0',
    effectiveDate: null,
    changeSummary: null,
    url: 'https://privacy.acme.example/privacy',
  },
];

let restoreManifest: (() => void) | undefined;

afterEach(() => {
  cleanup();
  restoreManifest?.();
  restoreManifest = undefined;
  vi.unstubAllEnvs();
  pathname = '/dashboard';
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM 1 — the REAL resolvers reach the RENDERED ANCHOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mount the menu exactly as `app/(authed)/layout.tsx` does: call the real
 * resolvers on the server side of the boundary and hand their answers down as
 * props. Nothing here is stubbed — the strings under assertion are produced by
 * `docsIndexUrl()` / `legalIndexUrl()` reading the deployment's own
 * configuration, which is the half `HelpMenu.test.tsx` cannot reach.
 */
function renderMenuFromResolvers(placement: 'footer' | 'drawer' = 'footer') {
  const docs = docsIndexUrl();
  const legal = legalIndexUrl();
  const rendered = renderWithIntl(
    <CommandPaletteProvider>
      <HelpMenu docsIndexUrl={docs} legalIndexUrl={legal} placement={placement} />
    </CommandPaletteProvider>,
  );
  return { ...rendered, resolved: { docs, legal } };
}

function openMenu() {
  act(() => {
    screen.getByRole('button', { name: 'Help' }).click();
  });
}

describe('SEAM — the real resolvers reach the rendered anchor', () => {
  it('a configured docs url is the `href` that actually renders — resolver to anchor', () => {
    vi.stubEnv(DOCS_URL_ENV, 'https://acme.example/handbook');
    restoreManifest = clearLegalManifest();

    const { resolved } = renderMenuFromResolvers();
    openMenu();

    // The resolver answered, AND the answer is what the anchor carries. Both
    // halves are asserted: a green `toBe` on the resolver alone is exactly the
    // evidence that does not distinguish a threaded prop from a dropped one.
    expect(resolved.docs).toBe('https://acme.example/handbook');
    expect(screen.getByRole('link', { name: 'Docs' }).getAttribute('href')).toBe(
      'https://acme.example/handbook',
    );
  });

  it('a REFUSED docs value (relative) renders no row — the resolver`s guard reaches the menu', () => {
    // The defect `lib/docs/links.ts` exists to cure: `/docs` names a route this
    // application no longer serves. The resolver refuses it; this asserts the
    // refusal is what the reader sees, rather than a dead link.
    vi.stubEnv(DOCS_URL_ENV, '/docs');
    restoreManifest = clearLegalManifest();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { resolved } = renderMenuFromResolvers();
    openMenu();

    expect(resolved.docs).toBeNull();
    expect(screen.queryByRole('link', { name: 'Docs' })).toBeNull();
  });

  it('an UNCONFIGURED docs url renders no row', () => {
    vi.stubEnv(DOCS_URL_ENV, undefined);
    restoreManifest = clearLegalManifest();

    const { resolved } = renderMenuFromResolvers();
    openMenu();

    expect(resolved.docs).toBeNull();
    expect(screen.queryByRole('link', { name: 'Docs' })).toBeNull();
  });

  it('a manifest sharing one stem yields the DERIVED index as the rendered `href`', () => {
    vi.stubEnv(DOCS_URL_ENV, undefined);
    restoreManifest = setLegalManifest(SHARED_STEM);

    const { resolved } = renderMenuFromResolvers();
    openMenu();

    expect(resolved.legal).toBe('https://acme.example/legal');
    expect(screen.getByRole('link', { name: 'Legal documents' }).getAttribute('href')).toBe(
      'https://acme.example/legal',
    );
  });

  // ⚠️ THE TWO ABSENT CAUSES ARE DIFFERENT FACTS AND ARE ASSERTED SEPARATELY.
  // From the rendered menu they are indistinguishable — no row, either way —
  // which is why a single "no row when legal is absent" case would pass while
  // one of them regressed.
  it('ABSENT CAUSE 1 — nothing configured: no Legal documents row', () => {
    vi.stubEnv(DOCS_URL_ENV, undefined);
    restoreManifest = clearLegalManifest();

    const { resolved } = renderMenuFromResolvers();
    openMenu();

    expect(resolved.legal).toBeNull();
    expect(screen.queryByRole('link', { name: 'Legal documents' })).toBeNull();
  });

  it('ABSENT CAUSE 2 — documents published at unrelated addresses: no Legal documents row', () => {
    vi.stubEnv(DOCS_URL_ENV, undefined);
    restoreManifest = setLegalManifest(NO_SHARED_STEM);

    const { resolved } = renderMenuFromResolvers();
    openMenu();

    // Configured — the documents exist and sign-up still links each one — but
    // there is no `<base>` they share, so there is no index for one door to
    // point at, and inventing one would send a reader nowhere anybody published.
    expect(resolved.legal).toBeNull();
    expect(screen.queryByRole('link', { name: 'Legal documents' })).toBeNull();
  });

  it('BOTH resolvers absent renders the FLOOR — Keyboard shortcuts alone, nothing marking the gaps', () => {
    vi.stubEnv(DOCS_URL_ENV, undefined);
    restoreManifest = clearLegalManifest();

    renderMenuFromResolvers();
    openMenu();

    const menu = screen.getByRole('button', { name: 'Keyboard shortcuts' }).parentElement!;
    expect(within(menu).queryAllByRole('link')).toHaveLength(0);
    expect(within(menu).getAllByRole('button')).toHaveLength(1);
    // Not disabled, not empty-stated: no text anywhere in the menu names either
    // destination.
    expect(menu.textContent).toBe('Keyboard shortcuts');
  });

  // ⚠️ THE COVERAGE FLOOR'S OWN CASES. Every branch above renders a row and
  // asserts its `href`; NONE of them activates one, so both anchors' `onClick`
  // handlers were the uncovered half of `HelpMenu.tsx` (functions at 50%). They
  // are not decoration — the popover staying open behind a navigation the reader
  // just started is the same defect the shortcuts row's own `setOpen(false)`
  // exists to prevent, one door over.
  it.each([
    ['Docs', 'https://acme.example/handbook'],
    ['Legal documents', 'https://acme.example/legal'],
  ])('activating the %s row closes the popover behind it', (name) => {
    vi.stubEnv(DOCS_URL_ENV, 'https://acme.example/handbook');
    restoreManifest = setLegalManifest(SHARED_STEM);
    // The anchors are real links to absolute urls; hold the navigation so the
    // assertion is about the component rather than about the test environment.
    // Scoped to anchors: preventing the TRIGGER's default too would stop the
    // popover opening, and the case would then pass having asserted nothing.
    const hold = (event: Event) => {
      if ((event.target as Element | null)?.closest('a[href]')) event.preventDefault();
    };
    document.addEventListener('click', hold, true);

    try {
      renderMenuFromResolvers();
      openMenu();
      expect(screen.getByRole('link', { name })).toBeTruthy();

      fireEvent.click(screen.getByRole('link', { name }));

      expect(screen.queryByRole('link', { name })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Keyboard shortcuts' })).toBeNull();
    } finally {
      document.removeEventListener('click', hold, true);
    }
  });

  it('the footer trigger centres itself once the rail COLLAPSES — its other branch', () => {
    // The rail's footer holds two controls side by side when expanded and
    // stacks them centred when it collapses, so the trigger has a collapsed arm
    // the seven cases above never render. `design/shell` draws both.
    vi.stubEnv(DOCS_URL_ENV, undefined);
    restoreManifest = clearLegalManifest();

    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'true');
    renderMenuFromResolvers();
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: SIDEBAR_COLLAPSED_STORAGE_KEY, newValue: 'true' }),
      );
    });

    try {
      expect(screen.getByRole('button', { name: 'Help' }).className).toContain('mx-auto');
    } finally {
      window.localStorage.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
      act(() => {
        window.dispatchEvent(
          new StorageEvent('storage', { key: SIDEBAR_COLLAPSED_STORAGE_KEY, newValue: 'false' }),
        );
      });
    }
  });

  it('BOTH resolvers configured renders all three rows, in the drawer placement too', () => {
    vi.stubEnv(DOCS_URL_ENV, 'https://acme.example/handbook');
    restoreManifest = setLegalManifest(SHARED_STEM);

    renderMenuFromResolvers('drawer');
    openMenu();

    expect(screen.getByRole('link', { name: 'Docs' }).getAttribute('href')).toBe(
      'https://acme.example/handbook',
    );
    expect(screen.getByRole('link', { name: 'Legal documents' }).getAttribute('href')).toBe(
      'https://acme.example/legal',
    );
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM 2 — `openShortcuts` and `?` are TWO DOORS ONTO ONE DIALOG
// ─────────────────────────────────────────────────────────────────────────────

function pressQuestionMark() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
  });
}

function cheatsheets() {
  return screen.queryAllByRole('dialog', { name: 'Keyboard shortcuts' });
}

describe('SEAM — `openShortcuts` and `?` are two doors onto one dialog', () => {
  beforeEach(() => {
    vi.stubEnv(DOCS_URL_ENV, undefined);
    restoreManifest = clearLegalManifest();
  });

  // The seam ITSELF, not the row that calls it. Before MOTIR-4239 widened the
  // context, `cheatsheetOpen` was local state and NOTHING outside the provider
  // could reach it — so `openShortcuts` on the context value is the whole of
  // what changed, and a probe holding that value tests it with no popover, no
  // focus trap and no markup in between.
  let seam: ReturnType<typeof useCommandPalette> | null = null;
  function ContextProbe() {
    seam = useCommandPalette();
    return null;
  }

  function renderShell() {
    return renderWithIntl(
      <CommandPaletteProvider>
        <ContextProbe />
        <HelpMenu />
      </CommandPaletteProvider>,
    );
  }

  afterEach(() => {
    seam = null;
  });

  it('`?` still opens the cheatsheet — the widening did not take the key away', () => {
    renderShell();
    expect(cheatsheets()).toHaveLength(0);

    pressQuestionMark();

    expect(cheatsheets()).toHaveLength(1);
  });

  it('`useCommandPalette().openShortcuts()` opens it — the seam exists and is reachable', () => {
    renderShell();
    expect(cheatsheets()).toHaveLength(0);

    act(() => seam!.openShortcuts());

    expect(cheatsheets()).toHaveLength(1);
  });

  it('the menu row opens it too — the seam has a door in the UI', () => {
    renderShell();
    openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));

    expect(cheatsheets()).toHaveLength(1);
  });

  // ⚠️ THE ASSERTIONS THAT ACTUALLY DISTINGUISH ONE DIALOG FROM TWO. A second
  // `ShortcutsCheatsheet` instance is green in every test above: each door opens
  // "a" dialog and the suite is satisfied. Driving BOTH doors, in both orders,
  // and counting is what tells them apart.
  it('the seam, called while `?` has it OPEN, mounts no second instance', () => {
    renderShell();

    pressQuestionMark();
    expect(cheatsheets()).toHaveLength(1);

    act(() => seam!.openShortcuts());

    expect(cheatsheets()).toHaveLength(1);
  });

  it('`?`, pressed while the SEAM has it open, mounts no second instance either', () => {
    renderShell();

    act(() => seam!.openShortcuts());
    expect(cheatsheets()).toHaveLength(1);

    pressQuestionMark();

    expect(cheatsheets()).toHaveLength(1);
  });

  it('the two doors render the SAME dialog — identical markup, not merely a dialog each', () => {
    renderShell();

    pressQuestionMark();
    const viaKey = cheatsheets()[0]!.outerHTML;
    fireEvent.keyDown(cheatsheets()[0]!, { key: 'Escape' });
    expect(cheatsheets()).toHaveLength(0);

    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    const viaRow = cheatsheets()[0]!.outerHTML;

    // Byte-identical: one component, one set of props, one source of rows. A
    // second cheatsheet built for the menu would differ here long before it
    // differed anywhere a person would notice.
    expect(viaRow).toBe(viaKey);
  });

  it('the row closes the popover it was activated from — it does not linger behind the dialog', () => {
    renderShell();
    openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));

    expect(cheatsheets()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Keyboard shortcuts' })).toBeNull();
  });

  it('`?` still works AFTER the row has opened and closed it — the shared state resets both ways', () => {
    renderShell();
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }));
    fireEvent.keyDown(cheatsheets()[0]!, { key: 'Escape' });
    expect(cheatsheets()).toHaveLength(0);

    pressQuestionMark();

    expect(cheatsheets()).toHaveLength(1);
  });

  // ⚠️ THE OTHER TWO MEMBERS OF THE WIDENED CONTEXT, and the coverage floor's
  // own cases for this file. `openShortcuts` is the seam this story added, but a
  // gate that covers only the new member leaves the value object's OTHER
  // callable and its guard uncovered — and the guard is the one that turns a
  // provider-less mount from a `null` dereference deep in a menu into a sentence
  // naming the missing provider.
  it('`openCommandPalette()` is still reachable on the same value, and still opens the palette', () => {
    renderShell();
    expect(seam!.open).toBe(false);

    act(() => seam!.openCommandPalette());

    expect(seam!.open).toBe(true);
    // Widening the context did not couple the two: the palette opening leaves
    // the cheatsheet closed.
    expect(cheatsheets()).toHaveLength(0);
  });

  it('`useCommandPalette()` outside the provider throws, naming the provider', () => {
    function Orphan() {
      useCommandPalette();
      return null;
    }
    // React logs the thrown render error; the assertion is the throw itself.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderWithIntl(<Orphan />)).toThrow(
      'useCommandPalette must be used inside <CommandPaletteProvider>',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEAM 3 — the rail's REMAINING section, and the two departures
// ─────────────────────────────────────────────────────────────────────────────

function renderRail({
  permissions = ADMIN,
  project = PROJECT as ProjectDTO | null,
  workspaceTierRevealed = false,
  variant = 'rail' as 'rail' | 'drawer',
}: {
  permissions?: readonly PermissionKey[];
  project?: ProjectDTO | null;
  workspaceTierRevealed?: boolean;
  variant?: 'rail' | 'drawer';
} = {}) {
  return renderWithIntl(
    <SidebarNav
      activeProject={project}
      variant={variant}
      settingsPermissions={permissions}
      user={USER}
      workspaceTierRevealed={workspaceTierRevealed}
    />,
  );
}

/**
 * The rail's BOTTOM section, read off the rendered tree rather than off the
 * source: `Sidebar` separates its sections with `role="separator"` divs, so the
 * bottom section is every row after the LAST separator — and the whole nav when
 * there is no primary section to separate from (the no-project rail).
 */
function bottomSectionRowNames(): string[] {
  const nav = screen.getByRole('navigation');
  const separators = [...nav.querySelectorAll('[role="separator"]')];
  const last = separators.at(-1) ?? null;
  const links = [...nav.querySelectorAll('a')];
  const afterLast = last
    ? links.filter(
        (a) => (last.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      )
    : links;
  // Collapsed rows carry the label as `aria-label`; expanded rows carry it as
  // text. Read whichever is there, so one helper serves both widths.
  return afterLast.map((a) => (a.getAttribute('aria-label') ?? a.textContent ?? '').trim());
}

describe('SEAM — the rail keeps exactly the four rows the two departures left', () => {
  it('is exactly Settings · Security · Job runs · Git, in that order', () => {
    renderRail({ workspaceTierRevealed: true });

    expect(bottomSectionRowNames()).toEqual(['Settings', 'Security', 'Job runs', 'Git']);
  });

  it('its FLOOR is exactly Job runs · Git — unchanged by the two departures', () => {
    // Both departing rows were already conditional, which is why this move costs
    // an unconfigured deployment nothing: the floor is what it was before.
    renderRail({ permissions: MEMBER, workspaceTierRevealed: false });

    expect(bottomSectionRowNames()).toEqual(['Job runs', 'Git']);
  });

  it('the section is FOUR rows at most — nothing re-appeared beside them', () => {
    renderRail({ workspaceTierRevealed: true });

    expect(bottomSectionRowNames()).toHaveLength(4);
  });

  // ⚠️ THE SWEEP. `SidebarNav-docs-door.test.tsx` and
  // `SidebarNav-legal-door.test.tsx` were the tests that watched these two rows,
  // and MOTIR-4239 deleted them with the rows — so without this case the rail
  // has NO assertion that the destinations stayed gone, in any of the six shapes
  // it renders. A re-added row would be green everywhere else.
  const SHAPES: Array<[string, () => void]> = [
    ['the default rail, with a project', () => renderRail({ workspaceTierRevealed: true })],
    ['the default rail, no project', () => renderRail({ project: null })],
    ['a member’s rail (no settings door)', () => renderRail({ permissions: MEMBER })],
    ['the drawer', () => renderRail({ variant: 'drawer' })],
    [
      'the project-settings AREA',
      () => {
        pathname = '/settings/project';
        renderRail({ workspaceTierRevealed: true });
      },
    ],
    [
      'the account-settings AREA',
      () => {
        pathname = '/settings/account';
        renderRail({ workspaceTierRevealed: true });
      },
    ],
    [
      'the COLLAPSED rail, where labels are `aria-label`s',
      () => {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, 'true');
        renderRail({ workspaceTierRevealed: true });
        act(() => {
          window.dispatchEvent(
            new StorageEvent('storage', {
              key: SIDEBAR_COLLAPSED_STORAGE_KEY,
              newValue: 'true',
            }),
          );
        });
      },
    ],
  ];

  it.each(SHAPES)('%s names neither departed destination', (_name, render) => {
    render();
    const nav = screen.getByRole('navigation');

    expect(nav.textContent).not.toMatch(/\bdocs\b/i);
    expect(nav.textContent).not.toMatch(/\blegal\b/i);
    for (const element of nav.querySelectorAll('[aria-label]')) {
      expect(element.getAttribute('aria-label')).not.toMatch(/\b(docs|legal)\b/i);
    }
    for (const anchor of nav.querySelectorAll('a[href]')) {
      expect(anchor.getAttribute('href')).not.toMatch(/(^|\/)(docs|legal)(\/|$)/i);
    }
  });

  afterEach(() => {
    window.localStorage.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', { key: SIDEBAR_COLLAPSED_STORAGE_KEY, newValue: 'false' }),
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT GUARDS — what a coverage percentage cannot see
// ─────────────────────────────────────────────────────────────────────────────

type Catalog = Record<string, Record<string, unknown>>;

function shellNamespace(messages: unknown, name: string): Record<string, unknown> {
  const shell = (messages as Catalog)['shell'] as Record<string, unknown>;
  return (shell[name] ?? {}) as Record<string, unknown>;
}

describe('CONTRACT — the catalogs are total and parallel', () => {
  it('every `shell.help.*` key exists in BOTH catalogs, with no key in only one', () => {
    const en = Object.keys(shellNamespace(enMessages, 'help')).sort();
    const zh = Object.keys(shellNamespace(zhMessages, 'help')).sort();

    expect(en).toEqual(['docs', 'label', 'legal', 'shortcuts']);
    // TOTALITY both ways: `toEqual` on sorted key lists fails on a key present
    // in either catalog alone, which is the drift a per-key lookup misses.
    expect(zh).toEqual(en);
  });

  it('`shell.help.legal` is pinned to "Legal documents" / "法律文件"', () => {
    // ⚠️ THE STRING IS THE POINT OF THE RENAME. `labels.workItemType.legal` is
    // already `Legal` in the same English catalog — the work-item TYPE — and it
    // renders to the same signed-in reader. A later edit "simplifying" this back
    // to `Legal` reads as harmless and re-introduces the collision, inside a menu
    // called Help where the bare noun means "help me with a legal issue".
    expect(shellNamespace(enMessages, 'help')['legal']).toBe('Legal documents');
    expect(shellNamespace(zhMessages, 'help')['legal']).toBe('法律文件');
    // The collision it is being told apart FROM, still present and still `Legal`.
    expect(
      ((enMessages as Catalog)['labels']!['workItemType'] as Record<string, unknown>)['legal'],
    ).toBe('Legal');
  });

  it('`shell.nav.legal` and `shell.nav.docs` exist in NEITHER catalog', () => {
    for (const [locale, messages] of [
      ['en', enMessages],
      ['zh', zhMessages],
    ] as const) {
      const nav = shellNamespace(messages, 'nav');
      expect(Object.keys(nav), `${locale}: shell.nav still carries a departed key`).not.toContain(
        'docs',
      );
      expect(Object.keys(nav), `${locale}: shell.nav still carries a departed key`).not.toContain(
        'legal',
      );
    }
  });

  it('the other three help strings are non-empty in both catalogs', () => {
    for (const messages of [enMessages, zhMessages]) {
      const help = shellNamespace(messages, 'help');
      for (const key of ['label', 'docs', 'shortcuts']) {
        expect(typeof help[key]).toBe('string');
        expect((help[key] as string).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('CONTRACT — `SidebarNav` carries neither departed prop', () => {
  it('rejects them at the type level', () => {
    // The compile-time half, checked by `pnpm typecheck`: `@ts-expect-error`
    // FAILS the build if the props are ever re-added, so this case cannot rot
    // into a vacuous pass.
    const rejected = (
      <SidebarNav
        activeProject={PROJECT}
        user={USER}
        // @ts-expect-error — `docsIndexUrl` left this component for `HelpMenu`.
        docsIndexUrl="https://acme.example/handbook"
      />
    );
    const alsoRejected = (
      <SidebarNav
        activeProject={PROJECT}
        user={USER}
        // @ts-expect-error — `legalIndexUrl` left this component for `HelpMenu`.
        legalIndexUrl="https://acme.example/legal"
      />
    );
    expect(rejected).toBeTruthy();
    expect(alsoRejected).toBeTruthy();
  });

  it('ignores them at run time — a stale caller threads nothing into the rail', () => {
    // The runtime half. A JavaScript caller, or a `as any` one, gets no row: the
    // props are not merely absent from the type, they reach no markup.
    const stale = {
      docsIndexUrl: 'https://acme.example/handbook',
      legalIndexUrl: 'https://acme.example/legal',
    } as Record<string, string>;
    renderWithIntl(
      <SidebarNav
        activeProject={PROJECT}
        user={USER}
        workspaceTierRevealed
        settingsPermissions={ADMIN}
        {...stale}
      />,
    );

    expect(bottomSectionRowNames()).toEqual(['Settings', 'Security', 'Job runs', 'Git']);
    expect(screen.getByRole('navigation').textContent).not.toMatch(/\b(docs|legal)\b/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT — the LAYOUT's threading, which is the half a render cannot reach
// ─────────────────────────────────────────────────────────────────────────────

describe('CONTRACT — the layout resolves both urls and threads them to the MENU', () => {
  // `app/(authed)/layout.tsx` is an async Server Component over a session, a
  // workspace context and half a dozen service reads — there is no unit render
  // of it, and the seam it owns is one assignment wide: resolver → local →
  // prop. That assignment is exactly what a "green resolver + green component"
  // pair cannot see, so it is asserted from the source, with comments blanked so
  // a sentence about a prop is never mistaken for the prop.
  const source = stripComments(readFileSync(join(REPO_ROOT, 'app/(authed)/layout.tsx'), 'utf8'));

  it('calls BOTH real resolvers', () => {
    expect(source).toMatch(/const\s+legalIndexUrl\s*=\s*resolveLegalIndexUrl\(\)/);
    expect(source).toMatch(/const\s+docsIndexUrl\s*=\s*resolveDocsIndexUrl\(\)/);
    expect(source).toMatch(
      /import\s*\{[^}]*legalIndexUrl as resolveLegalIndexUrl[^}]*\}\s*from\s*'@\/lib\/legal\/links'/,
    );
    expect(source).toMatch(
      /import\s*\{[^}]*docsIndexUrl as resolveDocsIndexUrl[^}]*\}\s*from\s*'@\/lib\/docs\/links'/,
    );
  });

  it('threads both into `HelpMenu` in BOTH of its homes — the footer and the drawer strip', () => {
    const helpMenus = [...source.matchAll(/<HelpMenu\b[\s\S]*?\/>/g)].map((m) => m[0]);

    // Two homes, because the shell renders two different things at the two width
    // bands and a footer-only control vanishes at phone width.
    expect(helpMenus).toHaveLength(2);
    for (const element of helpMenus) {
      expect(element).toMatch(/docsIndexUrl=\{docsIndexUrl\}/);
      expect(element).toMatch(/legalIndexUrl=\{legalIndexUrl\}/);
    }
    expect(helpMenus.some((e) => /placement="drawer"/.test(e))).toBe(true);
  });

  it('threads NEITHER into `SidebarNav` — the rows left that component', () => {
    // ⚠️ ONE `<SidebarNav>` NESTS A `<HelpMenu>` IN ITS `helpMenu` PROP, so a
    // non-greedy match to the first `/>` stops inside the child and reads the
    // child's props as the parent's. Remove the (separately asserted) HelpMenu
    // elements first, and what is left is the rail's own attribute list.
    const withoutMenus = source.replace(/<HelpMenu\b[\s\S]*?\/>/g, '');
    const rails = [...withoutMenus.matchAll(/<SidebarNav\b[\s\S]*?\/>/g)].map((m) => m[0]);

    // Both homes render one: the rail at `≥ md` and the drawer below it.
    expect(rails).toHaveLength(2);
    for (const element of rails) {
      expect(element).not.toMatch(/docsIndexUrl/);
      expect(element).not.toMatch(/legalIndexUrl/);
    }
  });
});
