import { Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// Password-reset email. Wired into Better-Auth's
// emailAndPassword.sendResetPassword in lib/auth/index.ts. The 1-hour expiry
// copy here MUST match the resetPasswordTokenExpiresIn config — if you change
// one, change the other. Localized via next-intl's synchronous createTranslator
// (rendering runs off-request, in the email.send job); `locale` defaults to the
// base locale when absent.

// A minimal translator shape (satisfied by createTranslator's result).
type T = (key: string, values?: Record<string, string | number>) => string;

export interface PasswordResetEmailProps {
  recipientName: string;
  resetUrl: string;
  locale?: Locale;
}

function PasswordResetEmail({ recipientName, resetUrl, t }: PasswordResetEmailProps & { t: T }) {
  return (
    <EmailLayout preview={t('preview')} footer={t('expires')}>
      <Text style={greeting}>{t('greeting', { name: recipientName })}</Text>
      <Text style={lede}>{t('lede')}</Text>
      <Section style={cta}>
        <PrimaryButton href={resetUrl} label={t('reset')} />
      </Section>
      <Text style={fallbackLabel}>{t('fallback')}</Text>
      <Text style={fallbackLinkRow}>
        <Link href={resetUrl} style={fallbackLink}>
          {resetUrl}
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

export async function passwordResetEmail(props: PasswordResetEmailProps): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.passwordReset',
  }) as T;
  const html = await render(<PasswordResetEmail {...props} t={t} />);
  return {
    subject: t('subject'),
    text: buildPlainText(props, t),
    html,
  };
}

function buildPlainText(props: PasswordResetEmailProps, t: T): string {
  return [
    t('greeting', { name: props.recipientName }),
    '',
    t('lede'),
    '',
    `${t('reset')}: ${props.resetUrl}`,
    '',
    t('expires'),
    '',
    '— Prodect',
  ].join('\n');
}

export default PasswordResetEmail;
