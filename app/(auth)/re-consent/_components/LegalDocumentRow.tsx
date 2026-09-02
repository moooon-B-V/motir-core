import { ExternalLink, FileText } from 'lucide-react';
import { type ReactNode } from 'react';

/**
 * One legal document, drawn as a row: an icon tile, the title, a mono version
 * chip, an optional sentence about what moved, and a way to read it
 * (Story 8.4 · MOTIR-1135 · `design/auth/legal-agreement.mock.html`'s `.doc`).
 *
 * Shared by both halves of the surface — the held interstitial's changed-document
 * list and the deferred screen's *"read it without signing in"* row — because
 * the mock draws them with the same `.doc` markup and a person meets them
 * minutes apart. Two copies would drift, and the second one is the copy nobody
 * looks at again.
 *
 * ⚠️ THE VERSION CHIP IS NOT THE ONLY CARRIER. The title names the document and
 * the summary says what moved, so a reader who never resolves `1.0.0 → 2.0.0`
 * still knows what they are agreeing to — which is the point of the row rather
 * than a bare list of links. `summary` is absent until an author writes a
 * `changeSummary:` into the document's front matter, and the row then renders
 * the degraded form the design names as an acceptable fallback rather than
 * inventing a description of a change nobody described.
 *
 * A plain server component: it holds no state and takes no handler, so both a
 * server page and a client island can render it.
 */
export function LegalDocumentRow({
  title,
  versionLabel,
  summary,
  url,
  linkLabel,
}: {
  title: string;
  /** The mono chip's text — a delta, a bare version, or a "new" label. */
  versionLabel: string;
  summary?: string | null;
  /**
   * The document's ABSOLUTE url from the configured manifest, or `null` when it
   * is not configured (MOTIR-4010).
   *
   * ⚠️ NULL IS A REAL ARM AND IT IS UNCOMFORTABLE ON PURPOSE. It means a CLOUD
   * build is holding somebody over a document whose url the manifest does not
   * carry — a misconfiguration, drawn as one
   * (`design/auth/legal-agreement.mock.html` panel 15). The row keeps everything
   * that identifies the change and loses only the way out: it does NOT invent a
   * fallback link, and it does NOT render an "unavailable" string, because a
   * legal notice that explains our operational problem to the reader has put the
   * wrong thing on their screen. The operator is told by
   * `/api/health/legal` instead, which reports the manifest as *faulted*.
   */
  url: string | null;
  linkLabel: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 rounded-(--radius-card) border border-(--el-border) bg-(--el-card) p-(--spacing-card-padding)">
      <span
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-card-icon-bg) text-(--el-card-icon-fg)"
        aria-hidden
      >
        <FileText className="h-4 w-4" />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-2 font-sans text-sm font-medium text-(--el-text)">
          {title}
          <code className="rounded-(--radius-control) bg-(--el-code-bg) px-1.5 py-0.5 font-mono text-xs whitespace-nowrap text-(--el-code-text)">
            {versionLabel}
          </code>
        </span>
        {summary ? (
          <span className="font-sans text-[13px] text-(--el-text-secondary)">{summary}</span>
        ) : null}
        {/*
          ⚠️ A PLAIN ANCHOR, NOT `next/link`. The target is an ABSOLUTE url on
          whatever host the operator publishes — another application — so
          prefetching and client navigation are wrong for it, and a cross-origin
          `next/link` looks identical until it is used. The external-link glyph
          is the shipped treatment (`components/github/DevelopmentSection.tsx`,
          `components/planning/repositories/RepositoryRow.tsx`), drawn in the
          link's OWN colour so it reads as part of the link rather than as an
          adjacent control (`design/auth/legal-agreement.mock.html` panel 13).
        */}
        {url ? (
          <a
            href={url}
            className="inline-flex self-start items-center gap-1 font-sans text-[13px] text-(--el-link) hover:text-(--el-link-pressed) focus-visible:underline focus-visible:outline-none"
          >
            {linkLabel}
            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
          </a>
        ) : null}
      </span>
    </li>
  );
}
