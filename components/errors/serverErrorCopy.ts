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
  ja: {
    title: 'Motir を読み込めませんでした',
    body: 'このページを開く前に、こちら側で問題が発生しました。お客様の操作が原因ではありません。もう一度お試しいただくか、Motir のホームに戻ってください。問題が続く場合は、サポートへのお問い合わせ時に下記の参照番号をお知らせください。',
    retry: '再試行',
    retrying: '再試行しています…',
    home: 'Motir へ移動',
    reference: '参照番号',
    copyReference: '参照番号をコピー',
    copied: 'コピーしました',
  },
  ko: {
    title: 'Motir를 불러오지 못했습니다',
    body: '이 페이지가 열리기 전에 서버 쪽에서 문제가 발생했습니다. 사용자의 잘못이 아닙니다. 다시 시도하거나 Motir 홈으로 돌아가세요. 문제가 계속되면 지원팀에 문의할 때 아래 참조 번호를 함께 알려 주세요.',
    retry: '다시 시도',
    retrying: '다시 시도하는 중…',
    home: 'Motir로 이동',
    reference: '참조 번호',
    copyReference: '참조 번호 복사',
    copied: '복사됨',
  },
  de: {
    title: 'Motir konnte nicht geladen werden',
    body: 'Bei uns ist ein Fehler aufgetreten, bevor diese Seite geöffnet werden konnte – Sie haben nichts falsch gemacht. Versuchen Sie es erneut, oder kehren Sie zur Startseite von Motir zurück. Wenn das Problem weiterhin besteht, geben Sie die unten stehende Referenz an, wenn Sie sich an den Support wenden.',
    retry: 'Erneut versuchen',
    retrying: 'Neuer Versuch…',
    home: 'Zu Motir',
    reference: 'Referenz',
    copyReference: 'Referenz kopieren',
    copied: 'Kopiert',
  },
  fr: {
    title: 'Impossible de charger Motir',
    body: 'Une erreur s’est produite de notre côté avant l’ouverture de cette page ; vous n’y êtes pour rien. Réessayez, ou revenez à l’accueil de Motir. Si le problème persiste, indiquez la référence ci-dessous lorsque vous contactez le support.',
    retry: 'Réessayer',
    retrying: 'Nouvelle tentative…',
    home: 'Accéder à Motir',
    reference: 'Référence',
    copyReference: 'Copier la référence',
    copied: 'Copiée',
  },
  es: {
    title: 'Motir no se pudo cargar',
    body: 'Algo falló por nuestra parte antes de que se pudiera abrir esta página; no es por nada que hayas hecho. Vuelve a intentarlo o regresa al inicio de Motir. Si sigue ocurriendo, incluye la referencia de abajo cuando contactes con soporte.',
    retry: 'Reintentar',
    retrying: 'Reintentando…',
    home: 'Ir a Motir',
    reference: 'Referencia',
    copyReference: 'Copiar referencia',
    copied: 'Copiado',
  },
  it: {
    title: 'Impossibile caricare Motir',
    body: 'Si è verificato un errore da parte nostra prima che questa pagina potesse aprirsi: non è colpa di nulla che hai fatto. Riprova, oppure torna alla home di Motir. Se continua a succedere, includi il riferimento qui sotto quando contatti l’assistenza.',
    retry: 'Riprova',
    retrying: 'Nuovo tentativo…',
    home: 'Vai a Motir',
    reference: 'Riferimento',
    copyReference: 'Copia riferimento',
    copied: 'Copiato',
  },
  nl: {
    title: 'Motir kon niet worden geladen',
    body: 'Er ging aan onze kant iets mis voordat deze pagina kon openen — het ligt niet aan iets wat jij hebt gedaan. Probeer het opnieuw, of ga terug naar de startpagina van Motir. Blijft het gebeuren, vermeld dan de referentie hieronder als je contact opneemt met support.',
    retry: 'Opnieuw proberen',
    retrying: 'Opnieuw proberen…',
    home: 'Naar Motir',
    reference: 'Referentie',
    copyReference: 'Referentie kopiëren',
    copied: 'Gekopieerd',
  },
  pl: {
    title: 'Nie udało się załadować Motir',
    body: 'Coś poszło nie tak po naszej stronie, zanim ta strona mogła się otworzyć — to nie Twoja wina. Spróbuj ponownie lub wróć na stronę główną Motir. Jeśli problem będzie się powtarzał, podaj poniższy identyfikator, kontaktując się z pomocą techniczną.',
    retry: 'Spróbuj ponownie',
    retrying: 'Ponawianie próby…',
    home: 'Przejdź do Motir',
    reference: 'Identyfikator',
    copyReference: 'Kopiuj identyfikator',
    copied: 'Skopiowano',
  },
  pt: {
    title: 'Não foi possível carregar o Motir',
    body: 'Algo deu errado do nosso lado antes que esta página pudesse abrir — nada que você fez causou isso. Tente novamente ou volte para a página inicial do Motir. Se continuar acontecendo, inclua a referência abaixo ao entrar em contato com o suporte.',
    retry: 'Tentar novamente',
    retrying: 'Tentando novamente…',
    home: 'Ir para o Motir',
    reference: 'Referência',
    copyReference: 'Copiar referência',
    copied: 'Copiado',
  },
};
