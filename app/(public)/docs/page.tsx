import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@/components/ui/Card';
import { DOC_SURFACES } from '@/lib/apiDocs/surfaces';

// GET /docs — the documentation area's INDEX (Story MOTIR-2315 · Subtask
// MOTIR-2523 · design `design/api-docs/docs-index.mock.html` Panels 1–2 · ADR
// `public-api-conventions.md` Amendment 19).
//
// ── What this page is for ───────────────────────────────────────────────────
// A reader who clicks `Docs` does not yet know whether they want the REST API,
// the CLI, the MCP server or the sandbox container — those are implementations,
// and they arrived with a need. This page's whole job is to convert one into the
// other: one row per surface, each with a line saying what it is and who it is
// for. Amendment 19 Q1 decided it renders rather than redirects, on the evidence
// that Stripe, GitHub and Cloudflare all render their documentation root and
// none of the three sends it into a section.
//
// ── ⚠️ NO RAIL, and the absence is the design (Amendment 19 Q4) ─────────────
// Every other page in the area renders `CatalogueNav`. This one does not: the
// rail's first tier is one row per surface, and this page's BODY is one row per
// surface with a description — rendering both would put the same four
// destinations on screen twice, with the shorter copy in the more prominent
// position. The rail starts one click in, where a reader has chosen a context
// and needs to move within it.
//
// A consequence that needs no special case: Amendment 11 Q2 gates the `/api/v1`
// operation index on the `/docs/api` route PREFIX, and `/docs` is not under it,
// so this page could not acquire operation rows even if it did render the rail.
//
// ── The list is NOT restated here ───────────────────────────────────────────
// The rows come from `lib/apiDocs/surfaces.ts`, the same module `CatalogueNav`'s
// first tier reads (Amendment 19 Q3). A fifth surface added there appears in the
// rail AND on this page with no edit to either — which is the property that
// module exists to buy, and `tests/api-docs/docs-index-page.test.tsx` holds it.
//
// ── No metadata export, deliberately ────────────────────────────────────────
// This page INHERITS the layout's, and that is correct: `apiDocs.metaTitle` is
// the AREA's identity ("Motir documentation") since MOTIR-2526 retargeted it,
// and this page IS the area. `tests/api-docs/docs-page-metadata.test.ts` exempts
// exactly this one route by name and fails for every other page that inherits.
//
// Server-rendered, no database read — the contract `tests/public-docs-db-imports.test.ts`
// guards over this whole tree.

export default async function DocsIndexPage() {
  const t = await getTranslations('apiDocs');

  return (
    <main className="mx-auto min-w-0 flex-1 px-4 py-7 sm:px-9 lg:max-w-[880px]">
      <header className="mb-8">
        <h1 className="m-0 font-serif text-3xl font-semibold text-(--el-text)">
          {t('indexTitle')}
        </h1>
        <p className="mt-2 max-w-[60ch] text-[15px] leading-relaxed text-(--el-text-secondary)">
          {t('indexLede')}
        </p>
      </header>

      {/* A <ul> so a screen reader announces "list, 4 items" — the count is this
          page's whole substance. Each row is ONE link wrapping both lines, so
          the accessible name is the surface's name followed by its description:
          the same routing information a sighted reader gets, in the same order,
          and the whole card is the target (notes.html mistake #7). */}
      <ul className="m-0 grid list-none gap-3 p-0">
        {DOC_SURFACES.map((surface) => (
          <li key={surface.key}>
            <Link
              href={surface.route}
              className="group block rounded-(--radius-card) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              <Card className="transition-colors group-hover:border-(--el-border-strong) group-hover:bg-(--el-surface-soft)">
                <span className="block text-[15px] font-semibold text-(--el-text)">
                  {t(surface.labelKey)}
                </span>
                {/* --el-text-secondary, not --el-text-muted: the hover tints the
                    card, and CLAUDE.md measures muted FAILING on every tinted
                    ground with 0.04 of headroom on white. Secondary clears AA on
                    both grounds in both themes. */}
                <span className="mt-1 block max-w-[64ch] text-[13px] leading-relaxed text-(--el-text-secondary)">
                  {t(surface.descriptionKey)}
                </span>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
