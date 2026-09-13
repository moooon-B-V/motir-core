// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ToastProvider } from '@/components/ui/Toast';
import { PrMergeModeCard } from '@/app/(authed)/settings/project/approvals/_components/PrMergeModeCard';
import type { PrMergeModeValue } from '@/lib/dto/projects';

// The MERGE-MODE card (Story MOTIR-4880 · Subtask MOTIR-5181), rendered for the
// only actor who reaches it — the room is manage-only, so there is no read-only
// case to assert. Built to `design/projects/approvals.mock.html` panels 6–8.

const ASK = 'Ask before merging';
const AUTO = 'Merge automatically';

function renderCard(initialMode: PrMergeModeValue, projectKey = 'MOTIR') {
  return renderWithIntl(
    <ToastProvider>
      <PrMergeModeCard projectKey={projectKey} initialMode={initialMode} />
    </ToastProvider>,
  );
}

const option = (name: string) => screen.getByRole('radio', { name: new RegExp(name) });
const checked = (name: string) => option(name).getAttribute('aria-checked');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('PrMergeModeCard — the two described modes', () => {
  it('offers EXACTLY the two values, each with the label and hint from the asset, and the not-yet notice', () => {
    renderCard('manual');
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios[0]!.textContent).toContain(ASK);
    expect(radios[0]!.textContent).toContain(
      'When its checks pass, a person approves the pull request in Motir before it is merged. Nothing reaches your default branch without that yes.',
    );
    expect(radios[1]!.textContent).toContain(AUTO);
    expect(radios[1]!.textContent).toContain(
      'When its checks pass, Motir merges the pull request without asking anyone. The record says this setting allowed it — not that a person approved it.',
    );
    expect(screen.getByText(/Motir does not merge pull requests yet/)).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Merging pull requests' })).toBeTruthy();
  });

  it('shows the STORED value selected', () => {
    renderCard('auto');
    expect(checked(AUTO)).toBe('true');
    expect(checked(ASK)).toBe('false');
  });

  it('a choice sends the PATCH and the rendered state is correct WITHOUT a reload', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ prMergeMode: 'auto' }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    renderCard('manual', 'ACME');

    fireEvent.click(option(AUTO));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('/api/projects/ACME/pr-merge-mode');
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(String(init?.body))).toEqual({ prMergeMode: 'auto' });
    await waitFor(() => expect(checked(AUTO)).toBe('true'));
    expect(checked(ASK)).toBe('false');
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('choosing the value already selected sends nothing', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    renderCard('manual');
    fireEvent.click(option(ASK));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a FAILED write puts the previously persisted value back and says what failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ code: 'PERMISSION_DENIED' }, { status: 403 })),
    );
    renderCard('manual');

    fireEvent.click(option(AUTO));

    expect(await screen.findByText("Couldn't save — try again.")).toBeTruthy();
    expect(checked(ASK)).toBe('true');
    expect(checked(AUTO)).toBe('false');
  });

  it('two cards for two projects hold and write their OWN values', async () => {
    const fetchSpy = vi.fn(async (url: string) =>
      Response.json({ prMergeMode: url.includes('/ONE/') ? 'auto' : 'manual' }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const one = renderCard('manual', 'ONE');
    fireEvent.click(option(AUTO));
    await waitFor(() => expect(checked(AUTO)).toBe('true'));
    one.unmount();

    renderCard('manual', 'TWO');
    expect(checked(ASK)).toBe('true');
    expect(fetchSpy.mock.calls.map((c) => c[0])).toEqual(['/api/projects/ONE/pr-merge-mode']);
  });
});

describe('PrMergeModeCard — the #merge-mode deep link (panel 8)', () => {
  it('carries id="merge-mode"', () => {
    const { container } = renderCard('manual');
    expect(container.querySelector('#merge-mode')).not.toBeNull();
  });

  it('arriving at #merge-mode focuses the card and shows the focus ring once', async () => {
    window.location.hash = '#merge-mode';
    const { container } = renderCard('manual');
    const card = container.querySelector('#merge-mode') as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(card));
    expect(card.className).toContain('ring-2');

    act(() => card.blur());
    expect(card.className).not.toContain('ring-2');
  });

  it('without the anchor, nothing is focused and no ring is drawn', () => {
    const { container } = renderCard('manual');
    const card = container.querySelector('#merge-mode') as HTMLElement;
    expect(document.activeElement).not.toBe(card);
    expect(card.className).not.toContain('ring-2');
  });
});

describe('the merge-mode copy ships in BOTH locales', () => {
  function keys(node: unknown, prefix = ''): string[] {
    if (typeof node !== 'object' || node === null) return [prefix];
    return Object.entries(node).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
  }

  it('en and zh carry the same keys under approvals.mergeMode, none empty', () => {
    const enNode = (en as { approvals: { mergeMode: Record<string, unknown> } }).approvals
      .mergeMode;
    const zhNode = (zh as { approvals: { mergeMode: Record<string, unknown> } }).approvals
      .mergeMode;
    expect(keys(zhNode).sort()).toEqual(keys(enNode).sort());
    expect(keys(enNode)).toEqual(
      expect.arrayContaining([
        'title',
        'desc',
        'notYet',
        'manual.label',
        'manual.hint',
        'auto.label',
        'auto.hint',
      ]),
    );
    const leaves = (n: unknown): string[] =>
      typeof n === 'string' ? [n] : Object.values(n as object).flatMap(leaves);
    for (const s of [...leaves(enNode), ...leaves(zhNode)]) expect(s.trim()).not.toBe('');
  });
});
