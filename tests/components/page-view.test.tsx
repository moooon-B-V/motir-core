// @vitest-environment happy-dom
import { Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import {
  PageView,
  TITLE_RENAME_QUIET_MS,
  type PageViewPage,
} from '@/app/(authed)/pages/[pageId]/_components/PageView';
import { decodeBase64, sendPageUpdate, uploadPageImage } from '@/components/pages/PageEditorHost';

// PageView's own ⋯ and the archived banner read the router (MOTIR-7423).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// The page at its own address (Story MOTIR-5752 · MOTIR-7280) —
// `design/pages/page.mock.html` states 6–10, driven under happy-dom with the
// REAL `<PageEditor>` (Tiptap bound to a Yjs doc) behind the REAL host. Only
// `fetch` is stubbed: the view and the host are pure clients of
// `PATCH /api/pages/<id>`, `POST …/updates` and `POST …/images`, so each test
// answers those doors the way the routes do and asserts what the reader sees.

/** `Y.encodeStateAsUpdate` of an empty page. */
const EMPTY_STATE = 'AAA=';
/** A page whose body is one paragraph: "Tag the commit, then push the tag." */
const BODY_STATE =
  'AQONzd2iCwAHAQdkZWZhdWx0AwlwYXJhZ3JhcGgHAI3N3aILAAYEAI3N3aILASJUYWcgdGhlIGNvbW1pdCwgdGhlbiBwdXNoIHRoZSB0YWcuAA==';

type Answer = Response | Error;
const answers: Record<string, Answer[]> = {};
const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
  const url = String(input);
  const key = Object.keys(answers).find((suffix) => url.endsWith(suffix));
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

function calls(suffix: string) {
  return fetchMock.mock.calls.filter(([input]) => String(input).endsWith(suffix));
}

// ⚠️ A test that needs fake timers installs them AFTER `mount` resolves:
// `findByRole` polls on real timers while the lazily loaded editor arrives.
async function mount(page: Partial<PageViewPage> = {}) {
  const utils = renderWithIntl(
    <Suspense fallback={<p>frame</p>}>
      <PageView
        page={{ id: 'page-1', title: '', bodyState: EMPTY_STATE, canEdit: true, ...page }}
        titleMaxLength={255}
        viewerId="user-1"
      />
    </Suspense>,
  );
  const surface = await screen.findByRole('textbox', { name: 'Page body' });
  // Let the editor's mount effects (the collaboration binding, focus) settle.
  await act(async () => {});
  return { ...utils, surface };
}

function editorOf(surface: HTMLElement): Editor {
  return (surface as HTMLElement & { editor: Editor }).editor;
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
});

describe('a member opens a fresh page (state 6)', () => {
  it('shows an empty, focused title, the editor, its toolbar and the indicator reading Saved', async () => {
    await mount();
    const title = screen.getByRole('textbox', { name: 'Page title' });
    expect(title).toHaveProperty('value', '');
    expect(title.getAttribute('placeholder')).toBe('Untitled');
    expect(document.activeElement).toBe(title);
    expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Saved');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('Enter in the title moves focus to the body', async () => {
    const { surface } = await mount();
    const title = screen.getByRole('textbox', { name: 'Page title' });
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(surface.contains(document.activeElement)).toBe(true);
  });
});

describe('renaming the page', () => {
  it('PATCHes the title after 800 ms of quiet, once', async () => {
    await mount();
    vi.useFakeTimers();
    answer('/api/pages/page-1', json({ title: 'Release runbook' }));
    const title = screen.getByRole('textbox', { name: 'Page title' });

    fireEvent.change(title, { target: { value: 'Release runbook' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TITLE_RENAME_QUIET_MS - 1);
    });
    expect(calls('/api/pages/page-1')).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    const sent = calls('/api/pages/page-1');
    expect(sent).toHaveLength(1);
    expect(sent[0]![1]).toMatchObject({ method: 'PATCH' });
    expect(JSON.parse(String(sent[0]![1]!.body))).toEqual({ title: 'Release runbook' });

    // Blurring with nothing new to say sends nothing.
    fireEvent.blur(title);
    await act(async () => {});
    expect(calls('/api/pages/page-1')).toHaveLength(1);
    expect(document.title).toBe('Release runbook');
  });

  it('sends at once on blur', async () => {
    await mount();
    answer('/api/pages/page-1', json({ title: 'Runbook' }));
    const title = screen.getByRole('textbox', { name: 'Page title' });
    fireEvent.change(title, { target: { value: 'Runbook' } });
    fireEvent.blur(title);
    await act(async () => {});
    expect(calls('/api/pages/page-1')).toHaveLength(1);
  });

  it('shows the title-too-long message inline on a 422', async () => {
    await mount();
    answer(
      '/api/pages/page-1',
      json({ code: 'PAGE_TITLE_TOO_LONG', error: 'Too long.', limit: 255 }, 422),
    );
    const title = screen.getByRole('textbox', { name: 'Page title' });
    fireEvent.change(title, { target: { value: 'x'.repeat(10) } });
    fireEvent.blur(title);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The title is too long — keep it to 255 characters.');
    expect(title.getAttribute('aria-invalid')).toBe('true');
  });
});

describe('a viewer opens the page (state 10)', () => {
  it('shows the title as a heading and the body, with no toolbar, no editing and no indicator', async () => {
    const { surface } = await mount({
      title: 'Release runbook',
      bodyState: BODY_STATE,
      canEdit: false,
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Release runbook' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Page title' })).toBeNull();
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(surface.getAttribute('contenteditable')).toBe('false');
    expect(surface.textContent).toContain('Tag the commit, then push the tag.');
  });

  it('shows the untitled copy for a page with no title', async () => {
    await mount({ canEdit: false });
    expect(screen.getByRole('heading', { level: 1, name: 'Untitled' })).toBeTruthy();
  });
});

describe('saving the body through the host', () => {
  it('posts the update as raw bytes and shows the too-large state on a 413', async () => {
    const { surface } = await mount({ bodyState: BODY_STATE });
    vi.useFakeTimers();
    answer(
      '/api/pages/page-1/updates',
      json({ code: 'PAGE_BODY_TOO_LARGE', error: 'Too large.', limit: 1, size: 2 }, 413),
    );
    const editor = editorOf(surface);
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' More.');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    const sent = calls('/api/pages/page-1/updates');
    expect(sent).toHaveLength(1);
    expect(sent[0]![1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    expect(sent[0]![1]!.body).toBeInstanceOf(Uint8Array);

    expect(screen.getByRole('alert').textContent).toContain('This page is too large to save');
    expect(screen.getByRole('status').textContent).toContain('Not saved');
    expect(screen.getByRole('button', { name: 'Reload saved version' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New page in a new tab' })).toBeTruthy();
  });

  it('shows offline when the request fails, then saved once it succeeds', async () => {
    const { surface } = await mount({ bodyState: BODY_STATE });
    vi.useFakeTimers();
    answer('/api/pages/page-1/updates', new TypeError('Failed to fetch'), json({ revision: 2 }));
    const editor = editorOf(surface);
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' More.');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole('status').textContent).toContain('Offline — edits kept');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(calls('/api/pages/page-1/updates')).toHaveLength(2);
    expect(screen.getByRole('status').textContent).toContain('Saved');
  });

  it('asks before the tab closes while an edit is unsaved, and not once it is saved', async () => {
    const { surface } = await mount({ bodyState: BODY_STATE });
    vi.useFakeTimers();
    answer('/api/pages/page-1/updates', new TypeError('Failed to fetch'));
    const editor = editorOf(surface);
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' More.');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const offline = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(offline);
    expect(offline.defaultPrevented).toBe(true);

    answer('/api/pages/page-1/updates', json({ revision: 2 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    const saved = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(saved);
    expect(saved.defaultPrevented).toBe(false);
  });
});

describe('an image inserted into the body', () => {
  it('uploads through POST /api/pages/<id>/images and renders at the returned url', async () => {
    const { container } = await mount();
    answer('/api/pages/page-1/images', json({ url: '/api/attachments/att-1/content' }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'diagram.png', {
      type: 'image/png',
    });
    fireEvent.change(input, { target: { files: [file] } });
    await act(async () => {});

    const sent = calls('/api/pages/page-1/images');
    expect(sent).toHaveLength(1);
    expect(sent[0]![1]).toMatchObject({ method: 'POST' });
    const form = sent[0]![1]!.body as FormData;
    expect((form.get('file') as File).name).toBe('diagram.png');
    expect(container.querySelector('img[src="/api/attachments/att-1/content"]')).toBeTruthy();
  });
});

describe('the host helpers', () => {
  it('decodes the DTO base64 state', () => {
    expect(Array.from(decodeBase64(EMPTY_STATE))).toEqual([0, 0]);
  });

  it('resolves the revision on 200, rejects 413 with PAGE_BODY_TOO_LARGE and other failures without it', async () => {
    answer(
      '/api/pages/p/updates',
      json({ revision: 7 }),
      json({ code: 'PAGE_BODY_TOO_LARGE', limit: 10, size: 20 }, 413),
      json({ code: 'INTERNAL' }, 500),
      new TypeError('Failed to fetch'),
    );
    const bytes = new Uint8Array([1, 2, 3]);
    await expect(sendPageUpdate('p', bytes)).resolves.toEqual({ revision: 7 });
    await expect(sendPageUpdate('p', bytes)).rejects.toMatchObject({
      code: 'PAGE_BODY_TOO_LARGE',
      limit: 10,
      size: 20,
    });
    const serverError = await sendPageUpdate('p', bytes).catch((e: unknown) => e);
    expect((serverError as { code?: string }).code).toBeUndefined();
    const network = await sendPageUpdate('p', bytes).catch((e: unknown) => e);
    expect(network).toBeInstanceOf(TypeError);
  });

  it('uploads an image as multipart and rejects a refusal', async () => {
    answer('/api/pages/p/images', json({ url: '/u' }), json({ code: 'X' }, 400));
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    await expect(uploadPageImage('p', file)).resolves.toEqual({ url: '/u' });
    await expect(uploadPageImage('p', file)).rejects.toThrow();
  });
});
