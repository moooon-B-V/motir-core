'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Copy, ExternalLink, Info, Link2 } from 'lucide-react';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { useToast } from '@/components/ui/Toast';

/**
 * THE VISITOR LINK (Story MOTIR-6170 · MOTIR-6649) — the card at the top of the
 * Build-in-public room, drawn by MOTIR-6641 as panel 11 of
 * `design/projects/public-page--visitor-link.mock.html` (spec:
 * `design/visitor/design-notes.md`).
 *
 * The link is the app's own address for the project's board —
 * `<app origin>/p/<key>/board` — which a signed-in visitor opens to read the
 * project. It is NOT the public page on `motir.co` that Members & access shares:
 * that one needs no sign-in and stays exactly as it was.
 *
 * `visitorUrl` is built on the SERVER from the app-origin accessor and is
 * `null` whenever the project is not Public — so the not-public state has no
 * address to leak, only the notice pointing at where access is set.
 */
export function VisitorLinkCard({
  visitorUrl,
  projectName,
}: {
  visitorUrl: string | null;
  projectName: string;
}) {
  const t = useTranslations('settings.publicPage.visitorLink');
  const { toast } = useToast();

  return (
    <SettingsCard
      testId="visitor-link-card"
      icon={<Link2 className="size-4" aria-hidden />}
      title={t('title')}
      subtitle={t.rich('subtitle', {
        projectName,
        strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
      })}
    >
      {visitorUrl ? (
        <div className="flex flex-col gap-2">
          <div className="flex min-h-(--height-control) items-center gap-2 rounded-(--radius-control) border border-(--el-border) bg-(--el-surface-soft) px-3 py-2">
            <span
              data-testid="visitor-link-url"
              className="min-w-0 flex-1 truncate font-mono text-[13px] text-(--el-text)"
            >
              {visitorUrl}
            </span>
            <button
              type="button"
              aria-label={t('copy')}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(visitorUrl)
                  .then(() => toast({ variant: 'success', title: t('copied') }));
              }}
              className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)"
            >
              <Copy className="h-4 w-4" aria-hidden />
            </button>
            <a
              href={visitorUrl}
              target="_blank"
              rel="noreferrer"
              aria-label={t('open')}
              className="inline-flex h-(--height-control) w-(--height-control) items-center justify-center rounded-(--radius-control) text-(--el-text-secondary) hover:bg-(--el-surface) hover:text-(--el-text)"
            >
              <ExternalLink className="h-4 w-4" aria-hidden />
            </a>
          </div>
          <p className="font-sans text-xs text-(--el-text-secondary)">{t('hint')}</p>
        </div>
      ) : (
        <div
          data-testid="visitor-link-not-public"
          className="flex items-start gap-2 rounded-(--radius-card) bg-(--el-tint-sky) p-(--spacing-card-padding)"
        >
          <Info className="text-(--el-text-strong) mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="font-sans text-xs text-(--el-text-strong)">
            <b className="font-semibold">{t('notPublic.lead')}</b>{' '}
            {t.rich('notPublic.body', {
              strong: (chunks) => <strong className="font-semibold">{chunks}</strong>,
              link: (chunks) => (
                <Link
                  href="/settings/project/members"
                  className="font-medium underline underline-offset-2"
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </div>
      )}
    </SettingsCard>
  );
}
