import { Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// A REMINDER that a scheduled organization deletion is close (Story MOTIR-6306 ·
// MOTIR-6395; `docs/decisions/organization-deletion.md` §8): 7 days and 1 day
// before the due date, to the Owner and the Admins — the people who can stop it
// or ask the one who can. One template; `daysLeft` carries which reminder it is.

type T = (key: string, values?: Record<string, string | number>) => string;

export interface OrganizationDeletionReminderEmailProps {
  audience: 'owner' | 'admin';
  recipientName: string;
  organizationName: string;
  ownerName: string;
  dueDate: string;
  daysLeft: number;
  settingsUrl: string;
  locale?: Locale;
}

function values(p: OrganizationDeletionReminderEmailProps) {
  return {
    name: p.recipientName,
    organization: p.organizationName,
    owner: p.ownerName,
    date: p.dueDate,
    daysLeft: p.daysLeft,
  };
}

function who(p: OrganizationDeletionReminderEmailProps, t: T): string {
  return p.audience === 'owner' ? t('cancelOwner') : t('cancelAdmin', values(p));
}

function OrganizationDeletionReminderEmail(
  props: OrganizationDeletionReminderEmailProps & { t: T },
) {
  const { t } = props;
  return (
    <EmailLayout preview={t('preview', values(props))} footer={t('footer')}>
      <Text style={para}>{t('greeting', values(props))}</Text>
      <Text style={para}>{t('lede', values(props))}</Text>
      <Text style={para}>{who(props, t)}</Text>
      <Section style={cta}>
        <PrimaryButton href={props.settingsUrl} label={t('openSettings')} />
      </Section>
    </EmailLayout>
  );
}

const para = { fontSize: '16px', margin: '0 0 16px' };
const cta = { margin: '8px 0 24px' };

export async function organizationDeletionReminderEmail(
  props: OrganizationDeletionReminderEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.organizationDeletionReminder',
  }) as T;
  const html = await render(<OrganizationDeletionReminderEmail {...props} t={t} />);
  return {
    subject: t('subject', values(props)),
    text: [
      t('greeting', values(props)),
      '',
      t('lede', values(props)),
      '',
      who(props, t),
      '',
      `${t('openSettings')}: ${props.settingsUrl}`,
      '',
      t('footer'),
      '',
      '— Motir',
    ].join('\n'),
    html,
  };
}

export default OrganizationDeletionReminderEmail;
