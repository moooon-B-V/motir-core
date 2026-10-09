'use client';

import { useLayoutEffect } from 'react';
import { GlobalErrorContent, useGlobalErrorLocale } from '@/components/errors/GlobalErrorContent';
import { localeDir } from '@/lib/i18n/locales';
import { globalErrorInitScript } from '@/lib/theme/init-script';
import { fontVariables } from './fonts';
import './globals.css';

// STATE 3 of the server-error page (MOTIR-6855 · design MOTIR-6854,
// `design/shell/server-error.mock.html` panel 3): `app/layout.tsx` ITSELF threw.
// It is a database reader — `appearancePreferenceService.getApplied` on every
// signed-in request — so the stall behind Bug MOTIR-6776 can take it down too,
// and only this file catches that.
//
// It REPLACES the root layout, so everything that layout supplies has to be
// brought here or it is simply absent (design notes § What state 3 loses):
//   - `<html>` / `<body>` themselves, and `app/globals.css`;
//   - the FONTS — `fontVariables`, shared with the layout through `app/fonts.ts`;
//   - the APPEARANCE — the server preference is the very read that may have
//     failed, so this runs the theme init script with NO server preference:
//     it applies the appearance last stored on THIS device (the signed-in
//     layout reconciles that store on every page) and resolves `system` through
//     `matchMedia`. The per-language font picks come from the same device
//     cache (MOTIR-7896): the page language's `data-font-set-*` attributes the
//     last signed-in render stored here. Ink and ground then both come from
//     `--el-*` under the ONE `data-theme` it sets — never ink from the OS over
//     a ground from the app, which is how MOTIR-4708's 404 rendered at 1.00 : 1;
//   - the LOCALE and its catalog — see `GlobalErrorContent`.
//
// The script runs twice on purpose, and it is idempotent: inline in `<head>` for
// a document the SERVER rendered, and once more after commit for one React
// rendered on the CLIENT, where an inline `<script>` element does not execute.

function applyStoredAppearance() {
  const script = document.createElement('script');
  script.text = globalErrorInitScript;
  document.head.appendChild(script);
  script.remove();
}

export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const locale = useGlobalErrorLocale();
  useLayoutEffect(applyStoredAppearance, []);

  return (
    <html
      lang={locale}
      dir={localeDir[locale]}
      className={`${fontVariables} antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: globalErrorInitScript }} />
      </head>
      <body>
        <GlobalErrorContent error={error} retry={retry} locale={locale} />
      </body>
    </html>
  );
}
