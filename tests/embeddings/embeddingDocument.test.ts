import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_DOCUMENT_MAX_CHARS,
  composeEmbeddingDocument,
  embeddingDocumentChanged,
  hashEmbeddingDocument,
} from '@/lib/workItems/embeddingDocument';

// The embedded document + its hash (Story MOTIR-2694 · Subtask MOTIR-2696, ADR
// §3). Pure unit tests — this module is the ONE definition three consumers share
// (the write path's emit gate, the job, the backfill), so the properties they
// each depend on are asserted here once rather than re-derived in each.

describe('composeEmbeddingDocument', () => {
  it('is title + blank line + description — the ADR §3 shape', () => {
    expect(
      composeEmbeddingDocument({ title: 'Board columns', descriptionMd: 'Remember collapse.' }),
    ).toBe('Board columns\n\nRemember collapse.');
  });

  it('keeps the separator when there is no description, so the pair maps 1:1 to a document', () => {
    // Without this, "Foo" + null and a title of "Foo\n\n" would compose the same
    // string — and therefore hash the same, making one an undetected edit of the
    // other.
    expect(composeEmbeddingDocument({ title: 'Foo', descriptionMd: null })).toBe('Foo\n\n');
    expect(composeEmbeddingDocument({ title: 'Foo', descriptionMd: '' })).toBe('Foo\n\n');
  });

  it('truncates at 8 000 characters', () => {
    const doc = composeEmbeddingDocument({ title: 'T', descriptionMd: 'x'.repeat(20_000) });
    expect(doc).toHaveLength(EMBEDDING_DOCUMENT_MAX_CHARS);
    expect(doc.startsWith('T\n\nxxx')).toBe(true);
  });

  it('excludes the explanation axis — it is not part of the input at all', () => {
    // `explanationMd` is the standing rationale, which answers a different
    // question than GATE 1's "does work like this already exist" (ADR §3). The
    // type makes it unpassable; this asserts the composition never grew a third
    // field by accident.
    const withExplanation = { title: 'T', descriptionMd: 'D', explanationMd: 'WHY' };
    expect(composeEmbeddingDocument(withExplanation)).toBe('T\n\nD');
  });
});

describe('hashEmbeddingDocument', () => {
  it('is a stable sha256 hex digest', () => {
    const hash = hashEmbeddingDocument('T\n\nD');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashEmbeddingDocument('T\n\nD')).toBe(hash);
  });

  it('differs for different documents', () => {
    expect(hashEmbeddingDocument('T\n\nD')).not.toBe(hashEmbeddingDocument('T\n\nE'));
  });
});

describe('embeddingDocumentChanged — the re-embed trigger (ADR §3)', () => {
  const base = { title: 'Board columns', descriptionMd: 'Remember collapse.' };

  it('is TRUE when the title moves', () => {
    expect(embeddingDocumentChanged(base, { ...base, title: 'Board columns v2' })).toBe(true);
  });

  it('is TRUE when the description moves', () => {
    expect(embeddingDocumentChanged(base, { ...base, descriptionMd: 'Forget collapse.' })).toBe(
      true,
    );
  });

  it('is FALSE when neither of the two "what" fields moved', () => {
    // The row-level fields a status flip / re-parent / sprint move / assignee
    // change touch are not inputs here at all, which is exactly why those writes
    // cost nothing.
    expect(embeddingDocumentChanged(base, { ...base })).toBe(false);
  });

  it('is FALSE for an edit BEYOND the truncation point', () => {
    // The comparison happens on composed DOCUMENTS, so two bodies that embed to
    // the same 8 000 characters are correctly judged unchanged — otherwise every
    // typo fix in a very long card would buy an identical vector.
    const long = 'x'.repeat(EMBEDDING_DOCUMENT_MAX_CHARS + 500);
    expect(
      embeddingDocumentChanged(
        { title: 'T', descriptionMd: `${long}AAA` },
        { title: 'T', descriptionMd: `${long}BBB` },
      ),
    ).toBe(false);
  });

  it('is TRUE for an edit INSIDE the truncation point of a very long body', () => {
    const tail = 'x'.repeat(EMBEDDING_DOCUMENT_MAX_CHARS);
    expect(
      embeddingDocumentChanged(
        { title: 'T', descriptionMd: `AAA${tail}` },
        { title: 'T', descriptionMd: `BBB${tail}` },
      ),
    ).toBe(true);
  });
});
