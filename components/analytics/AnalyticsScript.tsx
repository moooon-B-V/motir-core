import { analyticsScriptSrc } from '@/lib/analytics';

/**
 * The product-analytics tag (MOTIR-1163; `docs/decisions/production-service-stack.md` §5).
 *
 * A SERVER component rendered from the root layout's `<head>`. It reads nothing
 * itself: the whole question — is analytics on, and what is loaded — is
 * `lib/analytics.ts`'s, so this file is the render and that file is the policy.
 *
 * Unset environment ⇒ `null` ⇒ no tag, no request, no analytics. That is the
 * self-hoster's guarantee, and it is why this returns `null` rather than
 * rendering a disabled tag.
 *
 * `defer` is Plausible's documented embed shape: the script runs after the
 * document parses, so it never blocks the first paint.
 */
export function AnalyticsScript() {
  const src = analyticsScriptSrc();
  if (src === null) return null;

  return <script defer src={src} />;
}
