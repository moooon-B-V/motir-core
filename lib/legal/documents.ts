import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The legal-document loader (Story 8.4 · Subtask MOTIR-1134).
//
// `content/legal/*.md` holds the published legal set. This module is the ONE
// place that reads it, so the routes, the index and the footer all agree about
// which documents exist and what each one is called.
//
// ── ⚠️ THE DIRECTORY IS THE REGISTRY, and that is the whole design ──────────
// Nothing here enumerates slugs. `generateStaticParams` globs this directory, so
// a document ships by EXISTING and no route table has to be edited to add one.
//
// That is not tidiness, it is a defect this story already hit. The card was
// written for SIX documents; `model-providers.md` was added days later by
// MOTIR-3631, and a hardcoded list of six would have shipped a subprocessor page
// linking to a 404 — disclosing LESS than it did before the split. The
// legal-document set has grown three times during Story 8.4 alone, so the cost
// of a list is paid repeatedly and the cost of a glob is paid once.
//
// ── Front matter is parsed here rather than by a dependency ─────────────────
// The shape is fixed and tiny — five scalar keys, no nesting, no arrays — and
// the repository has no YAML parser in its dependency tree. Adding one to read
// `title: Terms of Service` would be a new production dependency, a new
// subprocessor-adjacent supply-chain surface, and a new thing to keep current,
// for a grammar this file handles in fifteen lines.

/** Where the published legal copy lives, relative to the app root. */
const LEGAL_DIR = join(process.cwd(), 'content', 'legal');

/**
 * The front-matter value that means "no date is set yet".
 *
 * ⚠️ It must NEVER reach a rendered page. `TBD` is a note to ourselves in a file
 * a customer will read, and a published policy whose effective date literally
 * says "TBD" reads as unfinished rather than as not-yet-in-force. It is mapped to
 * a `null` `effectiveDate` here, and the pages branch on that null — so the
 * mapping lives in one place and no page has to remember the sentinel.
 */
const NOT_YET_SET = 'TBD';

export interface LegalDocument {
  /** URL slug — the filename without its extension. `/legal/<slug>`. */
  slug: string;
  /** Human title, from front matter. */
  title: string;
  /**
   * Version string, verbatim from the front matter — `1.0.0`.
   *
   * ⚠️ ITS COMPONENTS CARRY MEANING, and `lib/legal/consent.ts` is where that
   * meaning lives: a MAJOR or MINOR bump is a MATERIAL change and prompts every
   * reader to re-accept, a PATCH bump takes effect when published and prompts
   * nobody. That is not a convention this module invented — `content/legal/terms.md`
   * §14 promises outright that clarifications and corrections *"take effect when
   * published"*, so a bare `>` comparison over this string would break a clause in
   * the published contract on every typo fix. Bump the right component.
   */
  version: string;
  /**
   * The effective date, or `null` when it is not yet set. `null` is the
   * MEANINGFUL case today: nothing is in force until the service opens.
   */
  effectiveDate: string | null;
  /** Front-matter status, e.g. `approved`. */
  status: string;
  /**
   * One human sentence saying what MOVED in this version, or `null` when the
   * author has not written one (Story 8.4 · Subtask MOTIR-1135).
   *
   * The re-consent interstitial draws each changed document as a row carrying
   * its title, its version delta and this sentence — *"a person asked to
   * re-accept is owed a link to what changed"* (`design/auth/design-notes.md`).
   * A version delta alone tells a reader that something moved and nothing about
   * what, which is the difference between a notice and a formality.
   *
   * ⚠️ NULL IS A SUPPORTED STATE, NOT A BUG. The design names the degraded form
   * — the delta and a link, with no sentence — as an acceptable fallback, so the
   * row renders either way and nothing gates on this being present. It is
   * deliberately NOT defaulted to a generic string: an invented sentence is
   * worse than an absent one on a screen whose whole subject is what changed.
   */
  changeSummary: string | null;
  /** The Markdown body, front matter removed. */
  body: string;
}

/**
 * The order documents are listed in — most-asked-for first, not alphabetical.
 *
 * A document NOT named here still appears; it sorts after the known ones, by
 * slug. So this array shapes presentation and can never hide a document, which
 * is the property that matters: a stale ordering list is a cosmetic problem, a
 * stale ROUTING list is a 404 on a legal page.
 */
const PREFERRED_ORDER = [
  'terms',
  'privacy',
  'cookies',
  'acceptable-use',
  'dpa',
  'subprocessors',
  'model-providers',
];

/** Split `---\n…\n---\n` off the top of a file. Returns the pairs and the rest. */
function splitFrontMatter(source: string): { meta: Map<string, string>; body: string } {
  const meta = new Map<string, string>();
  if (!source.startsWith('---\n')) return { meta, body: source };

  const end = source.indexOf('\n---\n', 4);
  if (end === -1) return { meta, body: source };

  for (const line of source.slice(4, end).split('\n')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    meta.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return { meta, body: source.slice(end + 5) };
}

/**
 * Parse one document from its raw source. Exported because it is the whole of
 * this module's logic and it is PURE — every branch that matters (a missing
 * title, `TBD`, an absent date, a file with no front matter) is reachable from
 * a string, with no fixture directory to build and no filesystem to stub.
 */
export function parseLegalDocument(slug: string, source: string): LegalDocument {
  const { meta, body } = splitFrontMatter(source);
  const effectiveDate = meta.get('effectiveDate') ?? '';
  return {
    slug,
    // A document with no `title:` falls back to its slug rather than rendering
    // an empty heading — the page still works, and the omission is visible.
    title: meta.get('title') || slug,
    version: meta.get('version') ?? '',
    effectiveDate: effectiveDate === '' || effectiveDate === NOT_YET_SET ? null : effectiveDate,
    status: meta.get('status') ?? '',
    // An absent key and an empty value both mean "no sentence written", so the
    // renderer branches on ONE thing. `|| null` rather than `?? null` for
    // exactly that: `changeSummary:` with nothing after it parses to `''`.
    changeSummary: meta.get('changeSummary') || null,
    body,
  };
}

/** Every published legal document, in `PREFERRED_ORDER` then by slug. */
export function listLegalDocuments(): LegalDocument[] {
  const slugs = readdirSync(LEGAL_DIR)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -3));

  return slugs
    .map((slug) => parseLegalDocument(slug, readFileSync(join(LEGAL_DIR, `${slug}.md`), 'utf8')))
    .sort(byPreferredOrder);
}

/**
 * The list comparator: `PREFERRED_ORDER` first, then unknown slugs alphabetically.
 *
 * Exported and pure for the same reason `parseLegalDocument` is. Its interesting
 * branches are the UNKNOWN-slug ones, and every document in `content/legal/` is
 * currently named in `PREFERRED_ORDER` — so against the real directory those
 * branches are unreachable, and the behaviour that protects a future document
 * from being dropped could not be tested at all through `listLegalDocuments()`.
 */
export function byPreferredOrder(a: { slug: string }, b: { slug: string }): number {
  const ai = PREFERRED_ORDER.indexOf(a.slug);
  const bi = PREFERRED_ORDER.indexOf(b.slug);
  if (ai !== -1 && bi !== -1) return ai - bi;
  if (ai !== -1) return -1;
  if (bi !== -1) return 1;
  return a.slug.localeCompare(b.slug);
}

/** Every slug, for `generateStaticParams`. */
export function legalDocumentSlugs(): string[] {
  return listLegalDocuments().map((doc) => doc.slug);
}

/**
 * One document, or `null` when the slug names no file.
 *
 * ⚠️ The slug is checked against the DIRECTORY LISTING rather than used to build
 * a path, so a traversal attempt (`../../.env`) finds no match and returns null
 * instead of reading a file. Reading `join(LEGAL_DIR, slug + '.md')` directly
 * would be the obvious implementation and would be a path-traversal read.
 */
export function getLegalDocument(slug: string): LegalDocument | null {
  return listLegalDocuments().find((doc) => doc.slug === slug) ?? null;
}
