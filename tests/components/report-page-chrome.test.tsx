// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// The help controls are their own suite's (`reportHelp.test.tsx`); here they only
// have to be recognisable.
vi.mock('@/app/(authed)/reports/_components/ReportHelp', () => ({
  ReportHelpToggle: ({ report }: { report: string }) => <button data-help={report}>help</button>,
  ReportHelpRegion: () => null,
}));

const { ReportPageChrome } = await import('@/app/(authed)/reports/_components/ReportPageChrome');

afterEach(() => cleanup());

const chrome = (backHref?: string) => (
  <ReportPageChrome
    backLabel="Back"
    backHref={backHref}
    crumb="Reports"
    title="Velocity"
    subLine="Prodect"
    help="velocity"
  >
    <p>body</p>
  </ReportPageChrome>
);

describe('ReportPageChrome', () => {
  it('fills the content region: no width cap and no centring on its root', () => {
    const { container } = render(chrome());
    const cls = (container.firstElementChild as HTMLElement).className;
    expect(cls).not.toMatch(/max-w-/);
    expect(cls).not.toContain('mx-auto');
    expect(cls).toContain('w-full');
  });

  it('the back link goes to the Reports hub unless a page says otherwise', () => {
    render(chrome());
    expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe('/reports');
    cleanup();
    render(chrome('/backlog'));
    expect(screen.getByRole('link', { name: 'Back' }).getAttribute('href')).toBe('/backlog');
  });

  it('passes the report id to the help toggle', () => {
    render(chrome());
    expect(screen.getByRole('button', { name: 'help' }).getAttribute('data-help')).toBe('velocity');
  });
});
