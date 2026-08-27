import { Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// The double-opt-in CONFIRMATION for an email-only follow (Story 8.9 · Subtask
// 8.9.5 · `docs/decisions/public-follow-and-changelog.md` §4).
//
// This is the ONLY mail this story sends to an address that has not confirmed,
// and the copy is written to survive being read by someone who did NOT ask for
// it: it names the project, says plainly that ignoring it ends the matter, and
// asks for nothing else. An address typed by somebody else costs its owner one
// email and one decision to make no decision.
//
// The 24-hour expiry copy MUST match `CONFIRM_TOKEN_TTL_MS` in
// `lib/publicProjects/followTokens.ts` — if you change one, change the other.
// Pure, like every template here: no `sendEmail`, no `db`, no `process.env`;
// the service builds the URL and dispatches.

type T = (key: string, values?: Record<string, string | number>) => string;

export interface FollowConfirmEmailProps {
  projectName: string;
  confirmUrl: string;
  locale?: Locale;
}

function FollowConfirmEmail({ projectName, confirmUrl, t }: FollowConfirmEmailProps & { t: T }) {
  return (
    <EmailLayout preview={t('preview', { project: projectName })} footer={t('ignore')}>
      <Text style={lede}>{t('lede', { project: projectName })}</Text>
      <Section style={cta}>
        <PrimaryButton href={confirmUrl} label={t('confirm')} />
      </Section>
      <Text style={what}>{t('what')}</Text>
      <Text style={fallbackLabel}>{t('fallback')}</Text>
      <Text style={fallbackLinkRow}>
        <Link href={confirmUrl} style={fallbackLink}>
          {confirmUrl}
        </Link>
      </Text>
    </EmailLayout>
  );
}

const lede = { fontSize: '16px', margin: '0 0 24px' };
const cta = { margin: '0 0 24px' };
const what = { fontSize: '14px', color: '#4b5563', margin: '0 0 24px' };
const fallbackLabel = { color: '#6b7280', fontSize: '14px', margin: '0 0 8px' };
const fallbackLinkRow = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '13px',
  margin: '0 0 24px',
};
const fallbackLink = { color: '#2563eb', wordBreak: 'break-all' as const };

export async function followConfirmEmail(props: FollowConfirmEmailProps): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.followConfirm',
  }) as T;
  const html = await render(<FollowConfirmEmail {...props} t={t} />);
  return {
    subject: t('subject', { project: props.projectName }),
    text: buildPlainText(props, t),
    html,
  };
}

function buildPlainText(props: FollowConfirmEmailProps, t: T): string {
  return [
    t('lede', { project: props.projectName }),
    '',
    `${t('confirm')}: ${props.confirmUrl}`,
    '',
    t('what'),
    '',
    t('ignore'),
    '',
    '— Motir',
  ].join('\n');
}

export default FollowConfirmEmail;
