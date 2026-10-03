import { describe, expect, it, vi } from 'vitest';

import {
  GUIDE_FILE_TEXT_MAX,
  GUIDE_IMAGE_MAX_BYTES,
  GUIDE_TURN_TEXT_MAX,
  GuideFileUnavailableError,
  cutGuideText,
  decodeUtf8,
  guideFileKindOf,
  guideFileNotes,
  resolveGuideFiles,
  type GuideFileMeta,
} from '@/lib/ai/guideFiles';

// FILES ON A GUIDE TURN (Story MOTIR-7471 · MOTIR-7484), pure: the readable set,
// the limits and the resolution into `guideContext.files`, against
// `docs/decisions/guide-turn-files.md` A3.3 / A3.4. The store is a Map.

const enc = (s: string) => new TextEncoder().encode(s);
const meta = (id: string, name: string, mime: string, sizeBytes = 10): GuideFileMeta => ({
  attachmentId: id,
  name,
  mime,
  sizeBytes,
});

function store(entries: Record<string, Uint8Array>) {
  const read = vi.fn(async (id: string) => entries[id] ?? null);
  return read;
}

describe('guideFileKindOf — the readable set (A3.3)', () => {
  it.each([
    ['image/png', 'image'],
    ['image/jpeg', 'image'],
    ['image/webp', 'image'],
    ['image/gif', 'image'],
    ['text/plain', 'text'],
    ['text/markdown', 'text'],
    ['text/csv', 'text'],
    ['TEXT/PLAIN; charset=utf-8', 'text'],
  ])('%s is read as %s', (mime, kind) => {
    expect(guideFileKindOf({ mime, sizeBytes: 1 }).kind).toBe(kind);
  });

  it.each(['image/svg+xml', 'application/pdf', 'application/zip', 'application/msword', ''])(
    '%s is attached and NOT read',
    (mime) => {
      expect(guideFileKindOf({ mime, sizeBytes: 1 })).toEqual({
        kind: 'unread',
        reason: 'type_not_read',
      });
    },
  );

  it('an image over 3.75 MiB is attached and not read; one at the cap is read', () => {
    expect(guideFileKindOf({ mime: 'image/png', sizeBytes: GUIDE_IMAGE_MAX_BYTES })).toEqual({
      kind: 'image',
    });
    expect(guideFileKindOf({ mime: 'image/png', sizeBytes: GUIDE_IMAGE_MAX_BYTES + 1 })).toEqual({
      kind: 'unread',
      reason: 'image_too_large',
    });
  });
});

describe('decodeUtf8 / cutGuideText', () => {
  it('decodes UTF-8, drops a BOM, and refuses invalid bytes rather than guessing', () => {
    expect(decodeUtf8(enc('héllo'))).toBe('héllo');
    expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
    expect(decodeUtf8(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
  });

  it('cuts at 20,000 characters and says so, never splitting a surrogate pair', () => {
    expect(cutGuideText('abc')).toEqual({ text: 'abc', cut: false });
    const exact = 'x'.repeat(GUIDE_FILE_TEXT_MAX);
    expect(cutGuideText(exact)).toEqual({ text: exact, cut: false });
    const long = cutGuideText('y'.repeat(GUIDE_FILE_TEXT_MAX + 5));
    expect(long.cut).toBe(true);
    expect(long.text).toHaveLength(GUIDE_FILE_TEXT_MAX);
    const pair = 'x'.repeat(GUIDE_FILE_TEXT_MAX - 1) + '😀' + 'z';
    const cut = cutGuideText(pair);
    expect(cut.cut).toBe(true);
    expect(cut.text).toHaveLength(GUIDE_FILE_TEXT_MAX - 1);
  });
});

describe('resolveGuideFiles — the current turn (A3.4)', () => {
  it('sends an image INLINE as a data URL, and a text file decoded', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const read = store({ img: png, txt: enc('KEY_ID=abc\n') });
    const files = await resolveGuideFiles(
      [meta('img', 'console.png', 'image/png'), meta('txt', 'notes.txt', 'text/plain')],
      read,
    );
    expect(files).toEqual([
      {
        attachmentId: 'img',
        name: 'console.png',
        mime: 'image/png',
        kind: 'image',
        dataUrl: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
      },
      {
        attachmentId: 'txt',
        name: 'notes.txt',
        mime: 'text/plain',
        kind: 'text',
        text: 'KEY_ID=abc\n',
        cut: false,
      },
    ]);
  });

  it('a PDF and an SVG ride by name and kind only — their bytes are never read', async () => {
    const read = store({});
    const files = await resolveGuideFiles(
      [meta('pdf', 'guide.pdf', 'application/pdf'), meta('svg', 'logo.svg', 'image/svg+xml')],
      read,
    );
    expect(files).toEqual([
      {
        attachmentId: 'pdf',
        name: 'guide.pdf',
        mime: 'application/pdf',
        kind: 'unread',
        reason: 'type_not_read',
      },
      {
        attachmentId: 'svg',
        name: 'logo.svg',
        mime: 'image/svg+xml',
        kind: 'unread',
        reason: 'type_not_read',
      },
    ]);
    expect(read).not.toHaveBeenCalled();
  });

  it('a text file past 20,000 characters is cut and flagged', async () => {
    const read = store({ big: enc('a'.repeat(GUIDE_FILE_TEXT_MAX + 100)) });
    const [file] = await resolveGuideFiles([meta('big', 'big.log', 'text/plain')], read);
    expect(file).toMatchObject({ kind: 'text', cut: true });
    expect(file!.kind === 'text' && file!.text.length).toBe(GUIDE_FILE_TEXT_MAX);
  });

  it('a file past the turn’s 40,000-character budget is attached and not read', async () => {
    const twenty = 'b'.repeat(GUIDE_FILE_TEXT_MAX);
    const read = store({ one: enc(twenty), two: enc(twenty), three: enc('c'), four: enc(twenty) });
    const files = await resolveGuideFiles(
      [
        meta('one', '1.txt', 'text/plain'),
        meta('two', '2.txt', 'text/plain'),
        meta('three', '3.txt', 'text/plain'),
        meta('four', '4.csv', 'text/csv'),
      ],
      read,
    );
    expect(GUIDE_TURN_TEXT_MAX).toBe(2 * GUIDE_FILE_TEXT_MAX);
    expect(files.map((f) => (f.kind === 'unread' ? f.reason : f.kind))).toEqual([
      'text',
      'text',
      'turn_text_budget',
      'turn_text_budget',
    ]);
  });

  it('a text file that is not UTF-8 is attached and not read', async () => {
    const read = store({ bin: new Uint8Array([0xc3, 0x28]) });
    expect(await resolveGuideFiles([meta('bin', 'x.txt', 'text/plain')], read)).toEqual([
      {
        attachmentId: 'bin',
        name: 'x.txt',
        mime: 'text/plain',
        kind: 'unread',
        reason: 'not_utf8',
      },
    ]);
  });

  it('an oversize image is never fetched; one whose bytes run over the cap is not sent', async () => {
    const read = store({ ok: new Uint8Array(GUIDE_IMAGE_MAX_BYTES + 1) });
    const files = await resolveGuideFiles(
      [
        meta('huge', 'huge.png', 'image/png', GUIDE_IMAGE_MAX_BYTES + 1),
        meta('ok', 'liar.png', 'image/png', 10),
      ],
      read,
    );
    expect(files.map((f) => f.kind === 'unread' && f.reason)).toEqual([
      'image_too_large',
      'image_too_large',
    ]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a readable file the store has no bytes for is a fault, not a reason', async () => {
    await expect(
      resolveGuideFiles([meta('gone', 'gone.png', 'image/png')], store({})),
    ).rejects.toBeInstanceOf(GuideFileUnavailableError);
  });
});

describe('guideFileNotes — an earlier turn (A3.4)', () => {
  it('is one note per file from its type and size, never its bytes', () => {
    expect(
      guideFileNotes([
        meta('a', 'shot.png', 'image/png'),
        meta('b', 'run.log', 'text/plain'),
        meta('c', 'spec.pdf', 'application/pdf'),
        meta('d', 'huge.jpg', 'image/jpeg', GUIDE_IMAGE_MAX_BYTES + 1),
      ]),
    ).toEqual([
      { name: 'shot.png', kind: 'image' },
      { name: 'run.log', kind: 'text' },
      { name: 'spec.pdf', kind: 'unread', reason: 'type_not_read' },
      { name: 'huge.jpg', kind: 'unread', reason: 'image_too_large' },
    ]);
  });
});
