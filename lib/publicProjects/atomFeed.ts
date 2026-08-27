import type { PublicChangelogEntryDto } from '@/lib/dto/publicProjects';

// Atom 1.0 serialization for the public changelog (Story 8.9 · Subtask 8.9.6 ·
// `docs/decisions/public-follow-and-changelog.md` §5).
//
// ATOM, NOT RSS 2.0, and the reason is observed rather than aesthetic: GitHub
// serves Atom for the closest analogous surface (`/<org>/<repo>/releases.atom`,
// checked while 8.9.1 was written), and Atom REQUIRES an unambiguous `<updated>`
// per entry — which is the one field this feed is entirely about. RSS 2.0's
// `pubDate` is optional and its date format is RFC-822, which nothing in this
// codebase already produces.
//
// Hand-built rather than via a library: the document is forty lines, a
// dependency would need auditing for exactly this output, and the one thing
// that must be right — escaping — is right here and testable.

/**
 * Escape text for an XML node or attribute.
 *
 * ⚠️ THIS IS THE LOAD-BEARING FUNCTION IN THE FILE. Every value below is
 * user-authored: a work-item title, a project name, a Markdown body. An
 * unescaped `&` or `<` does not merely look wrong — it makes the document
 * malformed, and a feed reader's parser rejects the WHOLE feed rather than the
 * one entry, so a single apostrophe in one title silently unsubscribes
 * everybody. All five predefined entities, `&` first so it cannot double-escape
 * the ones that follow.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The longest body an entry carries. Feed size, not privacy — see below. */
export const FEED_CONTENT_MAX = 1000;

/**
 * Truncate a body for the feed. The cut is for the DOCUMENT's size, not for
 * secrecy: `descriptionMd` is already published in full on the public item
 * page, and every entry links there. Cutting on a character boundary is fine
 * for the same reason — nothing here is a security boundary.
 */
function truncate(body: string): string {
  return body.length <= FEED_CONTENT_MAX ? body : `${body.slice(0, FEED_CONTENT_MAX)}…`;
}

export interface AtomFeedInput {
  projectIdentifier: string;
  projectName: string;
  /** Absolute URL of the human changelog page. */
  pageUrl: string;
  /** Absolute URL of this feed. */
  feedUrl: string;
  /** Builds the absolute URL of one entry's item page. */
  itemUrl: (entryIdentifier: string) => string;
  entries: PublicChangelogEntryDto[];
  /** The feed's own `<updated>`; the caller supplies it so this stays pure. */
  updated: Date;
}

export function renderAtomFeed(input: AtomFeedInput): string {
  const { projectIdentifier, projectName, pageUrl, feedUrl, itemUrl, entries } = input;

  // The feed's `<updated>` is the NEWEST entry's ship date, not "now". A feed
  // whose timestamp moves on every request tells every reader it has changed on
  // every poll, which is how a polite reader becomes an impolite one.
  const updated = (entries[0]?.shippedAt ?? input.updated.toISOString()) as string;

  // A tag URI, per RFC 4151 — a stable, non-dereferenceable id. Using the page
  // URL as the id would tie identity to the host, so moving domains would make
  // every reader treat every entry as new.
  const feedId = `tag:motir.co,2026:project/${projectIdentifier}/changelog`;

  const items = entries.map((entry) => {
    const url = itemUrl(entry.identifier);
    const body = entry.descriptionMd ? truncate(entry.descriptionMd) : null;
    return [
      '  <entry>',
      `    <id>tag:motir.co,2026:work-item/${escapeXml(entry.identifier)}</id>`,
      `    <title>${escapeXml(entry.title)}</title>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(url)}"/>`,
      `    <updated>${escapeXml(entry.shippedAt)}</updated>`,
      entry.epic ? `    <category term="${escapeXml(entry.epic.title)}"/>` : null,
      body ? `    <content type="text">${escapeXml(body)}</content>` : null,
      '  </entry>',
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  });

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <id>${escapeXml(feedId)}</id>`,
    `  <title>${escapeXml(`${projectName} — what shipped`)}</title>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(feedUrl)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(pageUrl)}"/>`,
    `  <updated>${escapeXml(updated)}</updated>`,
    '  <generator uri="https://motir.co">Motir</generator>',
    ...items,
    '</feed>',
    '',
  ].join('\n');
}
