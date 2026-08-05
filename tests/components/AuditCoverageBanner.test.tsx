// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axe from 'axe-core';
import { act, cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { AuditCoverageBanner } from '@/components/planning/AuditCoverageBanner';
import type { AuditCoverageDTO } from '@/lib/dto/codeHealth';

// The audit-coverage banner on /planning (MOTIR-2250 · design/audit-coverage).
//
// Most of what this asserts is what the banner does NOT render — a member sees
// nothing, a failed read shows nothing, a zero count shows nothing — because
// those are the states a person meets far more often than the banner itself.

let calls: string[] = [];
let respond: () => Promise<Response>;

function json(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}
const coverage = (over: Partial<AuditCoverageDTO> = {}): AuditCoverageDTO => ({
  repos: [
    { repoKey: 'moooon/motir-ai', state: 'audited' },
    { repoKey: 'moooon/motir-meta', state: 'not_audited' },
  ],
  notAuditedCount: 1,
  ...over,
});

beforeEach(() => {
  calls = [];
  respond = () => Promise.resolve(json(coverage()));
  vi.stubGlobal('fetch', (input: string) => {
    calls.push(String(input));
    return respond();
  });
});

afterEach(cleanup);
afterAll(() => {
  vi.unstubAllGlobals();
});

async function render() {
  const result = renderWithIntl(<AuditCoverageBanner />);
  // The read happens after mount; flush it so the assertion sees the settled UI.
  await act(async () => {});
  return result;
}

describe('what it renders', () => {
  it('names the count and links to /code-health', async () => {
    await render();

    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('1 repository has no code-health audit.');
    expect(banner.textContent).toContain(
      'Plans that touch them are made without their recorded standards.',
    );
    const link = screen.getByRole('link', { name: 'Review code health' });
    expect(link.getAttribute('href')).toBe('/code-health');
  });

  it('pluralises the count', async () => {
    respond = () => Promise.resolve(json(coverage({ notAuditedCount: 3 })));
    await render();

    expect(screen.getByRole('status').textContent).toContain(
      '3 repositories have no code-health audit.',
    );
  });

  it('reads its own state after mount — the workspace never waits on it', async () => {
    // Nothing is rendered on the first pass, before the read resolves, and the
    // component itself never blocks: it is mounted and returns null until then.
    const { container } = renderWithIntl(<AuditCoverageBanner />);
    expect(container.querySelector('[role="status"]')).toBeNull();

    await act(async () => {});
    expect(screen.getByRole('status')).toBeTruthy();
    expect(calls).toEqual(['/api/ai/coding-convention/audit-coverage']);
  });
});

describe('what it does NOT render', () => {
  it('renders nothing when every connected repo has a report', async () => {
    respond = () => Promise.resolve(json(coverage({ notAuditedCount: 0 })));
    const { container } = await render();

    expect(container.querySelector('[role="status"]')).toBeNull();
    // No gap is reserved either — the element is absent, not empty.
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when the caller is REFUSED (a non-admin gets a 403)', async () => {
    respond = () =>
      Promise.resolve({ ok: false, status: 403, json: async () => ({}) } as unknown as Response);
    const { container } = await render();

    expect(container.innerHTML).toBe('');
  });

  it('renders nothing — and no error strip — when the read fails outright', async () => {
    respond = () => Promise.reject(new Error('network'));
    const { container } = await render();

    expect(container.innerHTML).toBe('');
  });

  it('never renders a DISMISS control — the banner is not dismissible', async () => {
    await render();

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /dismiss|close|hide/i })).toBeNull();
  });
});

describe('it is a one-line, full-bleed banner — the shape is the design', () => {
  it('is a single role=status row with no heading, no list and no card radius', async () => {
    const { container } = await render();
    const banner = screen.getByRole('status');

    // ONE status row, and it IS the component's root: nothing wraps it in a
    // padded container, which would destroy the full bleed.
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.firstElementChild).toBe(banner);

    // A heading or a list would mean it had grown back into a card.
    expect(banner.querySelector('h1,h2,h3,h4,h5,h6')).toBeNull();
    expect(banner.querySelector('ul,ol')).toBeNull();

    // Full-bleed: no radius, no horizontal margin. The bottom rule is the same
    // one the workspace top bar draws.
    const cls = banner.className;
    expect(cls).not.toMatch(/rounded/);
    expect(cls).not.toMatch(/\bmx-|\bml-|\bmr-/);
    expect(cls).toContain('border-b');
  });

  it('does not name the repositories — that job belongs to the destination', async () => {
    await render();

    // The count is the banner's payload; the per-repo names live on /code-health
    // (design §3), so a five-repo project can never wrap this onto a second line.
    expect(screen.getByRole('status').textContent).not.toContain('moooon/motir-meta');
  });
});

describe('a11y', () => {
  it('has no axe violations and the link names its destination', async () => {
    const { container } = await render();

    expect(screen.getByRole('link', { name: 'Review code health' })).toBeTruthy();
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });
});
