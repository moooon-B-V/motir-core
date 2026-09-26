import { Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// An organization has been SCHEDULED for deletion (Story MOTIR-6306 · MOTIR-6395;
// `docs/decisions/organization-deletion.md` §8). Sent to EVERY member — Owner,
// Admins and Members — because members lose their work too.
//
// Two arms (`audience`): the Owner can cancel, so their copy links to the org
// settings; everyone else is told who can, and pointed at their own export.
// Localized via next-intl's synchronous `createTranslator` (rendering runs
// off-request, in the `email.send` job). Mirrors `ownershipTransferred.tsx`.

type T = (key: string, values?: Record<string, string | number>) => string;

export interface OrganizationDeletionScheduledEmailProps {
  audience: 'owner' | 'member';
  recipientName: string;
  organizationName: string;
  /** Who scheduled it (the Owner). */
  scheduledByName: string;
  /** The erasure date, already formatted for the reader. */
  dueDate: string;
  /** The organization settings page — where the Owner cancels. */
  settingsUrl: string;
  /** The reader's personal-data export pane. */
  exportUrl: string;
  locale?: Locale;
}

function values(p: OrganizationDeletionScheduledEmailProps) {
  return {
    name: p.recipientName,
    organization: p.organizationName,
    scheduledBy: p.scheduledByName,
    date: p.dueDate,
  };
}

function lede(p: OrganizationDeletionScheduledEmailProps, t: T): string {
  return p.audience === 'owner' ? t('ledeOwner', values(p)) : t('ledeMember', values(p));
}

function nextStep(p: OrganizationDeletionScheduledEmailProps, t: T): string {
  return p.audience === 'owner' ? t('cancelOwner') : t('cancelMember', values(p));
}

function OrganizationDeletionScheduledEmail(
  props: OrganizationDeletionScheduledEmailProps & { t: T },
) {
  const { t } = props;
  return (
    <EmailLayout preview={t('preview', values(props))} footer={t('footer')}>
      <Text style={greeting}>{t('greeting', values(props))}</Text>
      <Text style={para}>{lede(props, t)}</Text>
      <Text style={para}>{t('readOnly')}</Text>
      <Text style={para}>{nextStep(props, t)}</Text>
      <Section style={cta}>
        {props.audience === 'owner' ? (
          <PrimaryButton href={props.settingsUrl} label={t('openSettings')} />
        ) : (
          <PrimaryButton href={props.exportUrl} label={t('downloadData')} />
        )}
      </Section>
    </EmailLayout>
  );
}

const greeting = { fontSize: '16px', margin: '0 0 16px' };
const para = { fontSize: '16px', margin: '0 0 16px' };
const cta = { margin: '8px 0 24px' };

export async function organizationDeletionScheduledEmail(
  props: OrganizationDeletionScheduledEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.organizationDeletionScheduled',
  }) as T;
  const html = await render(<OrganizationDeletionScheduledEmail {...props} t={t} />);
  return { subject: t('subject', values(props)), text: buildPlainText(props, t), html };
}

function buildPlainText(props: OrganizationDeletionScheduledEmailProps, t: T): string {
  const link =
    props.audience === 'owner'
      ? `${t('openSettings')}: ${props.settingsUrl}`
      : `${t('downloadData')}: ${props.exportUrl}`;
  return [
    t('greeting', values(props)),
    '',
    lede(props, t),
    '',
    t('readOnly'),
    '',
    nextStep(props, t),
    '',
    link,
    '',
    t('footer'),
    '',
    '— Motir',
  ].join('\n');
}

export default OrganizationDeletionScheduledEmail;
