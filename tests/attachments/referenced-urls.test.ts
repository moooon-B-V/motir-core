import { describe, expect, it } from 'vitest';
import {
  BLOB_PUBLIC_HOST_SUFFIX,
  extractReferencedBlobUrls,
  extractReferencedBlobUrlsFromBodies,
} from '@/lib/blob/referencedUrls';

// Pure-parser tests for the link-on-write URL extractor (Subtask 5.2.3) —
// the sibling of tests/comments/mention-parse.test.ts. No DB: the helper is
// string work only; the DB half (linking) is covered by
// tests/attachments/link-on-write.test.ts.

const WS = 'ws_alpha123';
const HOST = `https://store1${BLOB_PUBLIC_HOST_SUFFIX}`; // store1.public.blob...
const ours = (file: string) => `${HOST}/attachments/${WS}/${file}`;

describe('extractReferencedBlobUrls', () => {
  it('extracts image embeds, file links, and bare pastes of our blob URLs', () => {
    const a = ours('shot-Ab12.png');
    const b = ours('spec-Cd34.pdf');
    const c = ours('raw-Ef56.txt');
    const body = `Intro ![shot](${a}) then [the spec](${b}) and bare ${c} end.`;
    expect(extractReferencedBlobUrls(body, WS)).toEqual([a, b, c]);
  });

  it('dedupes repeated references in first-seen order', () => {
    const a = ours('one-Aa.png');
    const b = ours('two-Bb.png');
    const body = `![x](${a}) ![y](${b}) again ![z](${a})`;
    expect(extractReferencedBlobUrls(body, WS)).toEqual([a, b]);
  });

  it('ignores foreign hosts — even ones carrying our pathname shape', () => {
    const body =
      `[evil](https://evil.example/attachments/${WS}/fake.png) ` +
      `[github](https://github.com/o/r/blob/main/x.png) ` +
      `[suffix-spoof](https://store1.public.blob.vercel-storage.com.evil.io/attachments/${WS}/f.png)`;
    expect(extractReferencedBlobUrls(body, WS)).toEqual([]);
  });

  it("ignores another WORKSPACE's uploads and non-attachment paths on our host", () => {
    const body =
      `![other-ws](${HOST}/attachments/ws_other999/leak.png) ` +
      `![not-attachments](${HOST}/avatars/${WS}/pic.png)`;
    expect(extractReferencedBlobUrls(body, WS)).toEqual([]);
  });

  it('null / undefined / empty / URL-free bodies extract to []', () => {
    expect(extractReferencedBlobUrls(null, WS)).toEqual([]);
    expect(extractReferencedBlobUrls(undefined, WS)).toEqual([]);
    expect(extractReferencedBlobUrls('', WS)).toEqual([]);
    expect(extractReferencedBlobUrls('plain prose, no links', WS)).toEqual([]);
  });

  it('malformed near-URLs are body text, never an error', () => {
    const a = ours('ok-Zz.png');
    const body = `https://] broken https:// nope ![ok](${a})`;
    expect(extractReferencedBlobUrls(body, WS)).toEqual([a]);
  });
});

describe('extractReferencedBlobUrlsFromBodies', () => {
  it('merges several bodies, deduped in first-seen order, skipping null bodies', () => {
    const a = ours('a-11.png');
    const b = ours('b-22.png');
    expect(
      extractReferencedBlobUrlsFromBodies([`![x](${a})`, null, `![y](${b}) ![x](${a})`], WS),
    ).toEqual([a, b]);
  });
});
