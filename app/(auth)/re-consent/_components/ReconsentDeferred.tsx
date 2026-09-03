import Link from 'next/link';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/Button';
import { Pill } from '@/components/ui/Pill';
import { AuthShell } from '../../_components/AuthShell';
import { LegalDocumentRow } from './LegalDocumentRow';

/**
 * THE DEFERRED SCREEN — where "Not now — sign out" lands (Story 8.4 ·
 * MOTIR-1135 · design panel 8).
 *
 * ⚠️ IT RENDERS SIGNED OUT, BY CONSTRUCTION. That is the whole point of the
 * panel: deferring is DEFERRING, not declining, and a person who has just been
 * signed out is owed a sentence saying so — *"You've been signed out and nothing
 * has changed"* — at the moment they can still see it. Bouncing them to
 * `/sign-in` to read it would deliver the reassurance to nobody.
 *
 * ⚠️ AND THE DOCUMENT STAYS READABLE — ⚠️ CORRECTED 2026-09-02 (MOTIR-4010).
 * ~~`/legal/<slug>` is in the `(public)` group, so it renders with no session.~~
 * That is no longer how it is readable: the documents left this repository
 * (MOTIR-3909) and the row now links the manifest's ABSOLUTE url on the host the
 * operator publishes, which needs no session because it is another application
 * entirely. **The PROPERTY is unchanged and it is the load-bearing part** — you
 * cannot ask somebody to accept a document you will not let them open — and this
 * row is still what makes it reachable from the one screen where it matters,
 * still the SAME `.doc` row the held screen draws.
 *
 * The comment is corrected rather than deleted because it named a mechanism a
 * reader would otherwise go looking for and not find.
 *
 * ⚠️ IT SHOWS THE TERMS, NOT "what was outstanding", and it cannot do otherwise:
 * there is no session here, so there is nothing to look the reader's own
 * acceptance state up against. The Terms are the right single answer —
 * `motir.co/legal/terms` §15 makes them the contract the other two documents
 * hang off, and §14 is the clause this whole surface implements.
 *
 * NOT an error state: no `--el-danger`, no `role="alert"`, no `aria-live`.
 * Nothing has gone wrong — a document was updated and somebody chose to read it
 * later. The chip carries the MINT tint for the same reason the held screen's
 * carries sky: it reports a state, not a severity.
 */
export function ReconsentDeferred({
  terms,
}: {
  /** The published Terms, read off disk by the page — no session needed. */
  terms: { title: string; version: string; url: string | null } | null;
}) {
  const t = useTranslations('legal.reconsent');

  return (
    <AuthShell
      tight
      headline={t('deferredHeadline')}
      subhead={t('deferredBody')}
      eyebrow={
        <Pill className="border-transparent bg-(--el-tint-mint) text-(--el-text-strong)">
          <Check className="h-3.5 w-3.5" aria-hidden />
          {t('signedOutChip')}
        </Pill>
      }
    >
      <div className="flex flex-col gap-5">
        {terms ? (
          <ul className="flex list-none flex-col gap-3 p-0">
            <LegalDocumentRow
              title={terms.title}
              versionLabel={terms.version}
              url={terms.url}
              linkLabel={t('deferredReadLink')}
            />
          </ul>
        ) : null}
        <Link href="/sign-in" className={buttonVariants({ variant: 'primary', size: 'lg' })}>
          {t('deferredPrimary')}
        </Link>
      </div>
    </AuthShell>
  );
}
