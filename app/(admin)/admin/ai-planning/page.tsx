import { Suspense } from 'react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Info } from 'lucide-react';
import { MotirAiError } from '@/lib/ai/errors';
import type { PlatformPlannerModelSettingsDTO } from '@/lib/dto/platformPlannerModel';
import { requirePlatformStaff } from '@/lib/platform/auth';
import { platformPlannerModelService } from '@/lib/services/platformPlannerModelService';
import { PlannerModelRows } from './_components/PlannerModelRows';
import { PlannerModelsSkeleton } from './_components/PlannerModelsSkeleton';
import { PlannerModelsUnavailable } from './_components/PlannerModelsUnavailable';
import type { PlatformPrincipal } from '@/lib/platform/auth';

/**
 * The console's AI PLANNING page — design `platform-admin/design-notes.md`
 * § AMENDMENT 2026-10 (MOTIR-7222), card MOTIR-7231, story MOTIR-7220.
 *
 * Which model Motir plans with, one row per audience. Every staff role reads
 * it; only a `superadmin` gets the pickers. A non-staff request never reaches
 * this file: the `(admin)` layout answers the app's 404 first.
 *
 * ⚠️ NO VALUE IS GUESSED. When motir-ai cannot answer, the page renders the
 * console's error card with Retry and no rows (Panel 9), rather than a default
 * that might not be what jobs are using.
 */

export const metadata: Metadata = { title: 'AI planning' };

/** Never cached — a model changed a minute ago must show on the next load. */
export const dynamic = 'force-dynamic';

export default async function AdminAiPlanningPage() {
  const principal = await requirePlatformStaff('support');
  const t = await getTranslations('platformAdmin.aiPlanning');

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('breadcrumb')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">{t('subtitle')}</p>
        <p className="flex items-start gap-2 font-sans text-xs text-(--el-text-secondary)">
          <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-info)" />
          <span>{t('precedence')}</span>
        </p>
        <p className="flex items-start gap-2 font-sans text-xs text-(--el-text-secondary)">
          <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--el-info)" />
          <span>
            <strong className="font-semibold text-(--el-text-strong)">
              {t('tenantSecretLead')}
            </strong>{' '}
            {t('tenantSecretBody')}
          </span>
        </p>
      </div>

      {/* After the gate, so the frame can never fix a status (CLAUDE.md's
          boundary rule); the header above paints at once (Panel 3). */}
      <Suspense fallback={<PlannerModelsSkeleton title={t('card.title')} />}>
        <PlannerModelsSection principal={principal} />
      </Suspense>
    </div>
  );
}

async function PlannerModelsSection({ principal }: { principal: PlatformPrincipal }) {
  let settings: PlatformPlannerModelSettingsDTO;
  try {
    settings = await platformPlannerModelService.getSettings(principal);
  } catch (err) {
    // Any motir-ai failure — down, misconfigured, or an answer that is not
    // settings — is the unavailable state. Anything else is a real bug.
    if (!(err instanceof MotirAiError)) throw err;
    console.error('[admin] AI planning settings could not be read', err);
    return <PlannerModelsUnavailable />;
  }
  return <PlannerModelRows settings={settings} />;
}
