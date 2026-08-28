// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import { getLegalDocument, listLegalDocuments } from '@/lib/legal/documents';
import { renderToHtml } from '../helpers/serverPageHarness';

// THE LEGAL PAGES AS A READER ACTUALLY GETS THEM (Story 8.4 · Subtask
// MOTIR-1137, covering MOTIR-1134).
//
// ── Why a RENDER suite when `legalDocuments.test.ts` already exists ─────────
//
// That file tests the LOADER, and it tests it well: parsing, ordering, traversal
// refusal, and the placeholder sweep over `doc.body`. Every assertion it makes is
// about the value `listLegalDocuments()` returns.
//
// The four failure modes this card exists for are all one layer further out, on
// the page a customer opens:
//
//   * a drafting placeholder reaching a PUBLIC URL,
//   * a `TBD` effective date PRINTING as though the policy were unfinished,
//   * a document that loads but does not RENDER its version or date,
//   * a footer or sign-up link that 404s.
//
// A body-level sweep cannot see any of them. `«REGISTERED ADDRESS»` could be
// substituted correctly in every `.md` file and still be interpolated back in by
// a page; `TBD` never appears in a body at all — it is a FRONT-MATTER sentinel
// that `documents.ts` maps to `null`, so the only place it could ever surface is
// the rendered date line, which is exactly where nothing was looking.
//
// ── The enumeration is DERIVED, and there is no literal route list here ─────
//
// `lib/legal/documents.ts` treats the DIRECTORY as the registry so a document
// ships by existing, and its own docstring records the defect a hardcoded list
// shipped last time. A suite that enumerated seven slugs would re-introduce that
// defect one layer up: green today, silently blind to the eighth document. So
// every case below iterates `listLegalDocuments()`, and the only NUMBER in this
// file is the vacuity floor — which is a floor precisely so that growth never
// touches it.

const REPO_ROOT = process.cwd();

// ⚠️ REAL COPY, NOT ECHOED KEYS. The repository's other render tests shim
// `getTranslations` to return the key, because they assert WHICH body rendered
// and a copy change must not fail them. Here the assertion IS the copy: the
// version and the effective date reach the page only through
// `versionAndEffective` / `versionNotYetEffective`, so a key-echoing shim would
// have the suite confirm that a page renders the string `versionAndEffective`
// while `TBD` sailed past underneath it.
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace?: string) =>
    createTranslator({
      locale: 'en',
      messages: en as Parameters<typeof createTranslator>[0]['messages'],
      ...(namespace ? { namespace } : {}),
    }),
}));

const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);

vi.mock('next/navigation', async () => ({
  ...(await import('../helpers/serverPageHarness')).navigationHooks(),
  notFound,
}));

const { default: LegalDocumentPage } = await import('@/app/(public)/legal/[slug]/page');
const { default: LegalIndexPage } = await import('@/app/(public)/legal/page');

/** The published set, read ONCE — the same call the routes make. */
const documents = listLegalDocuments();

/** Render `/legal/<slug>` exactly as the route does, params promise included. */
async function renderDocument(slug: string): Promise<string> {
  return renderToHtml(await LegalDocumentPage({ params: Promise.resolve({ slug }) }));
}

describe('every published legal document RENDERS', () => {
  // ⚠️ THE FLOOR, AND WHY IT IS A FLOOR. An empty or truncated enumeration would
  // make every `it.each` below iterate nothing and the suite would pass having
  // asserted about no document at all — the exact vacuous green a derived
  // enumeration buys its safety at the cost of. Seven is what
  // `content/legal/` publishes today; the assertion is `>=` so the eighth
  // document is growth rather than a red suite, and 0 or 3 is still caught.
  it('covers at least the seven documents published today', () => {
    expect(documents.length).toBeGreaterThanOrEqual(7);
  });

  it.each(documents.map((doc) => [doc.slug] as const))(
    '/legal/%s renders its title and its version',
    async (slug) => {
      const doc = getLegalDocument(slug)!;
      const html = await renderDocument(slug);

      expect(html, `${slug} did not render its title`).toContain(doc.title);
      // The version reaches the page only through the date line's interpolation,
      // so finding it is also proof that line rendered at all.
      expect(html, `${slug} did not render version ${doc.version}`).toContain(doc.version);
    },
  );

  it.each(documents.map((doc) => [doc.slug] as const))(
    '/legal/%s renders the effective-date line in the arm its front matter selects',
    async (slug) => {
      const doc = getLegalDocument(slug)!;
      const html = await renderDocument(slug);

      // TOTAL over both arms rather than asserting the one that happens to hold
      // today. Every document currently carries `effectiveDate: TBD`, so a test
      // written only against the null branch would go red — not green — on the
      // day the service opens and the dates are set, which is the moment this
      // assertion most needs to still be right.
      if (doc.effectiveDate) {
        expect(html, `${slug} did not render its effective date`).toContain(doc.effectiveDate);
        expect(html).toContain('in effect from');
      } else {
        expect(html, `${slug} did not render the not-yet-in-effect line`).toContain(
          'not yet in effect',
        );
      }
    },
  );

  it.each(documents.map((doc) => [doc.slug] as const))(
    '/legal/%s renders NO drafting placeholder and NO literal TBD',
    async (slug) => {
      const html = await renderDocument(slug);

      // MOTIR-3619 supplied the controller's registered address and KvK number;
      // the drafting cards write these tokens deliberately
      // (`docs/decisions/legal-document-set.md` §3). One reaching a public URL is
      // invisible to every other check in the tree — the page renders, the links
      // resolve, the Markdown is valid.
      expect(html, `${slug} renders a drafting placeholder`).not.toMatch(
        /«REGISTERED ADDRESS»|«KVK NUMBER»/,
      );

      // ⚠️ WORD-BOUNDED, so this stays an assertion about the SENTINEL. A bare
      // `toContain('TBD')` would fire on any future body that used the letters
      // inside a longer word, and a guard that cries wolf gets deleted.
      expect(html, `${slug} renders the literal TBD sentinel`).not.toMatch(/\bTBD\b/);
    },
  );

  it('404s a slug that names no document, rather than rendering an empty page', async () => {
    notFound.mockClear();
    await expect(renderDocument('not-a-document')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalled();
  });
});

describe('the /legal index', () => {
  it('lists one row per published document, each linking to its own route', async () => {
    const html = await renderToHtml(await LegalIndexPage());

    for (const doc of documents) {
      expect(html, `the index omits ${doc.slug}`).toContain(`/legal/${doc.slug}`);
      expect(html, `the index omits ${doc.slug}'s title`).toContain(doc.title);
    }
  });

  it('renders no drafting placeholder and no literal TBD', async () => {
    const html = await renderToHtml(await LegalIndexPage());
    expect(html).not.toMatch(/«REGISTERED ADDRESS»|«KVK NUMBER»/);
    expect(html).not.toMatch(/\bTBD\b/);
  });
});

// ── EVERY HARDCODED LEGAL LINK IN THE TREE RESOLVES ─────────────────────────
//
// The dead-link class the card names has two halves and they need different
// instruments. Links the product DERIVES — the index's rows, the re-consent
// card's document rows — cannot 404 by construction, and the index test above is
// what proves the derivation. The half that CAN rot is the hardcoded one: the
// public footer, the sign-up notice, and the cross-references inside the legal
// copy itself. Those are literal strings, and a renamed file leaves every one of
// them pointing at a 404 while nothing anywhere fails.
//
// ⚠️ SO THE SWEEP WALKS THE TREE, not a list of the files that carry links
// today. A list would have to be edited by whoever adds the eighth link site,
// which is precisely the person who does not know this file exists.

/** Directories that can hold a hardcoded `/legal/<slug>` a reader can click. */
const LINK_SOURCE_DIRS = ['app', 'components', 'lib', 'content', 'messages'];
const LINK_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.md', '.json']);

/**
 * A LINK, not a path — the distinction this regex exists for.
 *
 * `/legal/` is also a real directory prefix in this repository (`lib/legal/`,
 * `content/legal/`, `tests/legal/`) and a message-namespace prefix
 * (`legal.reconsent`), so matching the bare substring reports `/legal/consent`
 * and `/legal/documents` as broken routes. Only two shapes are addresses a
 * reader can follow: a JSX/HTML `href`, and a Markdown link target.
 */
const LEGAL_LINK = /href=["'`]\/legal\/([a-z0-9-]+)|\]\(\/legal\/([a-z0-9-]+)\)/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (LINK_SOURCE_EXTENSIONS.has(extname(entry))) out.push(path);
  }
  return out;
}

interface FoundLink {
  slug: string;
  file: string;
}

function hardcodedLegalLinks(): FoundLink[] {
  const found: FoundLink[] = [];
  for (const dir of LINK_SOURCE_DIRS) {
    for (const file of sourceFiles(join(REPO_ROOT, dir))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(LEGAL_LINK)) {
        found.push({ slug: (match[1] ?? match[2])!, file: relative(REPO_ROOT, file) });
      }
    }
  }
  return found;
}

describe('hardcoded legal links resolve', () => {
  const links = hardcodedLegalLinks();

  it('found links to sweep — the walk is not vacuous', () => {
    // Same reasoning as the document floor: a regex that silently stopped
    // matching would make the assertion below iterate nothing and pass. The
    // number is a floor, so adding a link site never touches it.
    expect(links.length).toBeGreaterThanOrEqual(7);
  });

  it('every one names a document the loader publishes', () => {
    const broken = links.filter(({ slug }) => getLegalDocument(slug) === null);
    expect(
      broken.map(({ slug, file }) => `${file} → /legal/${slug}`),
      'these links 404',
    ).toEqual([]);
  });

  it('reaches every published document from somewhere — no orphan page', () => {
    // The mirror of the assertion above, and the one that catches the OTHER
    // direction of the same rot: a document that renders perfectly and that
    // nothing links to. The `/legal` index alone would satisfy a reader, so this
    // is not a hard requirement of the product — but every document has a
    // referrer today, and losing one silently is worth a red line.
    const linked = new Set(links.map((link) => link.slug));
    const unlinked = documents.map((doc) => doc.slug).filter((slug) => !linked.has(slug));
    expect(unlinked, 'these documents are published but linked from nowhere').toEqual([]);
  });
});
