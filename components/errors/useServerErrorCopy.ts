'use client';

import { useTranslations } from 'next-intl';
import type { ServerErrorCopy, ServerErrorVariant } from './serverErrorCopy';

/** The catalog copy for states 1 and 2 — needs the root layout's `next-intl` provider. */
export function useServerErrorCopy(variant: ServerErrorVariant): ServerErrorCopy {
  const t = useTranslations('errors.serverError');
  const tc = useTranslations('common');
  const tn = useTranslations('errors.notFound');
  return {
    title: t(variant === 'page' ? 'pageTitle' : 'appTitle'),
    body: t(variant === 'page' ? 'pageBody' : 'appBody'),
    retry: tc('retry'),
    retrying: t('retrying'),
    home: tn('homeAction'),
    reference: t('reference'),
    copyReference: t('copyReference'),
    copied: t('copied'),
  };
}
