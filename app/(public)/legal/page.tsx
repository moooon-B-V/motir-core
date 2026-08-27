import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { listLegalDocuments } from '@/lib/legal/documents';

// `/legal` — the index of the published legal set (Story 8.4 · Subtask
// MOTIR-1134).
//
// ── Why an index exists at all ─────────────────────────────────────────────
// There are seven documents and the public footer has four columns, none of
// them a legal column in the shipped design (`design/project-square/`). Listing
// seven links there would either need a fifth column — a layout change with no
// design asset behind it — or would bury five of them. One `Legal` row pointing
// here keeps the footer inside its design and still puts every document two
// clicks from any public page.
//
// It also answers the request a reader actually makes. Somebody sent a link to
// `/legal/dpa` and wondering what else is published has nowhere to go without
// this page; `/legal` 404ing would be a small, avoidable dead end on the one
// surface where a dead end costs trust.
//
// ── The rows come from the directory ───────────────────────────────────────
// Same `listLegalDocuments()` the routes use, so this page cannot list a
// document that does not render, or omit one that does.

export default async function LegalIndexPage() {
  const t = await getTranslations('legal');
  const documents = listLegalDocuments();

  return (
    <main className="mx-auto w-full max-w-[46rem] px-(--spacing-card-padding) py-10">
      <h1 className="font-serif text-3xl text-(--el-text)">{t('indexTitle')}</h1>
      <p className="mt-2 max-w-[34rem] text-sm leading-relaxed text-(--el-text-secondary)">
        {t('indexIntro')}
      </p>

      <ul className="mt-8 flex flex-col divide-y divide-(--el-border) border-y border-(--el-border)">
        {documents.map((doc) => (
          <li key={doc.slug}>
            <Link
              href={`/legal/${doc.slug}`}
              className="flex flex-col gap-1 py-4 hover:bg-(--el-surface-soft)"
            >
              <span className="text-sm font-semibold text-(--el-text)">{doc.title}</span>
              <span className="text-[13px] text-(--el-text-secondary)">
                {doc.effectiveDate
                  ? t('versionAndEffective', { version: doc.version, date: doc.effectiveDate })
                  : t('versionNotYetEffective', { version: doc.version })}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <p className="mt-8 text-[13px] text-(--el-text-secondary)">{t('indexContact')}</p>
    </main>
  );
}
