import { sanitizeNextPath } from '@/lib/navigation/nextDestination';

// The paths of the Visitor's one-time CONSENT screen (Story MOTIR-6170 ·
// MOTIR-6669; design MOTIR-6641 panels 1–2). Pure, so the page, the Visitor
// layout's redirect (MOTIR-6648) and the tests all build the same addresses.

/** The view a Visitor link lands on when it names none (design panel 5: the board). */
export const VISITOR_DEFAULT_VIEW = 'board';

/** `/p/<identifier>` — the prefix every Visitor path of this project starts with. */
function visitorPrefix(identifier: string): string {
  return `/p/${encodeURIComponent(identifier)}`;
}

/** The consent screen's own path — never a valid destination for its `next`. */
export function visitorConsentPathname(identifier: string): string {
  return `${visitorPrefix(identifier)}/consent`;
}

/**
 * Where the consent screen sends the reader afterwards: the `next` it was given,
 * ONLY when that is a same-site path inside THIS project's Visitor views and not
 * the consent screen itself; otherwise the project's default view. A `next`
 * naming another project, another host or the consent loop is replaced, never
 * followed.
 */
export function visitorConsentNext(identifier: string, raw: string | string[] | undefined): string {
  const fallback = `${visitorPrefix(identifier)}/${VISITOR_DEFAULT_VIEW}`;
  const next = sanitizeNextPath(raw);
  if (!next) return fallback;
  const prefix = `${visitorPrefix(identifier)}/`;
  if (!next.startsWith(prefix)) return fallback;
  const rest = next.slice(prefix.length);
  if (rest.length === 0 || /^consent(?:[/?#]|$)/.test(rest)) return fallback;
  if (rest.split(/[?#]/)[0]!.split('/').includes('..')) return fallback;
  return next;
}

/** The consent screen, carrying where to go after it. */
export function visitorConsentPath(identifier: string, next: string): string {
  return `${visitorConsentPathname(identifier)}?next=${encodeURIComponent(next)}`;
}

/**
 * The sign-in hand-off (design panel 1): the SHIPPED sign-in page, whose `next`
 * is the consent screen, whose own `next` is the view. Two hops, both carried by
 * `sanitizeNextPath` on the way back.
 */
export function visitorSignInPath(identifier: string, next: string): string {
  return `/sign-in?next=${encodeURIComponent(visitorConsentPath(identifier, next))}`;
}

/**
 * Where Go back leaves to (design panel 2): the project's motir.co page when the
 * reader arrived from the public site, otherwise the app's root. The referrer is
 * only ever COMPARED against the configured public origin — its value is never
 * used as a destination. While the public origin is unconfigured it is this
 * application's own origin, and then nothing counts as "from motir.co".
 */
export function visitorGoBackHref(args: {
  identifier: string;
  referer: string | null;
  publicOrigin: string;
  appOrigin: string;
}): string {
  const { identifier, referer, publicOrigin, appOrigin } = args;
  if (!referer || publicOrigin === appOrigin) return '/';
  let from: URL;
  try {
    from = new URL(referer);
  } catch {
    return '/';
  }
  if (from.origin !== new URL(publicOrigin).origin) return '/';
  return `${publicOrigin}/p/${encodeURIComponent(identifier)}`;
}
