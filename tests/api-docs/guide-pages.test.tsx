// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import { GUIDE_STEPS, POLICY_ADDITIVE, POLICY_FORBIDDEN } from '@/lib/apiDocs/guide';

// The guide and the policy, RENDERED (Story 11.4 · Subtask 11.4.8 — MOTIR-2189).
//
// `guide-truth.test.ts` checks that the content is TRUE of the shipped API and
// of ADR §8. This suite checks the other half: that all of it actually reaches
// the page, inside the shell 11.4.7 built, reachable from its navigation.

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.resetModules();
});

describe('/docs/api/getting-started', () => {
  it('renders all five steps, numbered, in order, inside the shell', async () => {
    const { default: Page } = await import('@/app/(public)/docs/api/getting-started/page');
    render(await Page());

    const sections = [...document.querySelectorAll('main section[id]')].map((s) => s.id);
    expect(sections).toEqual(GUIDE_STEPS.map((step) => step.id));

    for (const step of GUIDE_STEPS) {
      expect(screen.getByText(step.title), `${step.id} heading missing`).toBeTruthy();
    }
    // The numbers are the guide's spine: it is a linear read, not a menu.
    expect(screen.getByText('1')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('puts every runnable sample on the page with a copy affordance', async () => {
    const { default: Page } = await import('@/app/(public)/docs/api/getting-started/page');
    render(await Page());

    const copyable = GUIDE_STEPS.flatMap((step) => step.blocks).filter(
      (block) => block.kind === 'code' && block.copyable,
    );
    expect(copyable.length).toBeGreaterThan(2);
    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(copyable.length);
  });

  it('is reachable from the shell’s nav, and marks itself current', async () => {
    const { default: Page } = await import('@/app/(public)/docs/api/getting-started/page');
    render(await Page());

    const current = document.querySelector('nav a[aria-current="page"]');
    expect(current?.getAttribute('href')).toBe('/docs/api/getting-started');
    // …and it does not strand the reader: the other three pages are one click
    // away (four-page surface since Story MOTIR-2268).
    expect(screen.getAllByText('API reference').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Agent sandbox').length).toBeGreaterThan(0);
  });
});

describe('/docs/api/stability', () => {
  it('publishes BOTH lists in full — every item reaches the page', async () => {
    const { default: Page } = await import('@/app/(public)/docs/api/stability/page');
    render(await Page());

    for (const item of [...POLICY_ADDITIVE, ...POLICY_FORBIDDEN]) {
      expect(screen.getByText(item.text), `"${item.text}" is not on the page`).toBeTruthy();
    }
    expect(document.querySelectorAll('main ul li')).toHaveLength(
      POLICY_ADDITIVE.length + POLICY_FORBIDDEN.length,
    );
  });

  it('states the client’s obligation and the deprecation channel', async () => {
    const { default: Page } = await import('@/app/(public)/docs/api/stability/page');
    render(await Page());

    expect(document.body.textContent).toContain('tolerate unknown fields');
    expect(document.body.textContent).toContain('deprecated: true');
    expect(document.body.textContent).toContain('alongside');
  });

  it('cross-links the ADR, saying which record is which', async () => {
    const { default: Page } = await import('@/app/(public)/docs/api/stability/page');
    render(await Page());

    const note = screen.getByTestId('adr-cross-link');
    expect(note.textContent).toContain('docs/decisions/public-api-conventions.md');
    expect(note.textContent).toContain('§8');
  });

  it('is reachable from the shell’s nav, and marks itself current', async () => {
    const { default: Page } = await import('@/app/(public)/docs/api/stability/page');
    render(await Page());

    expect(document.querySelector('nav a[aria-current="page"]')?.getAttribute('href')).toBe(
      '/docs/api/stability',
    );
  });
});
