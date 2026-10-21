// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '@/tests/helpers/renderWithIntl';
import { LinkPageForm } from '@/app/(authed)/items/[key]/_components/LinkPageForm';

// MOTIR-9199 — the Link page form's search frames, its paging, its keyboard and
// its write, per design/work-items/item--pages-section--link.mock.html (P5–P15).

const cand = (id: string, title: string) => ({
  id,
  title,
  place: { folderPath: [], parentPageTitle: null },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Held = { url: URL; resolve: (r: Response) => void; reject: (e: unknown) => void };

/** A fetch whose answers are released by hand. */
function heldFetch() {
  const calls: Held[] = [];
  const fn = vi.fn(
    (url: string) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({ url: new URL(url, 'http://x'), resolve, reject });
      }),
  );
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

function renderForm(over: Partial<React.ComponentProps<typeof LinkPageForm>> = {}) {
  const onLinked = vi.fn();
  const onClose = vi.fn();
  renderWithIntl(
    <LinkPageForm
      projectId="proj_1"
      workItemId="wi_1"
      onLinked={onLinked}
      onClose={onClose}
      {...over}
    />,
    { now: new Date('2026-10-07T12:00:00Z') },
  );
  return { onLinked, onClose, input: screen.getByRole('combobox') as HTMLInputElement };
}

async function settle(calls: Held[], n: number) {
  await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(n));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LinkPageForm', () => {
  it('shows the hint and issues no request below two characters', async () => {
    const { fn } = heldFetch();
    const { input } = renderForm();
    expect(document.activeElement).toBe(input);
    expect(screen.getByText('Keep typing to search pages…')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'a' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('searches the item’s project once per settled query and draws title and place', async () => {
    const { calls } = heldFetch();
    const { input } = renderForm();
    fireEvent.change(input, { target: { value: 'me' } });
    fireEvent.change(input, { target: { value: 'mee' } });
    await settle(calls, 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get('projectId')).toBe('proj_1');
    expect(calls[0]!.url.searchParams.get('q')).toBe('mee');
    expect(screen.getByText('Searching…')).toBeTruthy();
    await act(async () =>
      calls[0]!.resolve(json({ items: [cand('a', 'Meeting')], nextCursor: null })),
    );
    expect(screen.getByRole('option', { name: /Meeting/ })).toBeTruthy();
    expect(screen.queryByText(/already linked/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show more pages' })).toBeNull();
  });

  it('never lets a superseded answer replace a newer one', async () => {
    const { calls } = heldFetch();
    const { input } = renderForm();
    fireEvent.change(input, { target: { value: 'old' } });
    await settle(calls, 1);
    fireEvent.change(input, { target: { value: 'newer' } });
    await settle(calls, 2);
    await act(async () =>
      calls[1]!.resolve(json({ items: [cand('n', 'Newer page')], nextCursor: null })),
    );
    await act(async () =>
      calls[0]!.resolve(json({ items: [cand('o', 'Old page')], nextCursor: null })),
    );
    expect(screen.getByRole('option', { name: /Newer page/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Old page/ })).toBeNull();
  });

  it('appends the next page without duplicates, and retries exactly the cursor that failed', async () => {
    const { calls } = heldFetch();
    const { input } = renderForm();
    fireEvent.change(input, { target: { value: 'pa' } });
    await settle(calls, 1);
    await act(async () =>
      calls[0]!.resolve(json({ items: [cand('a', 'Alpha'), cand('b', 'Beta')], nextCursor: 'c1' })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show more pages' }));
    await settle(calls, 2);
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('c1');
    await act(async () => calls[1]!.resolve(new Response('{}', { status: 500 })));
    expect(screen.getByText("Couldn't load more pages.")).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle(calls, 3);
    expect(calls[2]!.url.searchParams.get('cursor')).toBe('c1');
    await act(async () =>
      calls[2]!.resolve(json({ items: [cand('b', 'Beta'), cand('c', 'Gamma')], nextCursor: null })),
    );
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Show more pages' })).toBeNull();
  });

  it('renders a failed search as a failure with a retry — never as no matches', async () => {
    const { calls } = heldFetch();
    const { input } = renderForm();
    fireEvent.change(input, { target: { value: 'pa' } });
    await settle(calls, 1);
    await act(async () => calls[0]!.resolve(new Response('{}', { status: 500 })));
    expect(screen.getByText('Couldn’t search pages.')).toBeTruthy();
    expect(screen.queryByText(/No pages match/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle(calls, 2);
    expect(calls[1]!.url.searchParams.get('q')).toBe('pa');
    await act(async () =>
      calls[1]!.resolve(json({ items: [cand('a', 'Alpha')], nextCursor: null })),
    );
    expect(screen.queryByText('Couldn’t search pages.')).toBeNull();
    expect(screen.getByRole('option', { name: /Alpha/ })).toBeTruthy();
  });

  it('says so when nothing matches, naming the query', async () => {
    const { calls } = heldFetch();
    const { input } = renderForm();
    fireEvent.change(input, { target: { value: 'zzz' } });
    await settle(calls, 1);
    await act(async () => calls[0]!.resolve(json({ items: [], nextCursor: null })));
    expect(screen.getByText('No pages match “zzz”.')).toBeTruthy();
  });

  it('is operable from the keyboard: arrows move, Enter links, Escape closes', async () => {
    const { calls } = heldFetch();
    const { input, onLinked, onClose } = renderForm();
    fireEvent.change(input, { target: { value: 'pa' } });
    await settle(calls, 1);
    await act(async () =>
      calls[0]!.resolve(json({ items: [cand('a', 'Alpha'), cand('b', 'Beta')], nextCursor: null })),
    );
    const options = () => screen.getAllByRole('option');
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle(calls, 2);
    expect(calls[1]!.url.pathname).toBe('/api/work-items/wi_1/pages');
    expect(screen.getByTestId('link-page-picked').textContent).toContain('Beta');
    await act(async () =>
      calls[1]!.resolve(json({ pageId: 'b', workItemId: 'wi_1', source: 'manual' })),
    );
    expect(onLinked).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('wraps ArrowUp, follows the pointer, and draws an untitled page by its placeholder', async () => {
    const { calls } = heldFetch();
    const { input } = renderForm();
    fireEvent.change(input, { target: { value: 'pa' } });
    await settle(calls, 1);
    await act(async () =>
      calls[0]!.resolve(json({ items: [cand('a', ''), cand('b', 'Beta')], nextCursor: null })),
    );
    const options = () => screen.getAllByRole('option');
    expect(options()[0]!.textContent).toContain('Untitled');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.mouseEnter(options()[0]!);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the pick after a network failure, says so, and lets the person clear it', async () => {
    const { calls } = heldFetch();
    const { input, onLinked } = renderForm();
    fireEvent.change(input, { target: { value: 'pa' } });
    await settle(calls, 1);
    await act(async () => calls[0]!.resolve(json({ items: [cand('a', '')], nextCursor: null })));
    fireEvent.click(screen.getByRole('option'));
    await settle(calls, 2);
    await act(async () => calls[1]!.reject(new TypeError('offline')));
    expect(screen.getByText('Couldn’t link that page.')).toBeTruthy();
    expect(screen.getByTestId('link-page-picked').textContent).toContain('Untitled');
    expect(onLinked).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the selected page' }));
    expect(screen.queryByTestId('link-page-picked')).toBeNull();
    expect(screen.queryByText('Couldn’t link that page.')).toBeNull();
  });

  it('ignores a second pick while the first write is in flight', async () => {
    const { calls } = heldFetch();
    const { input } = renderForm();
    fireEvent.change(input, { target: { value: 'pa' } });
    await settle(calls, 1);
    await act(async () =>
      calls[0]!.resolve(json({ items: [cand('a', 'Alpha')], nextCursor: null })),
    );
    fireEvent.click(screen.getByRole('option'));
    fireEvent.click(screen.getByRole('option'));
    await settle(calls, 2);
    expect(calls.filter((c) => c.url.pathname === '/api/work-items/wi_1/pages')).toHaveLength(1);
  });
});
