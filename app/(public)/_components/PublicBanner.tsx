import { Globe, Lock } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

// The full-width public banner (Story 6.12 · Subtask 6.12.4 · design Panel 2
// `.pub-banner`). The explicit "anyone can view — no account needed; sign in to
// act" framing + a lock-glyph "view-only, you can't edit work items" note.
// Background --el-public-banner-bg, text --el-public-banner-text (AA on the
// sky tint, finding #35). Server component.

export async function PublicBanner() {
  const t = await getTranslations('publicProjects');
  return (
    <div className="flex flex-wrap items-center gap-2.5 bg-(--el-public-banner-bg) px-(--spacing-card-padding) py-2.5 text-[12.5px] text-(--el-public-banner-text)">
      <Globe className="h-[15px] w-[15px] flex-none text-(--el-info)" aria-hidden />
      <span>
        <b className="font-bold">{t('bannerLead')}</b> {t('bannerBody')}
      </span>
      <span aria-hidden className="text-(--el-text-faint)">
        ·
      </span>
      <span className="inline-flex items-center gap-1.5 text-(--el-text-muted)">
        <Lock className="h-[14px] w-[14px] text-(--el-text-faint)" aria-hidden />
        {t('viewOnly')}
      </span>
    </div>
  );
}
