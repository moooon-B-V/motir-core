import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { MarkdownView } from '@/components/ui/MarkdownView';
import { getLegalDocument, legalDocumentSlugs } from '@/lib/legal/documents';

// One published legal document (Story 8.4 · Subtask MOTIR-1134).
//
// ── The routes come from the DIRECTORY, not from a list ────────────────────
// `generateStaticParams` globs `content/legal/`, so every `.md` file there is a
// route and adding a document needs no edit here. The card was written for six
// documents and there are seven; see `lib/legal/documents.ts` for why that is
// the design rather than a shortcut.
//
// ── Server-rendered and indexable ──────────────────────────────────────────
// No `'use client'`, no auth gate, no `robots` restriction. A legal page that a
// crawler cannot read is one a customer's procurement review cannot find, and
// the whole point of publishing a subprocessor list is that it can be read
// without asking us for it.

export async function generateStaticParams() {
  return legalDocumentSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = getLegalDocument(slug);
  if (!doc) return {};

  const t = await getTranslations('legal');
  return {
    title: doc.title,
    // The version rides the description so a search result distinguishes two
    // revisions of the same policy, which is the one thing a reader checking
    // "is this the version I agreed to" needs from a result list.
    description: t('metaDocDescription', { title: doc.title, version: doc.version }),
  };
}

export default async function LegalDocumentPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = getLegalDocument(slug);

  // An unknown slug is a genuine 404, and it stays one: nothing in this tree
  // renders a `loading.tsx` above this call, so the status code survives.
  if (!doc) notFound();

  const t = await getTranslations('legal');

  return (
    <main className="mx-auto w-full max-w-[46rem] px-(--spacing-card-padding) py-10">
      <nav aria-label={t('breadcrumbAria')} className="mb-6">
        <Link
          href="/legal"
          className="text-[13px] text-(--el-text-secondary) hover:text-(--el-link)"
        >
          {t('allDocuments')}
        </Link>
      </nav>

      <header className="mb-8 border-b border-(--el-border) pb-6">
        <h1 className="font-serif text-3xl text-(--el-text)">{doc.title}</h1>
        <p className="mt-2 text-[13px] text-(--el-text-secondary)">
          {/*
            ⚠️ The effective date is rendered from `doc.effectiveDate`, which is
            `null` while the front matter says `TBD`. The literal string must
            never reach this page: a published policy whose date reads "TBD" is
            indistinguishable from an unfinished draft, whereas "not yet in
            effect" is TRUE, useful, and exactly what a reader should know
            before the service opens. `lib/legal/documents.ts` does the mapping
            so no page has to remember it.
          */}
          {doc.effectiveDate
            ? t('versionAndEffective', { version: doc.version, date: doc.effectiveDate })
            : t('versionNotYetEffective', { version: doc.version })}
        </p>
      </header>

      <MarkdownView value={doc.body} aria-label={doc.title} />
    </main>
  );
}
