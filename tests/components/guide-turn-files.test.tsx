// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { GuideRail } from '@/components/planning/GuideRail';
import { PlanChangeComposer } from '@/components/planning/PlanChangeComposer';
import { deriveGuideView } from '@/lib/planning/guideView';
import type { AttachmentDTO } from '@/lib/dto/attachments';
import type { PlanChangeSessionDto, PlanChangeTurnDto } from '@/lib/dto/planChange';

// FILES ON A GUIDE TURN, in the rail (Story MOTIR-7471 · MOTIR-7486; design
// MOTIR-7482 `planning-workspace--guide-files.mock.html`). The upload is the
// item page's XHR to `POST /api/work-items/{id}/attachments`, so XMLHttpRequest
// is a fake each case answers by hand — which is what lets a case hold an upload
// in flight (Stop) or fail one file of two (Retry uploads only the failed one).

class FakeXhr {
  static all: FakeXhr[] = [];
  url = '';
  status = 0;
  responseText = '';
  body: FormData | null = null;
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(_method: string, url: string) {
    this.url = url;
  }
  send(body: FormData) {
    this.body = body;
    FakeXhr.all.push(this);
  }
  abort() {
    this.onabort?.();
  }
  get fileName(): string {
    return (this.body?.get('file') as File).name;
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  succeed(id: string) {
    this.status = 201;
    this.responseText = JSON.stringify({ id });
    this.onload?.();
  }
  fail(status: number, body: unknown = {}) {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
}

const last = () => FakeXhr.all[FakeXhr.all.length - 1]!;

let seq = 0;
function turn(
  role: PlanChangeTurnDto['role'],
  body = role === 'user' ? 'here it is' : 'Do step one.',
  attachmentIds?: string[],
): PlanChangeTurnDto {
  seq += 1;
  return {
    id: `t${seq}`,
    seq,
    role,
    body,
    jobId: null,
    question: null,
    isAnswer: false,
    intent: 'guide',
    intentCorrected: false,
    citations: [],
    authorId: role === 'user' ? 'u1' : null,
    createdAt: '2026-10-03T10:00:00.000Z',
    guide: null,
    ...(attachmentIds ? { attachmentIds } : {}),
  };
}

function session(
  turns: PlanChangeTurnDto[],
  attachments?: Record<string, AttachmentDTO>,
): PlanChangeSessionDto {
  return {
    id: 's1',
    projectId: 'p',
    targetKeys: ['MOTIR-9'],
    turnCount: turns.length,
    lastJobId: null,
    lastSubmittedAt: null,
    lastActivityAt: '2026-10-03T10:00:00.000Z',
    origin: 'guide',
    createdAt: '2026-10-03T10:00:00.000Z',
    updatedAt: '2026-10-03T10:00:00.000Z',
    turns,
    workItemRefs: {},
    ...(attachments ? { attachments } : {}),
  } as PlanChangeSessionDto;
}

function attachment(id: string, filename: string, mimeType: string): AttachmentDTO {
  return {
    id,
    workItemId: 'w9',
    filename,
    mimeType,
    sizeBytes: 2048,
    source: 'panel',
    blobUrl: `/api/attachments/${id}/content`,
    isImage: mimeType.startsWith('image/'),
    isPdf: mimeType === 'application/pdf',
    uploader: { id: 'u1', name: 'Yue', image: null },
    createdAt: '2026-10-03T10:00:00.000Z',
  };
}

const CARD = { id: 'w9', identifier: 'MOTIR-9', title: 'Rotate the key', kind: 'task' as const };

function renderRail(
  turns: PlanChangeTurnDto[] = [turn('assistant')],
  opts: { phase?: 'idle' | 'running'; attachments?: Record<string, AttachmentDTO> } = {},
) {
  const handlers = { onSend: vi.fn(), onRetry: vi.fn(), onReload: vi.fn() };
  const phase = opts.phase ?? 'idle';
  renderWithIntl(
    <GuideRail
      card={CARD}
      session={session(turns, opts.attachments)}
      view={deriveGuideView(turns, [], { idle: phase === 'idle' })}
      phase={phase}
      errorCode={null}
      outOfCredits={false}
      markers={[]}
      {...handlers}
    />,
  );
  return handlers;
}

const png = (name = 'console.png') => new File([new Uint8Array(10)], name, { type: 'image/png' });
const txt = (name = 'notes.txt') => new File(['KEY=abc'], name, { type: 'text/plain' });

function pick(...files: File[]) {
  fireEvent.change(screen.getByTestId('guide-attach-input'), { target: { files } });
}

const field = () => screen.getByRole('textbox') as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'Send' });
const chips = () => screen.queryAllByTestId('guide-file-chip');

beforeEach(() => {
  seq = 0;
  FakeXhr.all = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 200 })),
  );
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:local-thumb');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the attach control — guide only (A3.7)', () => {
  it('sits beside the target search, which guide mode keeps', () => {
    renderRail();
    expect(screen.getByTestId('planning-target-trigger')).toBeTruthy();
    const attach = screen.getByRole('button', { name: 'Attach files' });
    expect(attach.getAttribute('data-testid')).toBe('guide-attach-trigger');
    expect(attach.parentElement!.className).toContain('left-[34px]');
    expect(field().className).toContain('pl-[60px]');
  });

  it('is absent from every other composer, which takes no pasted image', () => {
    const onSubmit = vi.fn();
    renderWithIntl(
      <PlanChangeComposer
        draft=""
        onDraftChange={() => {}}
        targets={[]}
        onAddTarget={() => {}}
        onRemoveTarget={() => {}}
        onSubmit={onSubmit}
      />,
    );
    expect(screen.queryByTestId('guide-attach-trigger')).toBeNull();
    expect(screen.queryByTestId('guide-attach-input')).toBeNull();
    expect(field().className).toContain('pl-8');
    const pasted = fireEvent.paste(field(), { clipboardData: { files: [png()] } });
    expect(pasted).toBe(true); // not prevented: nothing took it
  });

  it('without the search, the attach control takes the first slot', () => {
    renderWithIntl(
      <PlanChangeComposer
        draft=""
        onDraftChange={() => {}}
        targets={[]}
        onAddTarget={() => {}}
        onRemoveTarget={() => {}}
        onSubmit={() => {}}
        mentions={false}
        attach={{
          onFiles: () => {},
          atCap: false,
          label: 'Attach files',
          tip: 'tip',
          capLabel: 'cap',
          accept: 'image/png',
        }}
      />,
    );
    expect(screen.getByTestId('guide-attach-trigger').parentElement!.className).toContain(
      'left-1.5',
    );
    expect(field().className).toContain('pl-8');
  });
});

describe('attach, paste and drop each queue a file', () => {
  it('attach: the picked files join the tray in order, an image with its thumbnail', () => {
    renderRail();
    const input = screen.getByTestId('guide-attach-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click');
    fireEvent.click(screen.getByTestId('guide-attach-trigger'));
    expect(click).toHaveBeenCalledTimes(1);
    pick(png(), txt());
    expect(chips().map((c) => c.textContent)).toEqual([
      expect.stringContaining('console.png'),
      expect.stringContaining('notes.txt'),
    ]);
    expect(chips()[0]!.querySelector('img')!.getAttribute('src')).toBe('blob:local-thumb');
    expect(chips()[0]!.textContent).toContain('PNG · ');
    expect(chips()[1]!.textContent).toContain('Text · ');
    expect(screen.getByRole('group', { name: 'Files on this turn' })).toBeTruthy();
  });

  it('an empty pick changes nothing', () => {
    renderRail();
    pick();
    expect(chips()).toHaveLength(0);
  });

  it('paste: a clipboard image joins the tray, named "Pasted image.png" when it has no name', () => {
    renderRail();
    const nameless = new File([new Uint8Array(4)], '', { type: 'image/png' });
    const pasted = fireEvent.paste(field(), { clipboardData: { files: [nameless] } });
    expect(pasted).toBe(false); // prevented: the image is a file, not text
    expect(chips()[0]!.textContent).toContain('Pasted image.png');
  });

  it('paste: text stays text', () => {
    renderRail();
    const pasted = fireEvent.paste(field(), { clipboardData: { files: [] } });
    expect(pasted).toBe(true);
    expect(chips()).toHaveLength(0);
  });

  it('drop: the rail is the target, drawn while files are over it', () => {
    renderRail();
    const rail = screen.getByTestId('guide-rail');
    const dataTransfer = { types: ['Files'], files: [txt('run.log')] };
    fireEvent.dragEnter(rail, { dataTransfer });
    const overlay = screen.getByTestId('guide-drop-overlay');
    expect(overlay.textContent).toContain('Drop to add to this turn');
    expect(overlay.textContent).toContain('They go on MOTIR-9 when you send.');
    fireEvent.dragOver(rail, { dataTransfer });
    fireEvent.drop(rail, { dataTransfer });
    expect(screen.queryByTestId('guide-drop-overlay')).toBeNull();
    expect(chips()[0]!.textContent).toContain('run.log');
  });

  it('drop: leaving the rail clears the target; dragged text is not a drop', () => {
    renderRail();
    const rail = screen.getByTestId('guide-rail');
    fireEvent.dragEnter(rail, { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(screen.queryByTestId('guide-drop-overlay')).toBeNull();
    fireEvent.dragEnter(rail, { dataTransfer: { types: ['Files'], files: [] } });
    expect(screen.getByTestId('guide-drop-overlay')).toBeTruthy();
    fireEvent.dragLeave(rail, { relatedTarget: null });
    expect(screen.queryByTestId('guide-drop-overlay')).toBeNull();
    fireEvent.drop(rail, { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(chips()).toHaveLength(0);
  });

  it('drop: no target while a turn runs', () => {
    renderRail([turn('assistant'), turn('user')], { phase: 'running' });
    fireEvent.dragEnter(screen.getByTestId('guide-rail'), {
      dataTransfer: { types: ['Files'], files: [] },
    });
    expect(screen.queryByTestId('guide-drop-overlay')).toBeNull();
  });

  it('a removed chip leaves the tray', () => {
    renderRail();
    pick(png(), txt());
    fireEvent.click(screen.getByRole('button', { name: 'Remove console.png' }));
    expect(chips()).toHaveLength(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-thumb');
  });
});

describe('the shipped refusals, and the cap of four (A3.3)', () => {
  it('a refused type shows the shipped message and never joins the queue', () => {
    renderRail();
    pick(new File(['x'], 'setup.exe', { type: 'application/x-msdownload' }));
    expect(chips()).toHaveLength(0);
    const row = screen.getByTestId('guide-file-refusal');
    expect(row.textContent).toBe("setup.exe — That file type isn't supported.");
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error for setup.exe' }));
    expect(screen.queryByTestId('guide-file-refusal')).toBeNull();
  });

  it('an oversize file shows the shipped size message', () => {
    renderRail();
    const big = new File([new Uint8Array(1)], 'huge.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    pick(big);
    expect(screen.getByTestId('guide-file-refusal').textContent).toContain(
      'File is too large — please choose a smaller file.',
    );
  });

  it('a fifth file is refused with the cap, and the control disables', () => {
    renderRail();
    pick(txt('1.txt'), txt('2.txt'), txt('3.txt'), txt('4.txt'), txt('5.txt'));
    expect(chips()).toHaveLength(4);
    expect(screen.getByTestId('guide-file-refusal').textContent).toBe(
      '5.txt — Up to 4 files a turn',
    );
    expect((screen.getByTestId('guide-attach-trigger') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a type the server refuses leaves the turn with the shipped message, unsent', async () => {
    const { onSend } = renderRail();
    pick(txt());
    fireEvent.click(sendButton());
    await act(async () => {
      last().fail(415, { code: 'UNSUPPORTED_FILE_TYPE' });
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(chips()).toHaveLength(0);
    expect(screen.getByTestId('guide-file-refusal').textContent).toContain(
      "That file type isn't supported.",
    );
    expect(screen.getByTestId('guide-files-not-sent')).toBeTruthy();
  });

  it('a plan cap refusal says which cap, from the catalogue', async () => {
    renderRail();
    pick(txt());
    fireEvent.click(sendButton());
    await act(async () => {
      last().fail(402, { code: 'ENTITLEMENT_EXCEEDED', entitlement: 'storage' });
    });
    const row = screen.getByTestId('guide-file-refusal');
    expect(row.textContent).toContain('notes.txt — ');
    expect(row.textContent).not.toContain('Upload failed');
  });
});

describe('Send uploads to the card, then sends the turn (A3.1)', () => {
  it('uploads each file in order to the guided card, then sends the ids with the words', async () => {
    const { onSend } = renderRail();
    fireEvent.change(field(), { target: { value: 'This is what I see' } });
    pick(png(), txt());
    fireEvent.click(sendButton());

    // Uploading: the running bar names the card, the field is read-only, and
    // the second file waits for the first.
    expect(screen.getByTestId('plan-change-running-bar').textContent).toContain(
      'Attaching 2 files to MOTIR-9… the turn sends when they are on it.',
    );
    expect(field().readOnly).toBe(true);
    expect(FakeXhr.all).toHaveLength(1);
    expect(last().url).toBe('/api/work-items/w9/attachments');
    expect(last().fileName).toBe('console.png');
    expect(chips()[1]!.textContent).toContain('Waiting');

    await act(async () => {
      last().progress(50, 100);
    });
    expect(chips()[0]!.textContent).toContain('Uploading… 50%');
    await act(async () => {
      last().succeed('a1');
    });
    expect(chips()[0]!.textContent).toContain('On MOTIR-9');
    expect(last().fileName).toBe('notes.txt');
    expect(chips()[1]!.textContent).toContain('Uploading…');
    await act(async () => {
      last().succeed('a2');
    });

    expect(onSend).toHaveBeenCalledWith('This is what I see', ['a1', 'a2']);
    expect(chips()).toHaveLength(0);
    expect(field().value).toBe('');
    expect(screen.queryByTestId('plan-change-running-bar')).toBeNull();
  });

  it('a turn of files alone sends — Send is enabled with no words', async () => {
    const { onSend } = renderRail();
    expect((sendButton() as HTMLButtonElement).disabled).toBe(true);
    pick(png());
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sendButton());
    await act(async () => {
      last().succeed('a1');
    });
    expect(onSend).toHaveBeenCalledWith('', ['a1']);
  });

  it('words alone send as they always have, with no upload', () => {
    const { onSend } = renderRail();
    fireEvent.change(field(), { target: { value: 'next step' } });
    fireEvent.click(sendButton());
    expect(onSend).toHaveBeenCalledWith('next step');
    expect(FakeXhr.all).toHaveLength(0);
    expect(field().value).toBe('');
  });

  it('a failed upload keeps the words, sends nothing, and Retry uploads only what failed', async () => {
    const { onSend } = renderRail();
    fireEvent.change(field(), { target: { value: 'see attached' } });
    pick(png(), txt());
    fireEvent.click(sendButton());
    await act(async () => {
      last().succeed('a1');
    });
    await act(async () => {
      last().fail(500, 'not json');
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(field().value).toBe('see attached');
    expect(screen.getByTestId('guide-files-not-sent').textContent).toBe(
      "Not sent. One file didn't upload, so Motir AI hasn't seen this turn. Your words are kept, and the files already on MOTIR-9 stay there.",
    );
    const failed = chips()[1]!;
    expect(failed.getAttribute('data-status')).toBe('failed');
    expect(chips()[0]!.getAttribute('data-status')).toBe('done');

    fireEvent.click(within(failed).getByTestId('guide-file-retry'));
    expect(FakeXhr.all).toHaveLength(3);
    expect(last().fileName).toBe('notes.txt'); // the done file is not uploaded twice
    await act(async () => {
      last().succeed('a2');
    });
    expect(onSend).toHaveBeenCalledWith('see attached', ['a1', 'a2']);
  });

  it('a network error is a failed chip too', async () => {
    renderRail();
    pick(txt());
    fireEvent.click(sendButton());
    await act(async () => {
      last().onerror?.();
    });
    expect(chips()[0]!.getAttribute('data-status')).toBe('failed');
  });

  it('a 201 the client cannot read is a failure, not a sent turn', async () => {
    const { onSend } = renderRail();
    pick(txt());
    fireEvent.click(sendButton());
    await act(async () => {
      last().status = 201;
      last().responseText = '<html>';
      last().onload?.();
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(chips()[0]!.getAttribute('data-status')).toBe('failed');
  });

  it('removing the failed file clears the not-sent line', async () => {
    renderRail();
    pick(txt());
    fireEvent.click(sendButton());
    await act(async () => {
      last().fail(500);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(screen.queryByTestId('guide-files-not-sent')).toBeNull();
  });

  it('Stop stops the send: the upload is cancelled and nothing is sent', async () => {
    const { onSend } = renderRail();
    fireEvent.change(field(), { target: { value: 'keep me' } });
    pick(txt());
    fireEvent.click(sendButton());
    await act(async () => {
      fireEvent.click(screen.getByTestId('plan-change-stop'));
    });
    expect(onSend).not.toHaveBeenCalled();
    expect(field().value).toBe('keep me');
    expect(chips()[0]!.getAttribute('data-status')).toBe('waiting');
    expect(screen.queryByTestId('guide-files-not-sent')).toBeNull();
  });
});

describe('the sent turn (panel 8)', () => {
  const ATTACHMENTS = {
    img: attachment('img', 'console.png', 'image/png'),
    txt: attachment('txt', 'vercel-env.md', 'text/markdown'),
  };

  it('shows a thumbnail for an image that opens the shipped preview', () => {
    renderRail([turn('user', 'look', ['img', 'txt', 'gone']), turn('assistant')], {
      attachments: ATTACHMENTS,
    });
    const files = screen.getAllByTestId('guide-turn-file');
    expect(files).toHaveLength(2);
    expect(files[0]!.querySelector('img')!.getAttribute('src')).toBe(
      '/api/attachments/img/content',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Preview console.png' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a text file is a chip that downloads — the item page’s activation split', () => {
    renderRail([turn('user', 'look', ['txt']), turn('assistant')], { attachments: ATTACHMENTS });
    const chip = screen.getByTestId('guide-turn-file');
    expect(chip.textContent).toContain('vercel-env.md');
    expect(chip.textContent).toContain('Markdown · ');
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(chip);
    expect(click).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a file removed from the card is a dashed Removed chip', () => {
    renderRail([turn('user', 'look', ['gone']), turn('assistant')], { attachments: {} });
    expect(screen.getByTestId('guide-turn-file-removed').textContent).toBe('Removed');
  });

  it('a turn of files alone draws its chips and no empty bubble', () => {
    renderRail([turn('user', '', ['img']), turn('assistant')], { attachments: ATTACHMENTS });
    expect(screen.getByTestId('guide-turn-file')).toBeTruthy();
    expect(screen.queryByText('Turn 1')).toBeNull();
  });

  it('the act line counts the files being read', () => {
    renderRail([turn('assistant'), turn('user', 'look', ['img', 'txt'])], {
      phase: 'running',
      attachments: ATTACHMENTS,
    });
    expect(screen.getByTestId('guide-progress-line').textContent).toContain(
      'Reading your 2 files and MOTIR-9…',
    );
  });
});
