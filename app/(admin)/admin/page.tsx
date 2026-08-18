import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Building2 } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';

/**
 * The console landing page — design `platform-admin/console.mock.html`
 * **Panel 2**, its header half.
 *
 * ⚠️ THE SHELL AND THE HEADER, AND DELIBERATELY NOT THE ESTATE.
 * The asset draws this page populated: four estate counts and a paginated
 * cross-tenant activity feed. Every one of those numbers is a READ ACROSS THE
 * TENANT BOUNDARY, which is `platformReadService` — MOTIR-730's card — over
 * policy arms MOTIR-730 also owns, surfaced by MOTIR-731. This card's
 * acceptance criteria forbid a cross-tenant read in this PR, in as many words,
 * and its whole reason to exist is that the gate underneath them is built ONCE
 * rather than three times.
 *
 * So the page renders the header the asset draws and, where the counts go, the
 * asset's own Panel 7(b) empty-state grammar (the shipped `EmptyState`) saying
 * what arrives and which card brings it. A placeholder number would be the one
 * outcome worse than an absent one: the design's Panel 7(d) note — *"no tenant
 * has zero usage; the figures are simply not loaded"* — is the same principle
 * one panel over.
 */

export const metadata: Metadata = {
  // No description, and nothing here names what the surface DOES. A metadata
  // block is rendered markup; the 404 posture is about the route's existence
  // never being confirmable, and this page is only ever rendered for a
  // principal who has already passed the gate.
  title: 'Platform admin',
};

export default async function AdminOverviewPage() {
  const t = await getTranslations('platformAdmin');

  return (
    <div className="mx-auto flex max-w-[72rem] flex-col gap-4 px-6 py-6">
      <p className="font-sans text-xs uppercase tracking-wide text-(--el-text-secondary)">
        {t('overview.breadcrumb')}
      </p>
      <div className="flex flex-col gap-2">
        <h1 className="font-serif text-2xl text-(--el-text)">{t('overview.title')}</h1>
        <p className="max-w-prose font-sans text-sm text-(--el-text-secondary)">
          {t('overview.subtitle')}
        </p>
      </div>

      <EmptyState
        icon={<Building2 className="h-12 w-12" aria-hidden />}
        title={t('overview.pendingTitle')}
        description={t('overview.pendingDescription')}
      />
    </div>
  );
}
