// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import type { AiCalloutAction } from '@/lib/planning/aiCallout';
import type { PlanningLaunchContext } from '@/lib/planning/launcher';
import { PlanWithAIFab } from '@/components/planning/PlanWithAIFab';

// The "M" universal AI callout (MOTIR-1812) — the orb is now the TRIGGER for an
// anchored menu, and "Plan with AI" is the first ROW inside it. Driven under
// happy-dom: the orb + menu are pure client UI over the launcher's href, so no
// DB / network is involved.

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
    aiCalloutActions: (context: PlanningLaunchContext) =>
      registryOverride.current ?? actual.aiCalloutActions(context),
  };
});

afterEach(() => {
  registryOverride.current = null;
  cleanup();
});

function orb() {
  return screen.getByRole('button', { name: 'Motir AI' });
}

describe('the "M" orb as the callout trigger', () => {
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
    expect(row.getAttribute('href')).toBe('/planning?mode=project&from=project');
    expect(screen.getByText('Generate, expand or re-plan the project')).toBeTruthy();
  });

  it('renders one row per REGISTERED action — no dead "coming soon" rows', () => {
    renderWithIntl(<PlanWithAIFab />);
    fireEvent.click(orb());

    const panel = screen.getByRole('dialog', { name: 'Motir AI' });
    expect(panel.querySelectorAll('a[data-action]')).toHaveLength(1);
    expect(panel.querySelector('a[data-action="plan"]')).not.toBeNull();
  });

  it('carries the originating context into the row href', () => {
    renderWithIntl(<PlanWithAIFab context={{ kind: 'roadmap' }} />);
    fireEvent.click(orb());

    expect(screen.getByRole('link', { name: /Plan with AI/ }).getAttribute('href')).toBe(
      '/planning?mode=roadmap&from=roadmap',
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
        href: '/planning?mode=project&from=project',
      },
      {
        id: 'ask',
        icon: 'message-circle-question',
        titleKey: 'aiCallout.name',
        descriptionKey: 'aiCallout.actions.plan.description',
        href: '/planning?mode=project&from=project',
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
