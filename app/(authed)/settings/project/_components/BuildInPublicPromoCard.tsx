'use client';

import { useTranslations } from 'next-intl';
import { CheckCheck, Megaphone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { BuildInPublicDialog } from '@/app/(authed)/settings/project/members/_components/BuildInPublicDialog';
import { useGoPublic } from '@/app/(authed)/_components/build-in-public/useGoPublic';

// BuildInPublicPromoCard (Story 6.17 · Subtask 6.17.3 · design Panel 10c) — the
// DURABLE home for the build-in-public entry: a bordered promo card on the
// project-settings General page. It reinforces the promoted header button with
// the full "what's shared" pitch + a primary CTA, so an admin who wants to read
// the details before going public has a settings-side surface that doesn't
// vanish (unlike the one-time nudge).
//
// Rendered by the General page ONLY when the project is non-public and the
// actor can manage it. The card carries a soft decorative corner-wash; per
// finding #35 the text sits on --el-page-bg (never on the wash) so AA holds.
const PROMO_BULLETS = ['promoBullet1', 'promoBullet2', 'promoBullet3'] as const;

export function BuildInPublicPromoCard({ projectKey }: { projectKey: string }) {
  const t = useTranslations('settings.buildInPublic');
  const { open, setOpen, pending, confirm } = useGoPublic(projectKey);

  return (
    <section className="relative overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-page-bg) p-(--spacing-card-padding) shadow-(--shadow-subtle)">
      {/* Decorative corner wash — purely presentational, sits BEHIND the content
          which keeps its own --el-page-bg backdrop (finding #35: never tint the
          text surface). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(120% 80% at 100% 0%, var(--el-hero-wash-a) 0%, transparent 55%), radial-gradient(90% 70% at 0% 100%, var(--el-hero-wash-b) 0%, transparent 55%)',
        }}
      />
      <div className="relative flex flex-col">
        <div className="mb-3 flex items-center gap-3">
          <span
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-accent) text-(--el-accent-text)"
            aria-hidden
          >
            <Megaphone className="size-5" />
          </span>
          <div>
            <h2 className="font-serif text-lg font-semibold text-(--el-text)">{t('promoTitle')}</h2>
            <p className="mt-0.5 font-sans text-xs text-(--el-text-muted)">{t('promoSub')}</p>
          </div>
        </div>

        <ul role="list" className="mb-4 flex flex-col gap-2">
          {PROMO_BULLETS.map((key) => (
            <li key={key} className="flex items-start gap-2.5">
              <CheckCheck className="mt-0.5 size-4 shrink-0 text-(--el-success)" aria-hidden />
              <span className="font-sans text-sm text-(--el-text-secondary)">{t(key)}</span>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="lg"
            onClick={() => setOpen(true)}
            leftIcon={<Megaphone className="size-4" />}
          >
            {t('confirmCta')}
          </Button>
          <Button variant="ghost" size="lg" onClick={() => setOpen(true)}>
            {t('learnMore')}
          </Button>
        </div>
      </div>

      <BuildInPublicDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={confirm}
        pending={pending}
      />
    </section>
  );
}
