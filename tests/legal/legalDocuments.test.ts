import { describe, expect, it } from 'vitest';
import {
  byPreferredOrder,
  getLegalDocument,
  legalDocumentSlugs,
  listLegalDocuments,
  parseLegalDocument,
} from '@/lib/legal/documents';

// The legal-document loader (MOTIR-1134).
//
// Two halves, deliberately. `parseLegalDocument` is PURE, so every branch is
// reachable from a string and the edge cases are tested exhaustively there.
// The filesystem half is tested against the REAL `content/legal/` directory,
// because the property that matters about it — "every published document has a
// route" — is a claim about the actual tree and is worthless against a fixture.

describe('parseLegalDocument', () => {
  const full = [
    '---',
    'title: Terms of Service',
    'version: 1.2.0',
    'effectiveDate: 2026-09-01',
    'status: approved',
    '---',
    '',
    '# Terms',
    'body text',
  ].join('\n');

  it('reads the four front-matter keys and strips them from the body', () => {
    const doc = parseLegalDocument('terms', full);
    expect(doc).toMatchObject({
      slug: 'terms',
      title: 'Terms of Service',
      version: '1.2.0',
      effectiveDate: '2026-09-01',
      status: 'approved',
    });
    expect(doc.body).toBe('\n# Terms\nbody text');
    expect(doc.body).not.toContain('title:');
  });

  it('maps the TBD sentinel to null rather than passing it through', () => {
    // ⚠️ The point of the whole sentinel. A published policy whose effective
    // date renders as the literal "TBD" reads as an unfinished draft, so the
    // string must not survive parsing — the pages branch on null instead.
    const doc = parseLegalDocument('privacy', full.replace('2026-09-01', 'TBD'));
    expect(doc.effectiveDate).toBeNull();
    expect(JSON.stringify(doc)).not.toContain('TBD');
  });

  it('maps an absent or empty effectiveDate to null too', () => {
    expect(parseLegalDocument('x', '---\ntitle: X\n---\nbody').effectiveDate).toBeNull();
    expect(
      parseLegalDocument('x', full.replace('effectiveDate: 2026-09-01', 'effectiveDate:'))
        .effectiveDate,
    ).toBeNull();
  });

  it('falls back to the slug when there is no title, rather than an empty heading', () => {
    expect(parseLegalDocument('cookies', '---\nversion: 1.0.0\n---\nbody').title).toBe('cookies');
    expect(parseLegalDocument('cookies', '---\ntitle:\n---\nbody').title).toBe('cookies');
  });

  it('treats a file with no front matter as all body', () => {
    expect(parseLegalDocument('raw', '# Just a heading')).toMatchObject({
      title: 'raw',
      version: '',
      status: '',
      effectiveDate: null,
      body: '# Just a heading',
    });
  });

  it('treats an UNTERMINATED front-matter block as all body', () => {
    // Otherwise a truncated file would silently publish its own front matter as
    // the opening lines of a legal document.
    const doc = parseLegalDocument('broken', '---\ntitle: Broken\nno closing fence');
    expect(doc.title).toBe('broken');
    expect(doc.body).toContain('title: Broken');
  });

  it('ignores a front-matter line with no colon instead of throwing', () => {
    expect(parseLegalDocument('x', '---\ntitle: X\ngarbage line\nversion: 2\n---\nb').version).toBe(
      '2',
    );
  });

  it('keeps a colon inside a value', () => {
    expect(parseLegalDocument('x', '---\ntitle: Motir: the terms\n---\nb').title).toBe(
      'Motir: the terms',
    );
  });
});

describe('byPreferredOrder', () => {
  const order = (...slugs: string[]) =>
    slugs
      .map((slug) => ({ slug }))
      .sort(byPreferredOrder)
      .map((d) => d.slug);

  it('puts known documents in the curated order, not alphabetically', () => {
    expect(order('subprocessors', 'terms', 'dpa', 'privacy')).toEqual([
      'terms',
      'privacy',
      'dpa',
      'subprocessors',
    ]);
  });

  it('sorts an UNKNOWN document after every known one, and never drops it', () => {
    // The branch that matters and that the real directory cannot reach today:
    // every file in `content/legal/` is currently named in PREFERRED_ORDER. A
    // future document must still appear — an ordering list may shape the page,
    // it may never hide a legal document.
    expect(order('zzz-new-policy', 'terms')).toEqual(['terms', 'zzz-new-policy']);
    expect(order('terms', 'aaa-new-policy')).toEqual(['terms', 'aaa-new-policy']);
  });

  it('sorts two unknown documents alphabetically between themselves', () => {
    expect(order('zebra', 'aardvark')).toEqual(['aardvark', 'zebra']);
  });
});

describe('the published legal set', () => {
  const docs = listLegalDocuments();

  it('is not vacuous, and every document carries a title and a version', () => {
    expect(docs.length).toBeGreaterThanOrEqual(6);
    for (const doc of docs) {
      expect(doc.title, `${doc.slug} has no title`).not.toBe(doc.slug);
      expect(doc.version, `${doc.slug} has no version`).not.toBe('');
      expect(doc.body.trim().length).toBeGreaterThan(0);
    }
  });

  it('routes every document — slugs and documents cannot disagree', () => {
    // The property the glob exists to buy: a document ships by EXISTING, so a
    // file with no route is impossible rather than merely unlikely.
    expect(legalDocumentSlugs()).toEqual(docs.map((d) => d.slug));
  });

  it('renders NO placeholder token on any page', () => {
    // MOTIR-3619's values are substituted on main; this keeps them substituted.
    for (const doc of docs) {
      expect(doc.body, `${doc.slug} still carries a placeholder`).not.toMatch(
        /«REGISTERED ADDRESS»|«KVK NUMBER»/,
      );
    }
  });

  it('puts the known documents in preferred order and unknown ones after', () => {
    const known = docs.map((d) => d.slug).filter((s) => s === 'terms' || s === 'privacy');
    expect(known).toEqual(['terms', 'privacy']);
  });

  it('resolves a real slug and refuses an unknown one', () => {
    expect(getLegalDocument('terms')?.slug).toBe('terms');
    expect(getLegalDocument('not-a-document')).toBeNull();
  });

  it('refuses a path-traversal slug rather than reading the file', () => {
    // The slug is matched against the directory LISTING, never concatenated
    // into a path — so this returns null instead of reading outside the tree.
    expect(getLegalDocument('../../package')).toBeNull();
    expect(getLegalDocument('../../../etc/passwd')).toBeNull();
  });
});
