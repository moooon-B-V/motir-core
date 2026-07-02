// i18n-injecting wrapper over the `@motir/design-system` ErrorState
// (MOTIR-1527). The package takes the retry-button label as a prop (English
// default) since it no longer depends on `next-intl`; this shim supplies
// motir-core's translated `common.retry`, so existing `<ErrorState>` call sites
// stay localized. Ref forwarding is preserved to match the original primitive.
import { forwardRef } from 'react';
import { useTranslations } from 'next-intl';
import { ErrorState as BaseErrorState, type ErrorStateProps } from '@motir/design-system';

export const ErrorState = forwardRef<HTMLDivElement, ErrorStateProps>(
  function ErrorState(props, ref) {
    const tc = useTranslations('common');
    // retryLabel default first so an explicit caller-supplied label still wins.
    return <BaseErrorState ref={ref} retryLabel={tc('retry')} {...props} />;
  },
);

export type { ErrorStateProps };
