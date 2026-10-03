// FILES ON A GUIDE TURN — what Motir AI reads, within what limits, and how each
// file is resolved into the `guide_work_item` job's input (Story MOTIR-7471 ·
// MOTIR-7484; `docs/decisions/guide-turn-files.md` A3.3 / A3.4).
//
// A file is an attachment on the GUIDED card (A3.1). motir-ai cannot read the
// blob store and must not, so motir-core reads the bytes and sends each file of
// the CURRENT turn resolved:
//
//   | kind     | sent                                                        |
//   | -------- | ----------------------------------------------------------- |
//   | `image`  | `dataUrl` — `data:<mime>;base64,<bytes>`, inline (A3.4)     |
//   | `text`   | `text` — decoded UTF-8, the first 20,000 chars; `cut`       |
//   | `unread` | `reason` — why nothing of it is sent                        |
//
// An EARLIER turn's files are never re-sent: the history carries a one-line note
// per file (its name, its kind, and why it was not read).
//
// Pure apart from the injected byte reader, so every limit is unit-tested without
// a store. motir-ai re-checks each limit on its side (`parseGuideTurnFiles`);
// these are the ones that hold, because they decide what bytes leave core.

/** The most files one guide turn may carry (A3.3). */
export const GUIDE_FILES_MAX = 4;

/** The image types a model reads (A3.3). SVG is on the upload allow-list and is
 *  deliberately NOT here: it is markup that can carry script, not a raster. */
export const GUIDE_READABLE_IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/** The text types a model reads (A3.3). */
export const GUIDE_READABLE_TEXT_TYPES: readonly string[] = [
  'text/plain',
  'text/markdown',
  'text/csv',
];

/** The largest image sent to the model: 3.75 MiB raw, 5 MiB once base64-encoded
 *  — the smallest inline-image cap among the providers the gateway relays (A3.3). */
export const GUIDE_IMAGE_MAX_BYTES = 3.75 * 1024 * 1024;

/** The text read from ONE file — the first 20,000 characters (A3.3). */
export const GUIDE_FILE_TEXT_MAX = 20_000;

/** The text read across ONE turn's text files (A3.3). A file past the budget is
 *  attached and not read. */
export const GUIDE_TURN_TEXT_MAX = 40_000;

/** Why a file was attached and not read — the four reasons motir-core sends (A3.4). */
export type GuideFileUnreadReason =
  | 'type_not_read'
  | 'image_too_large'
  | 'not_utf8'
  | 'turn_text_budget';

/** One file of the CURRENT turn, as `context.guideContext.files[]` carries it. */
export type GuideContextFile =
  | { attachmentId: string; name: string; mime: string; kind: 'image'; dataUrl: string }
  | { attachmentId: string; name: string; mime: string; kind: 'text'; text: string; cut: boolean }
  | {
      attachmentId: string;
      name: string;
      mime: string;
      kind: 'unread';
      reason: GuideFileUnreadReason;
    };

/** The one-line note an EARLIER turn carries per file (`turns[i].files[]`). */
export interface GuideContextFileNote {
  name: string;
  kind: 'image' | 'text' | 'unread';
  reason?: GuideFileUnreadReason;
}

/** What the resolver needs to know about a file before it reads any byte. */
export interface GuideFileMeta {
  attachmentId: string;
  name: string;
  mime: string;
  sizeBytes: number;
}

/** A file whose bytes could not be read from the store. Not a reason the job is
 *  told: a file the person can see on the card but core cannot read is a fault,
 *  so the submit fails and the turn's retry reads it again. */
export class GuideFileUnavailableError extends Error {
  readonly code = 'GUIDE_FILE_UNAVAILABLE' as const;
  constructor(readonly attachmentId: string) {
    super(`The bytes of attachment ${attachmentId} could not be read.`);
    this.name = 'GuideFileUnavailableError';
  }
}

function normalisedMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

/** How a file WOULD be read, from its type and size alone — before any byte. */
export function guideFileKindOf(
  meta: Pick<GuideFileMeta, 'mime' | 'sizeBytes'>,
): { kind: 'image' } | { kind: 'text' } | { kind: 'unread'; reason: GuideFileUnreadReason } {
  const mime = normalisedMime(meta.mime);
  if (GUIDE_READABLE_IMAGE_TYPES.includes(mime)) {
    return meta.sizeBytes > GUIDE_IMAGE_MAX_BYTES
      ? { kind: 'unread', reason: 'image_too_large' }
      : { kind: 'image' };
  }
  if (GUIDE_READABLE_TEXT_TYPES.includes(mime)) return { kind: 'text' };
  return { kind: 'unread', reason: 'type_not_read' };
}

/**
 * Decode UTF-8 STRICTLY — a byte sequence that is not valid UTF-8 is `null`, not
 * a string full of replacement characters the model would read as content. A
 * leading byte-order mark is dropped.
 */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** The first {@link GUIDE_FILE_TEXT_MAX} characters, and whether that cut the text.
 *  A cut never splits a surrogate pair. */
export function cutGuideText(text: string): { text: string; cut: boolean } {
  if (text.length <= GUIDE_FILE_TEXT_MAX) return { text, cut: false };
  let end = GUIDE_FILE_TEXT_MAX;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

/**
 * The CURRENT turn's files, resolved in the order given (the order the person
 * added them). `read` returns a file's bytes, or null when the store has none —
 * which throws {@link GuideFileUnavailableError}. It is called only for a file
 * that will be read: an unreadable type or an oversize image is never fetched.
 *
 * The turn's text budget is spent in order: a text file whose (already cut) text
 * would pass the remaining budget is `unread: turn_text_budget`, whole — the rule
 * motir-ai applies on its side, so the two never disagree about a file.
 */
export async function resolveGuideFiles(
  files: readonly GuideFileMeta[],
  read: (attachmentId: string) => Promise<Uint8Array | null>,
): Promise<GuideContextFile[]> {
  const out: GuideContextFile[] = [];
  let budget = GUIDE_TURN_TEXT_MAX;
  for (const f of files) {
    const base = { attachmentId: f.attachmentId, name: f.name, mime: normalisedMime(f.mime) };
    const planned = guideFileKindOf(f);
    if (planned.kind === 'unread') {
      out.push({ ...base, kind: 'unread', reason: planned.reason });
      continue;
    }
    const bytes = await read(f.attachmentId);
    if (!bytes) throw new GuideFileUnavailableError(f.attachmentId);
    if (planned.kind === 'image') {
      // The stored size is what the upload recorded; the bytes are what will be
      // sent, so the cap is checked against them too.
      if (bytes.byteLength > GUIDE_IMAGE_MAX_BYTES) {
        out.push({ ...base, kind: 'unread', reason: 'image_too_large' });
        continue;
      }
      out.push({
        ...base,
        kind: 'image',
        dataUrl: `data:${base.mime};base64,${Buffer.from(bytes).toString('base64')}`,
      });
      continue;
    }
    const decoded = decodeUtf8(bytes);
    if (decoded === null) {
      out.push({ ...base, kind: 'unread', reason: 'not_utf8' });
      continue;
    }
    const { text, cut } = cutGuideText(decoded);
    if (text.length > budget) {
      out.push({ ...base, kind: 'unread', reason: 'turn_text_budget' });
      continue;
    }
    budget -= text.length;
    out.push({ ...base, kind: 'text', text, cut });
  }
  return out;
}

/**
 * The one-line notes an EARLIER turn's files ride the history as (A3.4) — from
 * their type and size, never their bytes, which are not read again. A text file
 * reads as `text`: whether it was cut, undecodable or over that turn's budget is
 * what motir-ai's reply to that turn already said.
 */
export function guideFileNotes(files: readonly GuideFileMeta[]): GuideContextFileNote[] {
  return files.map((f) => {
    const planned = guideFileKindOf(f);
    return planned.kind === 'unread'
      ? { name: f.name, kind: 'unread', reason: planned.reason }
      : { name: f.name, kind: planned.kind };
  });
}
