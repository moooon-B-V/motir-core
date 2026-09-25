import { Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// Ownership of an organization has changed hands (Story MOTIR-6167 · Subtask
// MOTIR-6310). Sent to BOTH people after the transfer commits — the one who is
// now the Owner and the one who is now an Admin — because the transfer is the
// one write that changes who controls the organization, and neither side
// should learn of it by noticing a missing button.
//
// One template, two arms (`audience`): the facts are the same, the sentence a
// person needs is different. Localized via next-intl's synchronous
// `createTranslator` (rendering runs off-request, in the `email.send` job);
// `locale` defaults to the base locale when absent. Mirrors `dataExportReady.tsx`.

// A minimal translator shape (satisfied by createTranslator's result).
type T = (key: string, values?: Record<string, string | number>) => string;

export interface OwnershipTransferredEmailProps {
  /** Which side of the transfer the recipient is on. */
  audience: 'new-owner' | 'previous-owner';
  recipientName: string;
  organizationName: string;
  previousOwnerName: string;
  newOwnerName: string;
  /** The organization settings page. */
  settingsUrl: string;
  locale?: Locale;
}

function values(p: OwnershipTransferredEmailProps) {
  return {
    name: p.recipientName,
    organization: p.organizationName,
    previousOwner: p.previousOwnerName,
    newOwner: p.newOwnerName,
  };
}

function lede(p: OwnershipTransferredEmailProps, t: T): string {
  return p.audience === 'new-owner'
    ? t('ledeNewOwner', values(p))
    : t('ledePreviousOwner', values(p));
}

function detail(p: OwnershipTransferredEmailProps, t: T): string {
  return p.audience === 'new-owner' ? t('detailNewOwner') : t('detailPreviousOwner');
}

function OwnershipTransferredEmail(props: OwnershipTransferredEmailProps & { t: T }) {
  const { t } = props;
  return (
    <EmailLayout preview={t('preview', values(props))} footer={t('notYou')}>
      <Text style={greeting}>{t('greeting', values(props))}</Text>
      <Text style={ledeStyle}>{lede(props, t)}</Text>
      <Text style={ledeStyle}>{detail(props, t)}</Text>
      <Section style={cta}>
        <PrimaryButton href={props.settingsUrl} label={t('open')} />
      </Section>
    </EmailLayout>
  );
}

const greeting = { fontSize: '16px', margin: '0 0 16px' };
const ledeStyle = { fontSize: '16px', margin: '0 0 16px' };
const cta = { margin: '8px 0 24px' };

export async function ownershipTransferredEmail(
  props: OwnershipTransferredEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.ownershipTransferred',
  }) as T;
  const html = await render(<OwnershipTransferredEmail {...props} t={t} />);
  return {
    subject: t('subject', values(props)),
    text: buildPlainText(props, t),
    html,
  };
}

function buildPlainText(props: OwnershipTransferredEmailProps, t: T): string {
  return [
    t('greeting', values(props)),
    '',
    lede(props, t),
    '',
    detail(props, t),
    '',
    `${t('open')}: ${props.settingsUrl}`,
    '',
    t('notYou'),
    '',
    '— Motir',
  ].join('\n');
}

export default OwnershipTransferredEmail;
