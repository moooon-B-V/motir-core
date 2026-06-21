import { Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// Email-change confirmation (Subtask 8.8.22). Sent to the user's NEW address
// when they request a verified email change; clicking the button confirms it
// (usersService.confirmEmailChange swaps the address). The 1-hour expiry copy
// here MUST match EMAIL_CHANGE_TOKEN_TTL_MS in usersService — change one, change
// the other. Localized via next-intl's synchronous createTranslator (rendering
// runs off-request, in the email.send job); `locale` defaults to the base
// locale when absent. Mirrors passwordReset.tsx.

// A minimal translator shape (satisfied by createTranslator's result).
type T = (key: string, values?: Record<string, string | number>) => string;

export interface EmailChangeEmailProps {
  recipientName: string;
  newEmail: string;
  confirmUrl: string;
  locale?: Locale;
}

function EmailChangeEmail({
  recipientName,
  newEmail,
  confirmUrl,
  t,
}: EmailChangeEmailProps & { t: T }) {
  return (
    <EmailLayout preview={t('preview')} footer={t('expires')}>
      <Text style={greeting}>{t('greeting', { name: recipientName })}</Text>
      <Text style={lede}>{t('lede', { email: newEmail })}</Text>
      <Section style={cta}>
        <PrimaryButton href={confirmUrl} label={t('confirm')} />
      </Section>
      <Text style={fallbackLabel}>{t('fallback')}</Text>
      <Text style={fallbackLinkRow}>
        <Link href={confirmUrl} style={fallbackLink}>
          {confirmUrl}
        </Link>
      </Text>
    </EmailLayout>
  );
}

const greeting = { fontSize: '16px', margin: '0 0 16px' };
const lede = { fontSize: '16px', margin: '0 0 24px' };
const cta = { margin: '0 0 24px' };
const fallbackLabel = { color: '#6b7280', fontSize: '14px', margin: '0 0 8px' };
const fallbackLinkRow = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '13px',
  margin: '0 0 24px',
};
const fallbackLink = { color: '#2563eb', wordBreak: 'break-all' as const };

export async function emailChangeEmail(props: EmailChangeEmailProps): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.emailChange',
  }) as T;
  const html = await render(<EmailChangeEmail {...props} t={t} />);
  return {
    subject: t('subject'),
    text: buildPlainText(props, t),
    html,
  };
}

function buildPlainText(props: EmailChangeEmailProps, t: T): string {
  return [
    t('greeting', { name: props.recipientName }),
    '',
    t('lede', { email: props.newEmail }),
    '',
    `${t('confirm')}: ${props.confirmUrl}`,
    '',
    t('expires'),
    '',
    '— Motir',
  ].join('\n');
}

export default EmailChangeEmail;
