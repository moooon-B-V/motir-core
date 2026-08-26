// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { SettingsPaneFrame } from '@/components/settings/SettingsPaneFrame';

// MOTIR-3558 — the settings family's arrival frame, and the two route-level
// skeletons it replaces.
//
// What is worth asserting is narrow. The component has no behaviour, so a test
// walking its markup would restate it. Four things CAN break silently:
//
//   1. The HEADER OMISSION. It is the family's substantive difference from the
//      generic frame, and 31 routes depend on it: a settings pane's title and
//      subtitle are both resolved by the gate and painted above the boundary,
//      so a title bar here would cover a string that already exists.
//   2. The COMPOSITION. The wrapper, the 120ms reveal, the pulse and the single
//      `aria-busy` announcement come from `PageSkeleton`. If this module ever
//      re-drew them, the family would get a second reveal at a second time.
//   3. The DELETIONS, and their replacement. Removing the two `loading.tsx`
//      files without giving those pages the in-page frame leaves two panes
//      worse than we found them, and nothing else in the repo would say so.
//   4. NO WIDTH OF ITS OWN. The column is the page's; a `mx-auto`/`max-w-*`
//      here would be a second, drifting constraint.

const ROOT = resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** Source with comments stripped — a claim in prose is not a claim in code. */
const code = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const PAGES = [
  'app/(authed)/settings/project/fields/page.tsx',
  'app/(authed)/settings/project/components/page.tsx',
] as const;

afterEach(cleanup);

describe('SettingsPaneFrame (MOTIR-3558)', () => {
  it('draws NO header — the assertion all 31 settings routes depend on', () => {
    const { container } = renderWithIntl(<SettingsPaneFrame />);
    // No <header>, and neither of PageSkeleton's generic placeholder bars.
    expect(container.querySelector('header')).toBeNull();
    expect(container.querySelectorAll('.h-8').length).toBe(0);
    expect(container.querySelectorAll('.w-56').length).toBe(0);
    expect(container.querySelectorAll('.w-80').length).toBe(0);
  });

  it('composes PageSkeleton — the reveal, the pulse and ONE announcement are inherited', () => {
    const { container } = renderWithIntl(<SettingsPaneFrame />);
    const frame = container.querySelector('[data-testid="page-skeleton"]');
    expect(frame).not.toBeNull();
    expect(frame!.className).toContain('nav-pending-reveal');
    expect(frame!.className).toContain('nav-pending-frame');
    expect(frame!.getAttribute('aria-busy')).toBe('true');
    // Announced once, not once per block, and not re-declared here.
    expect(screen.getAllByText('Loading page')).toHaveLength(1);
    expect(container.querySelector('.animate-pulse')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws the card stand-in: the bordered box, the label + action row, three rows', () => {
    const { container } = renderWithIntl(<SettingsPaneFrame />);
    const card = container.querySelector('[data-testid="settings-pane-frame"]')!;
    expect(card).not.toBeNull();
    expect(card.className).toContain('rounded-(--radius-card)');
    expect(card.className).toContain('border-(--el-border)');
    expect(card.className).toContain('p-(--spacing-card-padding)');
    // The label bar and the action bar.
    expect(card.querySelector('.h-4')).not.toBeNull();
    expect(card.querySelector('.h-7')).not.toBeNull();
    // Three rows, at the shipped skeleton's own 40 / 48 / 56%.
    const bars = [...card.querySelectorAll<HTMLElement>('.h-3\\.5')];
    expect(bars.map((b) => b.style.width)).toEqual(['40%', '48%', '56%']);
    expect(card.querySelectorAll('.size-8')).toHaveLength(3);
  });

  it('carries NO width of its own — the centred column is the PAGE’s', () => {
    // `design/settings/design-notes.md` § What the frame draws: "the pane
    // wrapper — the page's own, W from the route". The frame renders INSIDE it,
    // so the width is inherited by construction and the two cannot disagree.
    // A `max-w-*` here would be a second constraint, free to drift.
    const src = code('components/settings/SettingsPaneFrame.tsx');
    expect(src).not.toMatch(/\bmx-auto\b/);
    expect(src).not.toMatch(/\bmax-w-/);
  });

  it('is token-only — no Tier-0 --color-*, no raw radius, no invented hue', () => {
    const src = code('components/settings/SettingsPaneFrame.tsx');
    const classes = [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
      .map((m) => m[1] ?? m[2])
      .join(' ');
    expect(classes).not.toMatch(/--color-/);
    expect(classes).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    for (const cls of classes.split(/\s+/).filter((c) => c.startsWith('rounded-'))) {
      expect(cls).toMatch(/^rounded-\(--radius-[a-z-]+\)$/);
    }
    expect(classes).toContain('bg-(--el-muted)');
  });
});

describe('the two superseded route skeletons (MOTIR-3558)', () => {
  it('BOTH loading.tsx files are gone', () => {
    // They were the same drawing from a second source and had already drifted —
    // a w-32 title bar against a w-40, a w-24 action bar against a w-28.
    for (const rel of [
      'app/(authed)/settings/project/fields/loading.tsx',
      'app/(authed)/settings/project/components/loading.tsx',
    ]) {
      expect(existsSync(join(ROOT, rel))).toBe(false);
    }
  });

  it('and BOTH pages mount the frame in-page instead, so neither pane lost its wait', () => {
    for (const rel of PAGES) {
      const src = code(rel);
      expect(src).toMatch(/<Suspense\s+fallback=\{<SettingsPaneFrame\s*\/>\}>/);
      expect(src).toMatch(/from '@\/components\/settings\/SettingsPaneFrame'/);
    }
  });

  it('the boundary sits BELOW the gate and BELOW the real header on both pages', () => {
    // The gate decides the status; nothing may be flushed until it has run. And
    // the header is real, so it must be outside the fallback — if it drifted
    // inside, the pane would hide a heading it already had.
    for (const rel of PAGES) {
      const src = code(rel);
      const gate = src.indexOf('guardSettingsPage');
      const header = src.indexOf('<header');
      const boundary = src.indexOf('<Suspense');
      expect(gate).toBeGreaterThan(-1);
      expect(header).toBeGreaterThan(gate);
      expect(boundary).toBeGreaterThan(header);
      // …and the page's own centred column still carries the width.
      expect(src).toMatch(/mx-auto flex max-w-\[42rem\] flex-col gap-6/);
    }
  });

  it('no route-level loading.tsx was added anywhere under app/(authed) by this card', () => {
    // The family's frame is in-page precisely because a route-level fallback
    // flushes a 200 head above the eleven routes that decide existence.
    for (const rel of PAGES) {
      expect(code(rel)).not.toMatch(/loading\.tsx/);
    }
  });
});
