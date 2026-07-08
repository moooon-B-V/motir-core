import { describe, expect, it } from 'vitest';
import {
  attachmentContentPath,
  extractReferencedAttachmentIds,
  extractReferencedAttachmentIdsFromBodies,
} from '@/lib/blob/referencedUrls';

// Pure-parser tests for the link-on-write ID extractor (Subtask 5.2.3; id-based
// since MOTIR-1668). No DB: string work only; the DB half (workspace-scoped
// linking) is tests/attachments/link-on-write.test.ts. Content attachments are
// PRIVATE and embed as their authenticated content path
// `/api/attachments/<id>/content` — tenancy is enforced at the DB, not here, so
// a foreign id would extract but can never link.

const cp = (id: string) => attachmentContentPath(id);

describe('extractReferencedAttachmentIds', () => {
  it('extracts image embeds, file links, and bare pastes of content paths', () => {
    const a = 'aaa111';
    const b = 'bbb222';
    const c = 'ccc333';
    const body = `Intro ![shot](${cp(a)}) then [the spec](${cp(b)}) and bare ${cp(c)} end.`;
    expect(extractReferencedAttachmentIds(body)).toEqual([a, b, c]);
  });

  it('dedupes repeated references in first-seen order', () => {
    const a = 'onea11';
    const b = 'twob22';
    const body = `![x](${cp(a)}) ![y](${cp(b)}) again ![z](${cp(a)})`;
    expect(extractReferencedAttachmentIds(body)).toEqual([a, b]);
  });

  it('ignores non-content attachment paths and other app routes', () => {
    const body =
      `[thumb](/api/attachments/xyz789/thumbnail) ` +
      `[item](/api/work-items/wi12345/content) ` +
      `[plain](https://example.com/pic.png)`;
    expect(extractReferencedAttachmentIds(body)).toEqual([]);
  });

  it('null / undefined / empty / path-free bodies extract to []', () => {
    expect(extractReferencedAttachmentIds(null)).toEqual([]);
    expect(extractReferencedAttachmentIds(undefined)).toEqual([]);
    expect(extractReferencedAttachmentIds('')).toEqual([]);
    expect(extractReferencedAttachmentIds('plain prose, no links')).toEqual([]);
  });
});

describe('extractReferencedAttachmentIdsFromBodies', () => {
  it('merges several bodies, deduped in first-seen order, skipping null bodies', () => {
    const a = 'a11aaa';
    const b = 'b22bbb';
    expect(
      extractReferencedAttachmentIdsFromBodies([
        `![x](${cp(a)})`,
        null,
        `![y](${cp(b)}) ![x](${cp(a)})`,
      ]),
    ).toEqual([a, b]);
  });
});
