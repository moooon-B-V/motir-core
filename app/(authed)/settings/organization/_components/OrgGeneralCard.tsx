'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { Crown } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { FormField } from '@/components/ui/FormField';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';
import { ORGANIZATION_ROLE } from '@/lib/organizations/roles';
import type { ContentLanguageLatestChangeDTO } from '@/lib/dto/organizations';
import { isLocale, locales, localeLabel, type Locale } from '@/lib/i18n/locales';
import { ContentLanguageConfirmDialog } from './ContentLanguageConfirmDialog';

export interface OrgGeneralCardProps {
  orgId: string;
  initialName: string;
  role: string;
  workspaceCount: number;
  memberCount: number;
  /** The organisation's stored content language (Story MOTIR-7731). */
  contentLanguage: Locale;
  /** `orgCan(role, 'manageOrgSettings')`, decided by the page — never a role
   *  string compared here. False draws every value read-only, with no Save. */
  canEdit: boolean;
  /** The newest content-language change, for the attribution line; null when
   *  it was never changed. */
  latestContentLanguageChange?: ContentLanguageLatestChangeDTO | null;
}

const LANGUAGE_FIELD_ID = 'org-content-language';

// The org-settings General card (design/org-admin panel 2). The organization's
// NAME and its CONTENT LANGUAGE — the language Motir's planner and agents write
// its new work in (MOTIR-8095, `org-admin--content-language.mock.html`). ONE
// Save covers both: with the language unchanged it PATCHes the name exactly as
// before; with the language changed the confirm opens FIRST and nothing is sent
// until Confirm, which PATCHes the content-language route and only then a
// changed name. Any failure reverts the select to the stored value and shows the
// card's error toast. Success → one toast, then router.refresh() so the new
// values re-render the shell org control too (an explicit Save, not a list-cell
// edit — so the whole-tree refresh is appropriate here). The server stays the
// authority: `canEdit` false is presentation, the route's 403 is the refusal.
//
// It used to carry a second, read-only row: an "Organization URL" showing
// `motir.co/<slug>`. That row is gone (MOTIR-2548), per
// `docs/decisions/organization-url.md` — Motir does not adopt
// organization-addressable URLs, nothing in the product resolves that address,
// and a field whose helper text promised it was "used in links" was the product
// describing a capability it does not have. `Organization.slug` itself is
// untouched; it is internal substrate now, not a value anyone is shown.
export function OrgGeneralCard({
  orgId,
  initialName,
  role,
  workspaceCount,
  memberCount,
  contentLanguage,
  canEdit,
  latestContentLanguageChange = null,
}: OrgGeneralCardProps) {
  const t = useTranslations('orgAdmin');
  const format = useFormatter();
  const router = useRouter();
  const { toast } = useToast();
  const [name, setName] = useState(initialName);
  const [language, setLanguage] = useState<Locale>(contentLanguage);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const isOwner = role === ORGANIZATION_ROLE.owner;
  const options: ComboboxOption<Locale>[] = locales.map((locale) => ({
    value: locale,
    label: localeLabel[locale],
    lang: locale,
  }));

  function patch(url: string, body: unknown): Promise<boolean> {
    return fetch(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(
      (res) => res.ok,
      () => false,
    );
  }

  function fail() {
    setLanguage(contentLanguage);
    toast({ variant: 'error', title: t('settings.saveError') });
  }

  function succeed() {
    toast({ variant: 'success', title: t('settings.saved') });
    router.refresh();
  }

  function handleSave() {
    const value = name.trim();
    if (!value) return;
    if (language !== contentLanguage) {
      setConfirmOpen(true);
      return;
    }
    startTransition(async () => {
      if (await patch(`/api/organizations/${orgId}`, { name: value })) succeed();
      else fail();
    });
  }

  function handleConfirm() {
    const value = name.trim();
    startTransition(async () => {
      const languageSaved = await patch(`/api/organizations/${orgId}/content-language`, {
        language,
      });
      setConfirmOpen(false);
      if (!languageSaved) return fail();
      if (value !== initialName && !(await patch(`/api/organizations/${orgId}`, { name: value }))) {
        // The language is saved; refresh so the card reads it back as stored.
        toast({ variant: 'error', title: t('settings.saveError') });
        router.refresh();
        return;
      }
      succeed();
    });
  }

  function handleConfirmOpenChange(open: boolean) {
    setConfirmOpen(open);
    if (!open) setLanguage(contentLanguage);
  }

  const helpText = t('settings.contentLanguageHelp');
  const attribution = latestContentLanguageChange
    ? t('settings.contentLanguageChangedBy', {
        from: isLocale(latestContentLanguageChange.fromLanguage)
          ? localeLabel[latestContentLanguageChange.fromLanguage]
          : latestContentLanguageChange.fromLanguage,
        person:
          latestContentLanguageChange.changedByLabel ?? t('settings.contentLanguageFormerMember'),
        date: format.dateTime(new Date(latestContentLanguageChange.changedAt), {
          dateStyle: 'medium',
        }),
      })
    : null;

  return (
    <Card
      header={
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="font-sans text-base font-semibold text-(--el-text)">
              {t('settings.general')}
            </h2>
            <p className="text-(--el-text-muted) font-sans text-sm">{t('settings.generalSub')}</p>
          </div>
          <Pill orgRole={isOwner ? 'owner' : 'admin'} className="shrink-0">
            <Crown className="h-3.5 w-3.5" aria-hidden />
            {isOwner ? t('settings.youreTheOwner') : t('settings.youreAdmin')}
          </Pill>
        </div>
      }
      footer={
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-(--el-text-muted) font-sans text-xs">
            {t('settings.workspacesSummary', { count: workspaceCount })} ·{' '}
            {t('settings.membersSummary', { count: memberCount })}
          </span>
          {canEdit ? (
            <Button
              variant="primary"
              className="w-full sm:w-auto"
              loading={isPending && !confirmOpen}
              disabled={!name.trim()}
              onClick={handleSave}
            >
              {t('settings.save')}
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label={t('settings.nameLabel')}
          value={name}
          readOnly={!canEdit}
          onChange={(e) => setName(e.target.value)}
        />
        {canEdit ? (
          <div className="flex flex-col gap-1">
            <FormField
              label={t('settings.contentLanguageLabel')}
              htmlFor={LANGUAGE_FIELD_ID}
              helperText={helpText}
            >
              <div className="w-full max-w-[16rem]">
                <Combobox
                  id={LANGUAGE_FIELD_ID}
                  label={t('settings.contentLanguageLabel')}
                  options={options}
                  value={language}
                  onChange={setLanguage}
                  disabled={isPending}
                />
              </div>
            </FormField>
            {attribution ? (
              <p className="font-sans text-xs text-(--el-text-secondary)">{attribution}</p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="font-sans text-sm font-medium text-(--el-text)">
              {t('settings.contentLanguageLabel')}
            </span>
            <span lang={contentLanguage} className="font-sans text-sm text-(--el-text)">
              {localeLabel[contentLanguage]}
            </span>
            <p className="text-(--el-text-helper) font-sans text-xs">{helpText}</p>
          </div>
        )}
      </div>
      {canEdit ? (
        <ContentLanguageConfirmDialog
          open={confirmOpen}
          onOpenChange={handleConfirmOpenChange}
          orgName={initialName}
          from={contentLanguage}
          to={language}
          onConfirm={handleConfirm}
          pending={isPending}
        />
      ) : null}
    </Card>
  );
}
