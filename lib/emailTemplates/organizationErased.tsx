import { Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// An organization has been ERASED (Story MOTIR-6306 · MOTIR-6395;
// `docs/decisions/organization-deletion.md` §6–§8). The last message the Owner and
// Admins get from it: what went, and the one thing kept — the billing record, until
// its retention ends. No call to action: there is nothing left to open.
//
// The organization's NAME is passed in rather than read: by the time this renders
// the org row is a tombstone whose name has been scrubbed.

type T = (key: string, values?: Record<string, string | number>) => string;

export interface OrganizationErasedEmailProps {
  recipientName: string;
  organizationName: string;
  /** The calendar year the retained billing record is purged in. */
  retentionUntilYear: number;
  locale?: Locale;
}

function values(p: OrganizationErasedEmailProps) {
  return { name: p.recipientName, organization: p.organizationName, year: p.retentionUntilYear };
}

function OrganizationErasedEmail(props: OrganizationErasedEmailProps & { t: T }) {
  const { t } = props;
  return (
    <EmailLayout preview={t('preview', values(props))} footer={t('footer')}>
      <Text style={para}>{t('greeting', values(props))}</Text>
      <Text style={para}>{t('lede', values(props))}</Text>
      <Text style={para}>{t('kept', values(props))}</Text>
    </EmailLayout>
  );
}

const para = { fontSize: '16px', margin: '0 0 16px' };

export async function organizationErasedEmail(
  props: OrganizationErasedEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.organizationErased',
  }) as T;
  const html = await render(<OrganizationErasedEmail {...props} t={t} />);
  return {
    subject: t('subject', values(props)),
    text: [
      t('greeting', values(props)),
      '',
      t('lede', values(props)),
      '',
      t('kept', values(props)),
      '',
      t('footer'),
      '',
      '— Motir',
    ].join('\n'),
    html,
  };
}

export default OrganizationErasedEmail;
