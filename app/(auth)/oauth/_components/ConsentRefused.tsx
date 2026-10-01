import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CircleX } from 'lucide-react';
import { buttonVariants } from '@/components/ui/Button';
import { cn } from '@/lib/utils/cn';
import type { OAuthConsentProblem } from '@/lib/oauth/errors';
import { CodeChip } from '../../_components/AuthShell';
import { Callout, Strong, TerminalState } from './consentParts';

// Panel 7 — a connection request that cannot be used (Story MOTIR-6973 ·
// Subtask MOTIR-6985). The ONE state with no exit redirect and no Approve or
// Deny: an unknown client or an unregistered redirect leaves no address Motir
// can trust to send an answer to, and a forged or expired request has nothing
// to answer. The reason is said in words; the quoted code is for the app's maker.

/** The code the refused page quotes, per reason (design § Panel 7's reasons). */
const QUOTED_CODE: Record<OAuthConsentProblem, string> = {
  invalid_client: 'invalid_client',
  invalid_redirect: 'invalid_request · redirect_uri',
  client_metadata: 'invalid_client · client_id metadata document',
  code_challenge: 'invalid_request · code_challenge',
  invalid_target: 'invalid_target · resource',
  expired: 'invalid_request · expired',
  not_issued: 'invalid_request · signature',
  rejected: 'server_error',
};

const PROBLEMS = new Set<string>(Object.keys(QUOTED_CODE));

/**
 * Read the provider's `error` (or Motir's own reason) into a problem the page
 * can name. Anything unrecognised is the most general refusal — a request Motir
 * did not issue — rather than a blank page.
 */
export function consentProblemFrom(error: string | null | undefined): OAuthConsentProblem {
  if (!error) return 'not_issued';
  if (PROBLEMS.has(error)) return error as OAuthConsentProblem;
  if (error === 'client_disabled') return 'invalid_client';
  return 'not_issued';
}

export function ConsentRefused({
  problem,
  host,
  detail,
}: {
  problem: OAuthConsentProblem;
  /** The redirect host an `invalid_redirect` asked for, or the host of a
   * refused metadata document — shown as data only. */
  host?: string | null;
  /** Why a metadata document was refused, in the plugin's words — data only. */
  detail?: string | null;
}) {
  const t = useTranslations('oauthConsent');
  const reason =
    problem === 'invalid_redirect'
      ? host
        ? t.rich('refused.reason.invalid_redirect', { host, b: (c) => <Strong>{c}</Strong> })
        : t('refused.reason.invalid_redirect_nohost')
      : problem === 'client_metadata'
        ? host && detail
          ? t.rich('refused.reason.client_metadata', {
              host,
              detail,
              b: (c) => <Strong>{c}</Strong>,
            })
          : t('refused.reason.client_metadata_nohost')
        : t(`refused.reason.${problem}`);
  return (
    <TerminalState
      headline={t('heading.refused')}
      subhead={t('subhead.refused')}
      foot={t('foot.closeTab')}
    >
      <Callout tone="danger" icon={<CircleX className="h-5 w-5" aria-hidden />}>
        {reason}
      </Callout>
      <p className="font-sans text-sm leading-relaxed text-(--el-text-secondary)">
        {t.rich('refused.next', {
          code: QUOTED_CODE[problem],
          chip: (c) => <CodeChip>{c}</CodeChip>,
        })}
      </p>
      <Link href="/" className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'w-full')}>
        {t('refused.home')}
      </Link>
    </TerminalState>
  );
}
