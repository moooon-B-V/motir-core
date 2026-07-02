'use client';

// i18n-injecting wrapper over the `@motir/design-system` Toast (MOTIR-1527).
// The package's `ToastProvider` takes the close-button accessible label as a
// prop (English default) since it no longer depends on `next-intl`; this shim
// wires motir-core's translated `common.close`. `useToast` is re-exported
// unchanged.
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ToastProvider as BaseToastProvider, useToast } from '@motir/design-system';

export function ToastProvider({ children }: { children: ReactNode }) {
  const tc = useTranslations('common');
  return <BaseToastProvider closeLabel={tc('close')}>{children}</BaseToastProvider>;
}

export { useToast };
