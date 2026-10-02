// @vitest-environment happy-dom
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { PageView, type PageViewPage } from '@/app/(authed)/pages/[pageId]/_components/PageView';
// `PageView` loads the host LAZILY. Importing it here puts the editor's module
// graph in the cache before the first mount, so `findByRole` waits on the render
// rather than on a cold transform of Tiptap + Yjs (which can outlast its default
// 1 s under a loaded runner). The sibling suite gets the same by importing the
// host's helpers.
import '@/components/pages/PageEditorHost';

// The page at its address — the EDGES `tests/components/page-view.test.tsx` does
// not reach (Story MOTIR-5752 · MOTIR-7281, the story's coverage gate): the
// too-large callout's two ways out (Reload saved version lifts the leave guard;
// New page in a new tab opens the tab inside the click and points it at the new
// page, or closes it on failure), and the title's rename refusals other than
// 422-with-a-limit, including an older rename resolving after a newer one.
//
// The REAL `<PageEditor>` behind the REAL host, as the sibling suite runs it.
// Stubbed: `fetch` (the doors answer as the routes do), and the two browser
// calls a test cannot let happen — `window.open` and `location.reload`.

/** A page whose body is one paragraph: "Tag the commit, then push the tag." */
const BODY_STATE =
  'AQONzd2iCwAHAQdkZWZhdWx0AwlwYXJhZ3JhcGgHAI3N3aILAAYEAI3N3aILASJUYWcgdGhlIGNvbW1pdCwgdGhlbiBwdXNoIHRoZSB0YWcuAA==';

type Answer = Response | Error | Promise<Response>;
const answers: Record<string, Answer[]> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  const key = Object.keys(answers)
    .sort((a, b) => b.length - a.length)
    .find((suffix) => url.endsWith(suffix));
  const next = key ? answers[key]!.shift() : undefined;
  if (!next) throw new Error(`unanswered fetch: ${url}`);
  if (next instanceof Error) throw next;
  return next;
});

function answer(suffix: string, ...responses: Answer[]) {
  (answers[suffix] ??= []).push(...responses);
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const calls = (suffix: string) =>
  fetchMock.mock.calls.filter(([input]) => String(input).endsWith(suffix));

async function mount(page: Partial<PageViewPage> = {}) {
  const utils = renderWithIntl(
    <Suspense fallback={<p>frame</p>}>
      <PageView
        page={{ id: 'page-1', title: 'Runbook', bodyState: BODY_STATE, canEdit: true, ...page }}
        titleMaxLength={255}
      />
    </Suspense>,
  );
  const surface = await screen.findByRole('textbox', { name: 'Page body' });
  await act(async () => {});
  return { ...utils, surface };
}

/** Type into the body and let autosave hit a 413, so the too-large callout shows. */
async function driveTooLarge(surface: HTMLElement) {
  vi.useFakeTimers();
  answer(
    '/api/pages/page-1/updates',
    json({ code: 'PAGE_BODY_TOO_LARGE', error: 'Too large.', limit: 1, size: 2 }, 413),
  );
  const editor = (surface as HTMLElement & { editor: Editor }).editor;
  act(() => {
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' More.');
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  vi.useRealTimers();
  expect(screen.getByRole('alert').textContent).toContain('This page is too large to save');
}

beforeEach(() => {
  for (const key of Object.keys(answers)) delete answers[key];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the too-large callout', () => {
  it('Reload saved version lifts the leave guard, then reloads', async () => {
    const { surface } = await mount();
    await driveTooLarge(surface);

    // Not saved: leaving would ask first.
    const before = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(before);
    });
    expect(before.defaultPrevented).toBe(true);

    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Reload saved version' }));
    expect(reload).toHaveBeenCalledTimes(1);

    // The writer chose to discard, so the reload is not interrupted by the prompt.
    const after = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(after);
    });
    expect(after.defaultPrevented).toBe(false);
  });

  it('New page in a new tab opens the tab inside the click, then points it at the created page', async () => {
    const { surface } = await mount();
    await driveTooLarge(surface);
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    answer('/api/pages', json({ id: 'new page/1' }, 201));

    fireEvent.click(screen.getByRole('button', { name: 'New page in a new tab' }));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    await act(async () => {});

    expect(calls('/api/pages')[0]![1]).toMatchObject({ method: 'POST' });
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe('/pages/new%20page%2F1');
    expect(tab.close).not.toHaveBeenCalled();
  });

  it('closes the tab it opened when the create is refused', async () => {
    const { surface } = await mount();
    await driveTooLarge(surface);
    const tab = { opener: {}, location: { href: 'about:blank' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    answer('/api/pages', json({ code: 'PROJECT_ACCESS_DENIED' }, 403));

    fireEvent.click(screen.getByRole('button', { name: 'New page in a new tab' }));
    await act(async () => {});
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe('about:blank');
  });

  it('a blocked popup (no tab) still creates nothing it cannot show, and does not throw', async () => {
    const { surface } = await mount();
    await driveTooLarge(surface);
    vi.spyOn(window, 'open').mockReturnValue(null);
    answer('/api/pages', json({ id: 'p2' }, 201), json({}, 500));

    fireEvent.click(screen.getByRole('button', { name: 'New page in a new tab' }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'New page in a new tab' }));
    await act(async () => {});
    expect(calls('/api/pages')).toHaveLength(2);
  });
});

describe('the title’s rename refusals', () => {
  async function renameTo(value: string) {
    const title = screen.getByRole('textbox', { name: 'Page title' });
    fireEvent.change(title, { target: { value } });
    fireEvent.blur(title);
    await act(async () => {});
    return title;
  }

  it('a non-422 refusal shows the rename-failed message, and the next blur tries again', async () => {
    await mount();
    answer('/api/pages/page-1', json({ code: 'INTERNAL' }, 500), json({ title: 'Plan' }));
    const title = await renameTo('Plan');
    expect(screen.getByRole('alert').textContent).toBe(
      'Couldn’t save the title. Check your connection and try again.',
    );
    expect(title.getAttribute('aria-describedby')).toBe('page-title-error-page-1');

    fireEvent.blur(title);
    await act(async () => {});
    expect(calls('/api/pages/page-1')).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.title).toBe('Plan');
  });

  it('a request that never reached the server shows the same message', async () => {
    await mount();
    answer('/api/pages/page-1', new TypeError('Failed to fetch'));
    await renameTo('Plan');
    expect(screen.getByRole('alert').textContent).toBe(
      'Couldn’t save the title. Check your connection and try again.',
    );
  });

  it('a 422 with no readable limit falls back to the field’s own maximum', async () => {
    await mount();
    answer(
      '/api/pages/page-1',
      new Response('not json', { status: 422 }),
      json({ code: 'PAGE_TITLE_TOO_LONG' }, 422),
    );
    const title = await renameTo('x'.repeat(10));
    expect(screen.getByRole('alert').textContent).toBe(
      'The title is too long — keep it to 255 characters.',
    );
    fireEvent.change(title, { target: { value: 'y'.repeat(10) } });
    fireEvent.blur(title);
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toContain('255 characters');
  });

  it('clearing the title saves the empty title and names the tab with the untitled copy', async () => {
    await mount();
    answer('/api/pages/page-1', json({ title: '' }));
    await renameTo('');
    expect(document.title).toBe('Untitled');
  });

  it('an OLDER rename answering after a newer one never overwrites the newer verdict', async () => {
    await mount();
    let settleOld!: (r: Response) => void;
    const old = new Promise<Response>((resolve) => (settleOld = resolve));
    let failOld!: (e: Error) => void;
    const oldFailing = new Promise<Response>((_, reject) => (failOld = reject));
    answer('/api/pages/page-1', old, json({ title: 'Newer' }), oldFailing, json({ title: 'Z' }));

    await renameTo('Older');
    await renameTo('Newer');
    expect(document.title).toBe('Newer');
    // The stale 500 lands last: it must not raise an error over the saved title.
    await act(async () => {
      settleOld(json({ code: 'INTERNAL' }, 500));
    });
    expect(screen.queryByRole('alert')).toBeNull();

    // And a stale NETWORK failure, the other arm, is ignored the same way.
    await renameTo('Again');
    await renameTo('Z');
    await act(async () => {
      failOld(new TypeError('Failed to fetch'));
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.title).toBe('Z');
  });

  it('a composing Enter (an IME candidate) and other keys do not leave the title', async () => {
    await mount();
    const title = screen.getByRole('textbox', { name: 'Page title' });
    title.focus();
    fireEvent.keyDown(title, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(title, { key: 'a' });
    expect(document.activeElement).toBe(title);
  });

  it('a page that already has a title does not take focus on arrival', async () => {
    await mount({ title: 'Runbook' });
    expect(document.activeElement).not.toBe(screen.getByRole('textbox', { name: 'Page title' }));
  });
});
