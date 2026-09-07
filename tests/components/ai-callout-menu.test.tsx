// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { AiCalloutAction } from '@/lib/planning/aiCallout';
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

// The "M" universal AI callout (MOTIR-1812) — the orb is now the TRIGGER for an
// anchored menu, and "Plan with AI" is the first ROW inside it. Driven under
// happy-dom: the orb + menu are pure client UI over the launcher's href, so no
// DB / network is involved.

// ⚠️ THE LITERAL ADDRESSES BELOW ARE RE-POINTED (MOTIR-4730). Every row used to
// carry `/planning?mode=…&from=…` — a destination. The workspace is an overlay
// now, so a row carries the CURRENT page (`/backlog` under the router mock
// above) plus the overlay's four namespaced parameters. The property the
// assertions are for is unchanged: one href, and the context is in it.
//
// The registry is the menu's only input, so a future action can be simulated by
// overriding it — which is exactly the extension contract this card owes
// (MOTIR-1343 / MOTIR-1344 add ONE entry, and nothing else changes). Left null,
// every test above runs against the REAL registry.
const { registryOverride } = vi.hoisted(() => ({
  registryOverride: { current: null as AiCalloutAction[] | null },
}));

vi.mock('@/lib/planning/aiCallout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/aiCallout')>();
  return {
    ...actual,
    // ⚠️ `aiCalloutActions` takes the resolved OVERLAY href now (MOTIR-4730),
    // not a context — the workspace is a layer on the current page.
    aiCalloutActions: (href: string) => registryOverride.current ?? actual.aiCalloutActions(href),
  };
});

afterEach(() => {
  registryOverride.current = null;
  cleanup();
});

function orb() {
  return screen.getByRole('button', { name: 'Motir AI' });
}

describe('the Motir orb as the callout trigger', () => {
  it('is a BUTTON named after the callout — "Plan with AI" moved inside', () => {
    renderWithIntl(<PlanWithAIFab />);

    const trigger = orb();
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // The orb no longer navigates, and the closed callout adds NO second
    // "Plan with AI" link to the page (the referrer sweep the E2E depends on).
    expect(screen.queryByRole('link', { name: 'Plan with AI' })).toBeNull();
  });

  it('keeps the shipped orb visuals — position, size, circle and the pulse aura', () => {
    const { container } = renderWithIntl(<PlanWithAIFab />);

    const trigger = orb();
    for (const cls of ['fixed', 'right-5', 'bottom-5', 'z-40', 'h-14', 'w-14', 'rounded-full']) {
      expect(trigger.className).toContain(cls);
    }
    expect(container.querySelector('.plan-with-ai-fab-pulse')).not.toBeNull();
  });
});

describe('the callout menu', () => {
  it('opens on click and shows the "Motir AI" header + the Plan with AI row', () => {
    renderWithIntl(<PlanWithAIFab />);
    fireEvent.click(orb());

    expect(orb().getAttribute('aria-expanded')).toBe('true');
    const panel = screen.getByRole('dialog', { name: 'Motir AI' });
    expect(panel).toBeTruthy();

    const row = screen.getByRole('link', { name: /Plan with AI/ });
    expect(row.getAttribute('href')).toBe('/backlog?plan=project&planFrom=project');
    expect(screen.getByText('Generate, expand or re-plan the project')).toBeTruthy();
  });

  it('renders one row per REGISTERED action — no dead "coming soon" rows', () => {
    renderWithIntl(<PlanWithAIFab />);
    fireEvent.click(orb());

    const panel = screen.getByRole('dialog', { name: 'Motir AI' });
    // Two capabilities have landed: `plan` (MOTIR-1812) and `ask` (MOTIR-1343).
    // `help` (MOTIR-1344) is deliberately absent until it exists — a row appears
    // when its capability does, never before.
    expect(panel.querySelectorAll('a[data-action]')).toHaveLength(2);
    expect(panel.querySelector('a[data-action="plan"]')).not.toBeNull();
    expect(panel.querySelector('a[data-action="ask"]')).not.toBeNull();
    expect(panel.querySelector('a[data-action="help"]')).toBeNull();
  });

  it('⭐ every row shares ONE href — the menu is a capability list, not a router', () => {
    // The load-bearing assertion of the whole surface (design-notes.md § "EVERY
    // ROW OPENS THE SAME SURFACE"): the hrefs are EQUAL, not merely both
    // navigable. A second destination here would be the ask "mode" the design
    // deliberately does not have, arriving through the door.
    renderWithIntl(<PlanWithAIFab context={{ kind: 'roadmap' }} />);
    fireEvent.click(orb());

    const panel = screen.getByRole('dialog', { name: 'Motir AI' });
    const hrefs = [...panel.querySelectorAll('a[data-action]')].map((a) => a.getAttribute('href'));
    expect(hrefs).toHaveLength(2);
    expect(new Set(hrefs).size).toBe(1);
    // …and no row carries a mode or intent of its own.
    for (const href of hrefs) {
      expect(href).toBe('/backlog?plan=roadmap&planFrom=roadmap');
      expect(href).not.toContain('intent=');
      expect(href).not.toContain('mode=ask');
    }
  });

  it('the ask row carries the icon and copy the design specifies', () => {
    renderWithIntl(<PlanWithAIFab />);
    fireEvent.click(orb());

    const row = screen.getByRole('link', { name: /Ask about this project/ });
    expect(row.getAttribute('data-action')).toBe('ask');
    expect(screen.getByText('Answer questions about the plan, docs and work items')).toBeTruthy();
    // Position 2: the primary tile marks position 1, and `help` takes 3.
    const panel = screen.getByRole('dialog', { name: 'Motir AI' });
    expect([...panel.querySelectorAll('a[data-action]')].indexOf(row)).toBe(1);
  });

  it('carries the originating context into the row href', () => {
    renderWithIntl(<PlanWithAIFab context={{ kind: 'roadmap' }} />);
    fireEvent.click(orb());

    expect(screen.getByRole('link', { name: /Plan with AI/ }).getAttribute('href')).toBe(
      '/backlog?plan=roadmap&planFrom=roadmap',
    );
  });

  it('closes when a row is selected', async () => {
    renderWithIntl(<PlanWithAIFab />);
    fireEvent.click(orb());
    fireEvent.click(screen.getByRole('link', { name: /Plan with AI/ }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Motir AI' })).toBeNull();
    });
    expect(orb().getAttribute('aria-expanded')).toBe('false');
  });

  it('grows by a SINGLE registry entry — a new action needs no component change', () => {
    // The shape MOTIR-1343 will add: one more entry, two more message keys.
    // The menu renders it with the reserved icon and the non-primary tile ink,
    // pointing at the SAME one surface — no edit to `AiCalloutMenu` or the orb.
    registryOverride.current = [
      {
        id: 'plan',
        icon: 'sparkles',
        titleKey: 'aiCallout.actions.plan.title',
        descriptionKey: 'aiCallout.actions.plan.description',
        href: '/backlog?plan=project&planFrom=project',
      },
      {
        id: 'ask',
        icon: 'message-circle-question',
        titleKey: 'aiCallout.name',
        descriptionKey: 'aiCallout.actions.plan.description',
        href: '/backlog?plan=project&planFrom=project',
      },
    ];

    renderWithIntl(<PlanWithAIFab />);
    fireEvent.click(orb());

    const panel = screen.getByRole('dialog', { name: 'Motir AI' });
    const rows = panel.querySelectorAll('a[data-action]');
    expect([...rows].map((r) => r.getAttribute('data-action'))).toEqual(['plan', 'ask']);
    // Only the LEADING row carries the filled tile — the follower takes the
    // accent tint with its on-surface ink.
    const tiles = panel.querySelectorAll('a[data-action] > span[aria-hidden]');
    expect(tiles[0]?.className).toContain('text-(--el-accent-text)');
    expect(tiles[1]?.className).toContain('text-(--el-accent-on-surface)');
  });

  it('closes on Escape and returns focus to the orb', async () => {
    renderWithIntl(<PlanWithAIFab />);
    fireEvent.click(orb());
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Motir AI' })).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(orb());
    });
  });
});
