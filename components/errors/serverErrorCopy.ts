import type { Locale } from '@/lib/i18n/locales';

// The server-error page's strings (MOTIR-6855 · design MOTIR-6854,
// `design/shell/design-notes.md` § The server-error page).
//
// States 1 and 2 (`app/(authed)/error.tsx`, `app/error.tsx`) render inside the
// root layout's `next-intl` provider and read these from `messages/*.json`
// (`errors.serverError.*`, plus `common.retry` and `errors.notFound.homeAction`)
// through `useServerErrorCopy`. State 3 (`app/global-error.tsx`) REPLACES that
// layout, so no provider exists there — it takes the static twin below.
// `tests/components/server-error-boundaries.test.tsx` asserts the twin equals
// the catalogs key for key, so the two cannot drift.

export interface ServerErrorCopy {
  title: string;
  body: string;
  retry: string;
  retrying: string;
  home: string;
  reference: string;
  copyReference: string;
  copied: string;
}

/** Which boundary is speaking: a PAGE failed inside the shell, or the APP around it did. */
export type ServerErrorVariant = 'page' | 'app';

/** State 3's copy — the app-level variant, in every shipped locale. */
export const GLOBAL_ERROR_COPY: Record<Locale, ServerErrorCopy> = {
  en: {
    title: 'Motir couldn’t load',
    body: 'Something went wrong on our side before this page could open — nothing you did caused this. Try again, or go back to Motir’s home. If it keeps happening, include the reference below when you contact support.',
    retry: 'Try again',
    retrying: 'Trying again…',
    home: 'Go to Motir',
    reference: 'Reference',
    copyReference: 'Copy reference',
    copied: 'Copied',
  },
  zh: {
    title: 'Motir 无法加载',
    body: '页面打开之前，我们这边出现了问题，这不是你的操作导致的。请重试，或返回 Motir 首页。如果问题持续出现，联系支持时请附上下方的参考编号。',
    retry: '重试',
    retrying: '正在重试…',
    home: '前往 Motir',
    reference: '参考编号',
    copyReference: '复制参考编号',
    copied: '已复制',
  },
};
