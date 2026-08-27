// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { renderAtomFeed, escapeXml, FEED_CONTENT_MAX } from '@/lib/publicProjects/atomFeed';
import type { PublicChangelogEntryDto } from '@/lib/dto/publicProjects';

// Story 8.9 · Subtask 8.9.6 — the Atom DOCUMENT.
//
// The card's acceptance criterion is that it "validates as a feed", so these
// PARSE the output with a real XML parser rather than matching substrings: a
// feed a reader's parser rejects is not a feed, and a substring assertion
// cannot tell the difference. happy-dom's `DOMParser` reports a malformed
// document as a `parsererror` element, which is exactly the signal a feed
// reader acts on.
//
// The escaping cases carry the most weight. A malformed document loses the
// WHOLE feed, not the one bad entry — so a single apostrophe in a single title
// would silently unsubscribe everybody.

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error(`not well-formed XML: ${doc.querySelector('parsererror')?.textContent}`);
  }
  return doc;
}

function text(doc: Document | Element, selector: string): string | null {
  return doc.querySelector(selector)?.textContent ?? null;
}

function entry(over: Partial<PublicChangelogEntryDto> = {}): PublicChangelogEntryDto {
  return {
    identifier: 'PROD-1',
    key: 1,
    title: 'A shipped thing',
    kind: 'task',
    status: 'done',
    priority: 'medium',
    shippedAt: '2026-08-26T10:00:00.000Z',
    epic: null,
    ...over,
  };
}

function render(entries: PublicChangelogEntryDto[]): string {
  return renderAtomFeed({
    projectIdentifier: 'PROD',
    projectName: 'Motir',
    pageUrl: 'https://motir.co/p/PROD/changelog',
    feedUrl: 'https://motir.co/p/PROD/changelog.xml',
    itemUrl: (id) => `https://motir.co/p/PROD/items/${id}`,
    entries,
    updated: new Date('2026-08-26T12:00:00.000Z'),
  });
}

describe('the document is a valid Atom feed', () => {
  it('parses, and carries the required feed-level elements', () => {
    const doc = parse(render([entry()]));
    expect(doc.documentElement.nodeName).toBe('feed');
    expect(doc.documentElement.getAttribute('xmlns')).toBe('http://www.w3.org/2005/Atom');
    // Atom REQUIRES id / title / updated on the feed.
    expect(text(doc, 'feed > id')).toBeTruthy();
    expect(text(doc, 'feed > title')).toBe('Motir — what shipped');
    expect(text(doc, 'feed > updated')).toBeTruthy();

    const links = Array.from(doc.querySelectorAll('feed > link'));
    expect(links.find((l) => l.getAttribute('rel') === 'self')?.getAttribute('href')).toBe(
      'https://motir.co/p/PROD/changelog.xml',
    );
    expect(links.find((l) => l.getAttribute('rel') === 'alternate')?.getAttribute('href')).toBe(
      'https://motir.co/p/PROD/changelog',
    );
  });

  it('dates the FEED by the newest entry, not by "now"', () => {
    const doc = parse(
      render([
        entry({ identifier: 'PROD-2', shippedAt: '2026-08-26T10:00:00.000Z' }),
        entry({ identifier: 'PROD-1', shippedAt: '2026-08-20T10:00:00.000Z' }),
      ]),
    );
    // A feed whose <updated> moved on every request would tell every reader it
    // had changed on every poll — the fast route from polite to impolite.
    expect(text(doc, 'feed > updated')).toBe('2026-08-26T10:00:00.000Z');
  });

  it('gives every entry the required id / title / updated and an absolute link', () => {
    const doc = parse(render([entry({ identifier: 'PROD-42', title: 'Shipped it' })]));
    const item = doc.querySelector('entry')!;
    expect(text(item, 'id')).toBe('tag:motir.co,2026:work-item/PROD-42');
    expect(text(item, 'title')).toBe('Shipped it');
    expect(text(item, 'updated')).toBe('2026-08-26T10:00:00.000Z');
    expect(item.querySelector('link')?.getAttribute('href')).toBe(
      'https://motir.co/p/PROD/items/PROD-42',
    );
  });

  it('carries the epic as a category and the body as content, when present', () => {
    const doc = parse(
      render([
        entry({ epic: { identifier: 'PROD-9', title: 'Launch' }, descriptionMd: 'The body.' }),
      ]),
    );
    expect(doc.querySelector('entry > category')?.getAttribute('term')).toBe('Launch');
    expect(text(doc, 'entry > content')).toBe('The body.');
  });

  it('omits content entirely when the read did not project a body', () => {
    const doc = parse(render([entry()]));
    expect(doc.querySelector('entry > content')).toBeNull();
  });

  it('truncates a long body — for document size, not for secrecy', () => {
    const doc = parse(render([entry({ descriptionMd: 'x'.repeat(FEED_CONTENT_MAX + 500) })]));
    expect((text(doc, 'entry > content') ?? '').length).toBeLessThanOrEqual(FEED_CONTENT_MAX + 1);
  });

  it('renders a feed with NO entries and it still parses', () => {
    const doc = parse(render([]));
    expect(doc.querySelector('entry')).toBeNull();
  });
});

describe('escaping — the one thing that must not be wrong', () => {
  it('escapes all five predefined entities, and does not double-escape', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
    // `&` is replaced FIRST, so the ampersands it introduces are not re-escaped.
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('survives a title full of markup, and round-trips it exactly', () => {
    const nasty = `Fix <script>alert("x")</script> & the "quoted" it's`;
    const doc = parse(render([entry({ title: nasty })]));
    expect(text(doc, 'entry > title')).toBe(nasty);
  });

  it('survives markup in the project name and an epic title too', () => {
    const doc = parse(
      renderAtomFeed({
        projectIdentifier: 'PROD',
        projectName: 'Ben & Jerry <inc>',
        pageUrl: 'https://motir.co/p/PROD/changelog',
        feedUrl: 'https://motir.co/p/PROD/changelog.xml',
        itemUrl: (id) => `https://motir.co/p/PROD/items/${id}`,
        entries: [entry({ epic: { identifier: 'PROD-9', title: 'R&D' } })],
        updated: new Date('2026-08-26T12:00:00.000Z'),
      }),
    );
    expect(text(doc, 'feed > title')).toBe('Ben & Jerry <inc> — what shipped');
    expect(doc.querySelector('entry > category')?.getAttribute('term')).toBe('R&D');
  });
});
