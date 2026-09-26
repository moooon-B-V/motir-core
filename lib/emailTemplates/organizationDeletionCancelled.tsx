import { Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// A scheduled organization deletion was CANCELLED (Story MOTIR-6306 · MOTIR-6395;
// `docs/decisions/organization-deletion.md` §4, §8). Sent to every member, the same
// audience the scheduled notice reached, so nobody is left believing their work is
// about to vanish.

type T = (key: string, values?: Record<string, string | number>) => string;

export interface OrganizationDeletionCancelledEmailProps {
  recipientName: string;
  organizationName: string;
  cancelledByName: string;
  /** Where to go back to work. */
  appUrl: string;
  locale?: Locale;
}

function values(p: OrganizationDeletionCancelledEmailProps) {
  return {
    name: p.recipientName,
    organization: p.organizationName,
    cancelledBy: p.cancelledByName,
  };
}

function OrganizationDeletionCancelledEmail(
  props: OrganizationDeletionCancelledEmailProps & { t: T },
) {
  const { t } = props;
  return (
    <EmailLayout preview={t('preview', values(props))} footer={t('footer')}>
      <Text style={para}>{t('greeting', values(props))}</Text>
      <Text style={para}>{t('lede', values(props))}</Text>
      <Text style={para}>{t('detail')}</Text>
      <Section style={cta}>
        <PrimaryButton href={props.appUrl} label={t('open')} />
      </Section>
    </EmailLayout>
  );
}

const para = { fontSize: '16px', margin: '0 0 16px' };
const cta = { margin: '8px 0 24px' };

export async function organizationDeletionCancelledEmail(
  props: OrganizationDeletionCancelledEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.organizationDeletionCancelled',
  }) as T;
  const html = await render(<OrganizationDeletionCancelledEmail {...props} t={t} />);
  return {
    subject: t('subject', values(props)),
    text: [
      t('greeting', values(props)),
      '',
      t('lede', values(props)),
      '',
      t('detail'),
      '',
      `${t('open')}: ${props.appUrl}`,
      '',
      t('footer'),
      '',
      '— Motir',
    ].join('\n'),
    html,
  };
}

export default OrganizationDeletionCancelledEmail;
