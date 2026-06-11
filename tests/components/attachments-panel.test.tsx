// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl as render } from '../helpers/renderWithIntl';
import type { AttachmentDTO, AttachmentsPageDTO } from '@/lib/dto/attachments';
import { MAX_UPLOAD_BYTES } from '@/lib/blob/allowlist';

// AttachmentsPanel (Subtask 5.2.5) — the detail page's attachments surface.
// Covers the role-matrix rendering (viewer / uploader-own / delete-all), the
// editor-sourced delete block, the "Show more (N)" paging read, the strip/list
// toggle + its localStorage persistence, the upload error mapping (the
// client-side allowlist pre-check + the route's typed codes), and the
// empty / error states — the panel's own client logic; the service matrix +
// the live journey belong to the 5.2.2 integration tests and the 5.2.8 story
// E2E.

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { AttachmentsPanel } from '@/app/(authed)/issues/[key]/_components/AttachmentsPanel';
import { resetAttachmentsViewForTests } from '@/lib/hooks/useAttachmentsView';

const ME = { id: 'user-me', name: 'Zhu Yue', image: null };
const BO = { id: 'user-bo', name: 'Bo Philips', image: null };

let attachmentSeq = 0;
function attachment(overrides: Partial<AttachmentDTO> = {}): AttachmentDTO {
  attachmentSeq += 1;
  return {
    id: `att-${attachmentSeq}`,
    workItemId: 'wi-1',
    filename: `file-${attachmentSeq}.png`,
    mimeType: 'image/png',
    sizeBytes: 1258291, // 1.2 MB
    source: 'panel',
    blobUrl: `https://store.public.blob.vercel-storage.com/attachments/ws-1/file-${attachmentSeq}.png`,
    isImage: true,
    isPdf: false,
    uploader: ME,
    createdAt: new Date(Date.now() - attachmentSeq * 60_000).toISOString(),
    ...overrides,
  };
}

function page(
  attachments: AttachmentDTO[],
  overrides: Partial<AttachmentsPageDTO> = {},
): AttachmentsPageDTO {
  return { attachments, totalCount: attachments.length, nextCursor: null, ...overrides };
}

function renderPanel(
  initialPage: AttachmentsPageDTO | null,
  props: Partial<Parameters<typeof AttachmentsPanel>[0]> = {},
) {
  return render(
    <AttachmentsPanel
      workItemId="wi-1"
      canCreate
      canDeleteAll={false}
      currentUserId={ME.id}
      initialPage={initialPage}
      {...props}
    />,
  );
}

/** Find the hidden multi-select file input the Attach button drives. */
function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error('file input not rendered');
  return input as HTMLInputElement;
}

function makeFile(name: string, type: string, size?: number): File {
  const file = new File(['x'], name, { type });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}

beforeEach(() => {
  window.localStorage.clear();
  resetAttachmentsViewForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

describe('role matrix', () => {
  it('viewer (no create, no delete-all): no Attach, no dropzone input, no delete controls', () => {
    const { container } = renderPanel(page([attachment({ uploader: BO })]), {
      canCreate: false,
    });
    expect(screen.queryByRole('button', { name: 'Attach' })).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Download/ }).length).toBeGreaterThan(0);
  });

  it('member deletes own only', () => {
    const mine = attachment({ filename: 'mine.png', uploader: ME });
    const theirs = attachment({ filename: 'theirs.png', uploader: BO });
    renderPanel(page([mine, theirs]));
    expect(screen.getByRole('button', { name: 'Delete mine.png' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete theirs.png' })).toBeNull();
  });

  it('delete-all deletes another uploader’s file', () => {
    const theirs = attachment({ filename: 'theirs.png', uploader: BO });
    renderPanel(page([theirs]), { canDeleteAll: true });
    expect(screen.getByRole('button', { name: 'Delete theirs.png' })).toBeTruthy();
  });

  it('read-only empty state drops the affordance hint', () => {
    renderPanel(page([]), { canCreate: false });
    expect(screen.getByText('No attachments yet')).toBeTruthy();
  });
});

describe('editor-sourced block', () => {
  it('renders the source chip and a disabled delete instead of the confirm', () => {
    const embedded = attachment({ filename: 'flow.png', source: 'editor', uploader: ME });
    renderPanel(page([embedded]));
    expect(screen.getByText('Embedded')).toBeTruthy();
    const blocked = screen.getByRole('button', {
      name: 'Delete flow.png — unavailable, added in the editor',
    });
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(blocked);
    // No confirm popover opens for the blocked control.
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('delete confirm', () => {
  it('names the file, DELETEs on confirm, removes the row, and refreshes', async () => {
    const mine = attachment({ filename: 'mine.png', uploader: ME });
    const other = attachment({ filename: 'keep.png', uploader: ME });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    renderPanel(page([mine, other]));

    fireEvent.click(screen.getByRole('button', { name: 'Delete mine.png' }));
    expect(screen.getByText("Delete mine.png? Attachments can't be restored.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`/api/attachments/${mine.id}`, {
        method: 'DELETE',
      }),
    );
    await waitFor(() => expect(screen.queryByText('mine.png')).toBeNull());
    expect(screen.getByText('keep.png')).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it('maps the typed delete errors into the popover', async () => {
    const mine = attachment({ filename: 'mine.png', uploader: ME });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 'ATTACHMENT_FORBIDDEN' }), { status: 403 }),
        ),
    );
    renderPanel(page([mine]));
    fireEvent.click(screen.getByRole('button', { name: 'Delete mine.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(screen.getByText("You don't have permission to do that.")).toBeTruthy(),
    );
    // The row stays.
    expect(screen.getByText('mine.png')).toBeTruthy();
  });
});

describe('paging (finding #57)', () => {
  it('shows "Show more (N)" and extends the window with the cursor read', async () => {
    const loaded = [attachment(), attachment()];
    const older = [
      attachment({ filename: 'older-1.png' }),
      attachment({ filename: 'older-2.png' }),
      attachment({ filename: 'older-3.png' }),
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(page(older, { totalCount: 5 })), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    renderPanel(page(loaded, { totalCount: 5, nextCursor: loaded[1]!.id }));
    const showMore = screen.getByRole('button', { name: 'Show more (3)' });
    fireEvent.click(showMore);

    await waitFor(() => expect(screen.getByText('older-3.png')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/work-items/wi-1/attachments?cursor=${loaded[1]!.id}`,
    );
    // Everything loaded — the pager disappears.
    expect(screen.queryByRole('button', { name: /Show more/ })).toBeNull();
  });
});

describe('strip/list toggle', () => {
  it('flips to the densified rows (size + uploader) and persists the choice', () => {
    const att = attachment({
      filename: 'sheet.csv',
      mimeType: 'text/csv',
      isImage: false,
      uploader: BO,
    });
    renderPanel(page([att]));
    // Strip is the default; uploader name is a list-only column.
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByText('Bo Philips')).toBeTruthy();
    expect(screen.getByText('1.2 MB')).toBeTruthy();
    expect(window.localStorage.getItem('motir.issues.attachments.view')).toBe('list');
  });
});

describe('upload', () => {
  it('pre-checks the shared allowlist: oversized and unsupported files error inline without a request', () => {
    const { container } = renderPanel(page([]));
    fireEvent.change(fileInput(container), {
      target: {
        files: [
          makeFile('huge.png', 'image/png', MAX_UPLOAD_BYTES + 1),
          makeFile('clip.mov', 'video/quicktime'),
        ],
      },
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('File is too large — please choose a smaller file.');
    expect(alert.textContent).toContain("That file type isn't supported.");
    // Dismiss isolates per file.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error for huge.png' }));
    expect(screen.getByRole('alert').textContent).not.toContain('File is too large');
    expect(screen.getByRole('alert').textContent).toContain("That file type isn't supported.");
  });

  it('posts via XHR, shows progress, and lands the returned DTO as a card', async () => {
    const instances: FakeXHR[] = [];
    class FakeXHR {
      upload = { onprogress: null as null | ((e: ProgressEvent) => void) };
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      onabort: null | (() => void) = null;
      status = 0;
      responseText = '';
      open = vi.fn();
      send = vi.fn(() => {
        instances.push(this);
      });
      abort = vi.fn();
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);

    const { container } = renderPanel(page([]));
    fireEvent.change(fileInput(container), {
      target: { files: [makeFile('shot.png', 'image/png', 2048)] },
    });

    await waitFor(() => expect(instances).toHaveLength(1));
    expect(screen.getByText('Uploading…')).toBeTruthy();

    const dto = attachment({ filename: 'shot.png' });
    instances[0]!.status = 201;
    instances[0]!.responseText = JSON.stringify(dto);
    await act(async () => {
      instances[0]!.onload?.();
    });

    await waitFor(() => expect(screen.getByText('shot.png')).toBeTruthy());
    expect(screen.queryByText('Uploading…')).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it('maps the route’s typed 429 onto the localized banner', async () => {
    const instances: FakeXHR[] = [];
    class FakeXHR {
      upload = { onprogress: null as null | ((e: ProgressEvent) => void) };
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      onabort: null | (() => void) = null;
      status = 0;
      responseText = '';
      open = vi.fn();
      send = vi.fn(() => {
        instances.push(this);
      });
      abort = vi.fn();
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR);

    const { container } = renderPanel(page([]));
    fireEvent.change(fileInput(container), {
      target: { files: [makeFile('batch-7.png', 'image/png', 2048)] },
    });
    await waitFor(() => expect(instances).toHaveLength(1));

    instances[0]!.status = 429;
    instances[0]!.responseText = JSON.stringify({ code: 'RATE_LIMITED' });
    await act(async () => {
      instances[0]!.onload?.();
    });

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Too many uploads — please wait a moment and try again.',
      ),
    );
  });
});

describe('states', () => {
  it('inviting empty state keeps the Attach affordance live', () => {
    renderPanel(page([]));
    expect(screen.getByText('No attachments yet — attach a file or drop one here')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Attach' })).toBeTruthy();
  });

  it('failed initial read renders ErrorState and retry refetches', async () => {
    const att = attachment({ filename: 'recovered.png' });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(page([att])), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    renderPanel(null);
    expect(screen.getByText("Couldn't load attachments")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByText('recovered.png')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/work-items/wi-1/attachments');
  });
});

describe('preview lightbox (5.2.6)', () => {
  const image = () =>
    attachment({ filename: 'photo.png', mimeType: 'image/png', isImage: true, isPdf: false });
  const pdf = () =>
    attachment({
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      isImage: false,
      isPdf: true,
    });
  const zip = () =>
    attachment({
      filename: 'bundle.zip',
      mimeType: 'application/zip',
      isImage: false,
      isPdf: false,
    });

  /** Swallow the transient download anchor's click; collect the hrefs. */
  function spyDownloads(): string[] {
    const hrefs: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      hrefs.push(this.href);
    });
    return hrefs;
  }

  it('an image card opens the lightbox: labelled dialog, contain-fit img with filename alt, header name + size + Download', () => {
    const att = image();
    renderPanel(page([att]));

    fireEvent.click(screen.getByRole('button', { name: 'Preview photo.png' }));

    const dialog = screen.getByRole('dialog', { name: 'photo.png' });
    const img = within(dialog).getByRole('img', { name: 'photo.png' });
    expect(img.getAttribute('src')).toBe(att.blobUrl);
    expect(within(dialog).getByText('1.2 MB')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Download' })).toBeTruthy();
  });

  it('a PDF card opens the embedded frame with the can’t-inline fallback path', () => {
    const att = pdf();
    renderPanel(page([att]));

    fireEvent.click(screen.getByRole('button', { name: 'Preview report.pdf' }));

    const dialog = screen.getByRole('dialog', { name: 'report.pdf' });
    const frame = dialog.querySelector('object');
    expect(frame?.getAttribute('data')).toBe(att.blobUrl);
    expect(frame?.getAttribute('type')).toBe('application/pdf');
    // The fallback (rendered when the browser can't inline) carries the
    // download-instead message + its own Download affordance.
    expect(
      within(dialog).getByText("Preview isn't available here — download the file instead."),
    ).toBeTruthy();
  });

  it('a non-previewable card never opens the lightbox — activation downloads', () => {
    const att = zip();
    const hrefs = spyDownloads();
    renderPanel(page([att]));

    // The open target is labelled as a download, not a preview.
    expect(screen.queryByRole('button', { name: 'Preview bundle.zip' })).toBeNull();
    const [open] = screen.getAllByRole('button', { name: 'Download bundle.zip' });
    if (!open) throw new Error('open target not rendered');
    fireEvent.click(open);

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(hrefs).toHaveLength(1);
    expect(hrefs[0]).toContain('download=1');
  });

  it('keyboard path: Esc closes the lightbox', async () => {
    // Radix owns focus-trap + return-focus; happy-dom never fires its
    // unmount focus restore (verified against a minimal Modal harness), so
    // the return-focus half of the contract is asserted in the 5.2.8
    // Playwright journey ("Esc returns focus") against a real browser.
    renderPanel(page([image()]));
    const open = screen.getByRole('button', { name: 'Preview photo.png' });
    open.focus();
    fireEvent.click(open);

    const dialog = screen.getByRole('dialog', { name: 'photo.png' });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the header close × closes the lightbox', async () => {
    renderPanel(page([image()]));
    fireEvent.click(screen.getByRole('button', { name: 'Preview photo.png' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
