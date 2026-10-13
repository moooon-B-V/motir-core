import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  DIRECTION_DOC_NAMESPACE,
  TIER_META,
  type DirectionDocKind,
} from '@/lib/onboarding/directionDoc';

/**
 * The plain-language tier title (`TIER_META[kind].labelKey`) in the reader's
 * language — the doc heading, the tier station's title, a crumb, a chip. Every
 * surface that names a tier reads it through here, so none of them can fall back
 * to an English literal (MOTIR-8331).
 */
export function useTierLabel(): (kind: DirectionDocKind) => string {
  const t = useTranslations(DIRECTION_DOC_NAMESPACE);
  return useCallback((kind: DirectionDocKind) => t(TIER_META[kind].labelKey), [t]);
}
