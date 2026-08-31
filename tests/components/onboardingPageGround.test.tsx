// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { loadTokenLayer, resolveToken } from '../theme/paletteCascade';

// MOTIR-4032 — the two full-viewport `(onboarding)` surfaces referenced
// `--el-page`, a token declared NOWHERE, so they painted no background of their
// own (the unresolved custom property is dropped at computed-value time). On a
// light theme that is invisible; on a dark theme it is a surface with no ground.
// The fix points both at `--el-page-bg`, and this test evidences it by RENDERING
// each surface and resolving the root's background token through the real
// theme.css chain in light AND dark — a render, not a diff. A third instance of
// this class is caught by the widened `tests/theme/elTokenReferences.test.ts`;
// this file is the render evidence that the FIXED surfaces actually paint.
//
// (happy-dom does not resolve a `var()` chain or the `[data-theme]` cascade, so
// a `getComputedStyle` here would return the literal `var(--el-page-bg)` and the
// assertion would be a spelling check. `paletteCascade` is the repo's model of
// exactly that part of the token layer — the same one `danger-alert-contrast`
// and the ink lint measure with.)

vi.mock('@/app/(onboarding)/onboarding/actions', () => ({ startPlanningAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

import { OnboardingEntrance } from '@/components/onboarding/OnboardingEntrance';
import { MigrateWizard } from '@/app/(onboarding)/onboarding/migrate/_components/MigrateWizard';

afterEach(cleanup);

const { rules } = loadTokenLayer();

/** The `--el-*` token an element paints as its background, off the rendered node. */
function bgTokenOf(element: Element): string {
  const className = element.getAttribute('class') ?? '';
  const match = /bg-\((--el-[a-z0-9-]+)\)/.exec(className);
  expect(match, `element has no bg-(--el-*) token: "${className}"`).not.toBeNull();
  return match![1]!;
}

function resolve(token: string, theme: 'light' | 'dark') {
  return resolveToken(rules, { palette: 'motir', theme }, token);
}

/** The root `h-dvh` div of a rendered full-viewport onboarding surface. */
function pageRoot(container: HTMLElement): Element {
  const root = container.querySelector('[class*="h-dvh"]');
  expect(root, 'no h-dvh root rendered').not.toBeNull();
  return root!;
}

/** Assert a background token paints a real, theme-aware page ground. */
function expectPageGround(bg: string, what: string) {
  const light = resolve(bg, 'light');
  const dark = resolve(bg, 'dark');

  expect(light.unresolved, `${what}: \`${bg}\` resolves to nothing in the light theme`).toEqual([]);
  expect(dark.unresolved, `${what}: \`${bg}\` resolves to nothing in the dark theme`).toEqual([]);
  expect(light.value, `${what}: light background is empty`).not.toBe('');
  expect(dark.value, `${what}: dark background is empty`).not.toBe('');
  // The ground must actually FLIP with the theme — one fixed colour would be a
  // broken surface wearing a declared token's name.
  expect(dark.value, `${what}: the dark background did not flip from light`).not.toBe(light.value);
}

describe('the (onboarding) full-viewport surfaces paint a page ground', () => {
  it('OnboardingEntrance paints --el-page-bg, resolved in light AND dark', () => {
    const { container } = renderWithIntl(<OnboardingEntrance carriedIdea={null} />);
    const bg = bgTokenOf(pageRoot(container));
    expect(bg).toBe('--el-page-bg');
    expectPageGround(bg, 'OnboardingEntrance');
  });

  it('MigrateWizard paints --el-page-bg, resolved in light AND dark', () => {
    const { container } = renderWithIntl(
      <MigrateWizard initialRun={null} projectName="Demo" userInitial="Y" />,
    );
    const bg = bgTokenOf(pageRoot(container));
    expect(bg).toBe('--el-page-bg');
    expectPageGround(bg, 'MigrateWizard');
  });

  it('--el-page — the name both surfaces used to ship — still resolves to nothing', () => {
    const broken = resolve('--el-page', 'light');
    expect(broken.unresolved).toEqual(['--el-page']);
    expect(broken.value).toBe('');
  });
});
