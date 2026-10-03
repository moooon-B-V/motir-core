// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { PageEditor, type PageEditorProps } from '../../src/editor/PageEditor';
import type { SaveStatus } from '../../src/editor/autosave';
import { emptyState, markdownToUpdate } from '../../src';
import { MESSAGES, archivedError, stateFromMarkdown, textAfter, tooLargeError } from './fixtures';

// `<PageEditor>` mounted for real under jsdom (MOTIR-7275): a real Tiptap editor
// bound to a real Yjs doc, with fake `saveUpdate` / `uploadImage` props and fake
// timers. "Typing" is an editor command, so every keystroke goes through the
// collaboration binding exactly as a key press does — the binding is what turns
// it into a local-origin Yjs update.

const BODY = '## Release steps\n\n- Tag the commit\n- Push the tag\n\n```sh\npnpm release\n```\n';

interface Deferred {
  resolve: (value: { revision: number }) => void;
  reject: (err: unknown) => void;
}

function mount(overrides: Partial<PageEditorProps> = {}) {
  const initialState = overrides.initialState ?? stateFromMarkdown(BODY);
  const pending: Deferred[] = [];
  const saveUpdate = vi.fn(
    (_update: Uint8Array) =>
      new Promise<{ revision: number }>((resolve, reject) => pending.push({ resolve, reject })),
  );
  const uploadImage = vi.fn(async (file: File) => ({ url: `https://cdn.test/${file.name}` }));
  const statuses: SaveStatus[] = [];
  const utils = render(
    <PageEditor
      initialState={initialState}
      editable
      saveUpdate={saveUpdate}
      uploadImage={uploadImage}
      messages={MESSAGES}
      theme="light"
      onSaveStatusChange={(s) => statuses.push(s)}
      {...overrides}
    />,
  );
  const surface = screen.getByRole('textbox', { name: 'Page body' });
  const editor = (surface as HTMLElement & { editor: Editor }).editor;
  const doc = editor.extensionManager.extensions.find((e) => e.name === 'collaboration')!.options
    .document as Y.Doc;
  /** A keystroke at the end of the document's last block. */
  const type = (text: string) =>
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, text);
    });
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  /** Settle the oldest save request. */
  const settle = (outcome: 'ok' | unknown) =>
    act(async () => {
      const next = pending.shift()!;
      if (outcome === 'ok') next.resolve({ revision: 2 });
      else next.reject(outcome);
      await vi.advanceTimersByTimeAsync(0);
    });
  const sent = () => saveUpdate.mock.calls.map((c) => c[0]);
  const indicator = () => screen.getByRole('status');
  return {
    ...utils,
    initialState,
    surface,
    editor,
    doc,
    saveUpdate,
    uploadImage,
    statuses,
    type,
    advance,
    settle,
    sent,
    indicator,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the document', () => {
  it('renders a stored heading, list and code block', () => {
    const { surface } = mount();
    expect(within(surface).getByRole('heading', { level: 2, name: 'Release steps' })).toBeTruthy();
    const items = within(surface).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['Tag the commit', 'Push the tag']);
    expect(surface.querySelector('pre code')?.textContent).toBe('pnpm release');
    expect(surface.querySelector('pre code')?.className).toBe('language-sh');
  });

  it('writes nothing on open, for a stored body or a fresh page', async () => {
    const stored = mount();
    await stored.advance(10_000);
    expect(stored.saveUpdate).not.toHaveBeenCalled();
    expect(stored.indicator().textContent).toBe('Saved');
    cleanup();
    const fresh = mount({ initialState: emptyState() });
    await fresh.advance(10_000);
    expect(fresh.saveUpdate).not.toHaveBeenCalled();
  });

  it('writes the colour mode and the placeholder', () => {
    const { container, surface } = mount({ initialState: emptyState(), theme: 'dark' });
    expect(container.querySelector('.motir-page-editor')?.getAttribute('data-color-mode')).toBe(
      'dark',
    );
    expect(surface.querySelector('p')?.getAttribute('data-placeholder')).toBe('Start writing.');
  });
});

describe('autosave', () => {
  it('sends exactly one update after 1 s of quiet, carrying what was typed', async () => {
    const h = mount();
    for (const ch of 'abc') {
      h.type(ch);
      await h.advance(300);
    }
    expect(h.indicator().textContent).toBe('Saving…');
    await h.advance(699);
    expect(h.saveUpdate).not.toHaveBeenCalled();
    await h.advance(1);
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    expect(textAfter(h.initialState, ...h.sent())).toContain('pnpm releaseabc');
    await h.settle('ok');
    expect(h.indicator().textContent).toBe('Saved');
    expect(h.statuses).toEqual(['saving', 'saved']);
  });

  it('caps 6 s of continuous typing at 5 s, with one request in flight', async () => {
    const h = mount();
    for (let t = 0; t < 6_000; t += 250) {
      h.type('x');
      await h.advance(250);
      if (t === 4_750) expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    }
    // The second batch came due while the first is unsettled: it waits.
    await h.advance(10_000);
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    await h.settle('ok');
    expect(h.saveUpdate).toHaveBeenCalledTimes(2);
    expect(textAfter(h.initialState, ...h.sent())).toContain('x'.repeat(24));
    await h.settle('ok');
    expect(h.indicator().textContent).toBe('Saved');
  });

  it('goes offline on a network failure and resends every edit made meanwhile', async () => {
    const h = mount();
    h.type('one');
    await h.advance(1_000);
    await h.settle(new TypeError('Failed to fetch'));
    const indicator = h.indicator();
    expect(indicator.textContent).toBe('Offline — edits kept');
    expect(indicator.getAttribute('title')).toBe(MESSAGES.status.offlineDetail);

    h.type('two');
    h.type('three');
    await h.advance(2_000);
    expect(h.saveUpdate).toHaveBeenCalledTimes(2);
    const retried = h.sent()[1]!;
    expect(textAfter(h.initialState, retried)).toContain('pnpm releaseonetwothree');

    await h.settle('ok');
    expect(h.indicator().textContent).toBe('Saved');
    expect(h.statuses).toEqual(['saving', 'offline', 'saved']);
  });

  it('stops for good on PAGE_BODY_TOO_LARGE and keeps the content', async () => {
    const onReloadSaved = vi.fn();
    const onNewPage = vi.fn();
    const h = mount({ onReloadSaved, onNewPage });
    h.type('huge');
    await h.advance(1_000);
    await h.settle(tooLargeError());

    expect(h.indicator().textContent).toBe('Not saved');
    const callout = screen.getByRole('alert');
    expect(within(callout).getByText(MESSAGES.tooLarge.title)).toBeTruthy();
    expect(within(callout).getByText(MESSAGES.tooLarge.body)).toBeTruthy();
    fireEvent.click(within(callout).getByRole('button', { name: 'Reload saved version' }));
    fireEvent.click(within(callout).getByRole('button', { name: 'New page in a new tab' }));
    expect(onReloadSaved).toHaveBeenCalledTimes(1);
    expect(onNewPage).toHaveBeenCalledTimes(1);

    h.type('more');
    await h.advance(60_000);
    fireEvent(window, new Event('online'));
    await h.advance(60_000);
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    expect(h.surface.textContent).toContain('pnpm releasehugemore');
    expect(h.editor.isEditable).toBe(true);
  });

  it('stops for good on PAGE_ARCHIVED with the archived callout and Reload page (MOTIR-7423)', async () => {
    const onReloadSaved = vi.fn();
    const onNewPage = vi.fn();
    const h = mount({ onReloadSaved, onNewPage });
    h.type('late');
    await h.advance(1_000);
    await h.settle(archivedError());

    expect(h.indicator().textContent).toBe('Not saved');
    expect(h.indicator().getAttribute('data-status')).toBe('archived');
    const callout = screen.getByRole('alert');
    expect(callout.getAttribute('data-refusal')).toBe('archived');
    expect(within(callout).getByText(MESSAGES.archived.title)).toBeTruthy();
    expect(within(callout).getByText(MESSAGES.archived.body)).toBeTruthy();
    // The archived page offers no "new page in a new tab" — only the reload.
    expect(within(callout).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(within(callout).getByRole('button', { name: 'Reload page' }));
    expect(onReloadSaved).toHaveBeenCalledTimes(1);

    h.type('more');
    await h.advance(60_000);
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    expect(h.surface.textContent).toContain('latemore');
  });

  it('draws the refusal without actions when the host gives none', async () => {
    const h = mount();
    h.type('huge');
    await h.advance(1_000);
    await h.settle(tooLargeError());
    expect(within(screen.getByRole('alert')).queryByRole('button')).toBeNull();
  });

  it('never sends an update another origin applied', async () => {
    const h = mount();
    const remote = markdownToUpdate(h.initialState, `${BODY}\nFrom another writer.\n`);
    act(() => {
      Y.applyUpdate(h.doc, remote, 'remote');
    });
    expect(h.surface.textContent).toContain('From another writer.');
    await h.advance(10_000);
    expect(h.saveUpdate).not.toHaveBeenCalled();
    expect(h.indicator().textContent).toBe('Saved');
  });

  it('saves an undo, which the binding replays with its undo manager as origin', async () => {
    const h = mount();
    h.type('oops');
    await h.advance(1_000);
    await h.settle('ok');
    act(() => {
      h.editor.commands.undo();
    });
    expect(h.surface.textContent).not.toContain('oops');
    await h.advance(1_000);
    expect(h.saveUpdate).toHaveBeenCalledTimes(2);
    expect(textAfter(h.initialState, ...h.sent())).not.toContain('oops');
  });

  it('sends what is buffered when the editor unmounts', async () => {
    const h = mount();
    h.type('last words');
    h.unmount();
    expect(h.saveUpdate).toHaveBeenCalledTimes(1);
    expect(textAfter(h.initialState, ...h.sent())).toContain('last words');
  });

  it('reads the latest saveUpdate prop without restarting the loop', async () => {
    const h = mount();
    const next = vi.fn(async () => ({ revision: 3 }));
    h.rerender(
      <PageEditor
        initialState={h.initialState}
        editable
        saveUpdate={next}
        uploadImage={h.uploadImage}
        messages={MESSAGES}
        theme="light"
      />,
    );
    h.type('z');
    await h.advance(1_000);
    expect(next).toHaveBeenCalledTimes(1);
    expect(h.saveUpdate).not.toHaveBeenCalled();
  });
});

describe('read-only', () => {
  it('has no toolbar, no indicator, no field, and never saves', async () => {
    const h = mount({ editable: false });
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(h.surface.getAttribute('contenteditable')).toBe('false');
    expect(h.surface.querySelector('input')).toBeNull();
    expect(h.container.querySelector('input[type="file"]')).toBeNull();
    // Even a change made to the doc is not sent: nothing is subscribed.
    h.type('ghost');
    await h.advance(10_000);
    expect(h.saveUpdate).not.toHaveBeenCalled();
  });
});

describe('images', () => {
  const png = () =>
    new File([new Uint8Array([137, 80, 78, 71])], 'diagram.png', { type: 'image/png' });

  const imageSrcs = (editor: Editor) => {
    const srcs: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') srcs.push(node.attrs.src as string);
    });
    return srcs;
  };

  it('uploads a pasted image once and inserts it by the returned URL', async () => {
    const h = mount();
    fireEvent.paste(h.surface, {
      clipboardData: { files: [png()], getData: () => '', types: ['Files'] },
    });
    await act(async () => {});
    expect(h.uploadImage).toHaveBeenCalledTimes(1);
    expect(imageSrcs(h.editor)).toEqual(['https://cdn.test/diagram.png']);
    expect(h.surface.querySelector('img')?.getAttribute('src')).toBe(
      'https://cdn.test/diagram.png',
    );
  });

  it('leaves a paste with no image to the editor', async () => {
    const h = mount();
    fireEvent.paste(h.surface, {
      clipboardData: {
        files: [new File(['x'], 'notes.txt', { type: 'text/plain' })],
        getData: () => '',
        types: ['Files'],
      },
    });
    await act(async () => {});
    expect(h.uploadImage).not.toHaveBeenCalled();
  });

  it('uploads a dropped image', async () => {
    const h = mount();
    // jsdom has no layout, so the drop's coordinates resolve nowhere; pin them.
    h.editor.view.posAtCoords = () => ({ pos: 1, inside: -1 });
    fireEvent.drop(h.surface, {
      dataTransfer: { files: [png()], getData: () => '', types: ['Files'] },
    });
    await act(async () => {});
    expect(h.uploadImage).toHaveBeenCalledTimes(1);
    expect(imageSrcs(h.editor)).toEqual(['https://cdn.test/diagram.png']);
    // A drop with no image is the editor's.
    fireEvent.drop(h.surface, { dataTransfer: { files: [], getData: () => '', types: [] } });
    await act(async () => {});
    expect(h.uploadImage).toHaveBeenCalledTimes(1);
  });

  it('uploads an image picked from the toolbar', async () => {
    const h = mount();
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Insert image' }));
    expect(click).toHaveBeenCalledTimes(1);
    const input = h.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe('image/*');
    fireEvent.change(input, { target: { files: [png()] } });
    await act(async () => {});
    expect(h.uploadImage).toHaveBeenCalledTimes(1);
    expect(imageSrcs(h.editor)).toEqual(['https://cdn.test/diagram.png']);
    // Picking nothing does nothing.
    fireEvent.change(input, { target: { files: [] } });
    await act(async () => {});
    expect(h.uploadImage).toHaveBeenCalledTimes(1);
  });

  it('says so when an upload fails, and clears it on the next success', async () => {
    const uploadImage = vi.fn().mockRejectedValueOnce(new Error('413'));
    uploadImage.mockResolvedValueOnce({ url: 'https://cdn.test/ok.png' });
    const h = mount({ uploadImage });
    fireEvent.paste(h.surface, { clipboardData: { files: [png()], getData: () => '' } });
    await act(async () => {});
    expect(screen.getByRole('alert').textContent).toBe(MESSAGES.imageUploadFailed);
    expect(imageSrcs(h.editor)).toEqual([]);
    fireEvent.paste(h.surface, { clipboardData: { files: [png()], getData: () => '' } });
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
    expect(imageSrcs(h.editor)).toEqual(['https://cdn.test/ok.png']);
  });
});
