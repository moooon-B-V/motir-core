import { Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// An organisation's AI plan ended, so its agents will be deleted (Story MOTIR-6914 ·
// MOTIR-6921; `docs/decisions/agent-instance-storage.md` §4). Sent ONCE to each
// agent's owner, naming their own agents and the date, with the way to stop it:
// renewing the plan on Billing & plans. Localized via next-intl's synchronous
// `createTranslator` (rendering runs off-request, in the `email.send` job).
// Mirrors `organizationDeletionScheduled.tsx`.

type T = (key: string, values?: Record<string, string | number>) => string;

export interface AgentsDeletionScheduledEmailProps {
  recipientName: string;
  organizationName: string;
  /** The deletion date, already formatted for the reader (UTC). */
  deletionDate: string;
  /** The owner's own agents in this organisation, by name. */
  agentNames: string[];
  /** Billing & plans — where the plan is renewed. */
  billingUrl: string;
  locale?: Locale;
}

function values(p: AgentsDeletionScheduledEmailProps) {
  return {
    name: p.recipientName,
    organization: p.organizationName,
    date: p.deletionDate,
    count: p.agentNames.length,
  };
}

function AgentsDeletionScheduledEmail(props: AgentsDeletionScheduledEmailProps & { t: T }) {
  const { t } = props;
  return (
    <EmailLayout preview={t('preview', values(props))} footer={t('footer')}>
      <Text style={para}>{t('greeting', values(props))}</Text>
      <Text style={para}>{t('lede', values(props))}</Text>
      <Text style={para}>{t('agents', values(props))}</Text>
      <Text style={list}>{props.agentNames.join(', ')}</Text>
      <Text style={para}>{t('renew', values(props))}</Text>
      <Section style={cta}>
        <PrimaryButton href={props.billingUrl} label={t('openBilling')} />
      </Section>
    </EmailLayout>
  );
}

const para = { fontSize: '16px', margin: '0 0 16px' };
const list = { fontSize: '16px', margin: '0 0 16px', fontWeight: 600 };
const cta = { margin: '8px 0 24px' };

export async function agentsDeletionScheduledEmail(
  props: AgentsDeletionScheduledEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.agentsDeletionScheduled',
  }) as T;
  const html = await render(<AgentsDeletionScheduledEmail {...props} t={t} />);
  return { subject: t('subject', values(props)), text: buildPlainText(props, t), html };
}

function buildPlainText(props: AgentsDeletionScheduledEmailProps, t: T): string {
  return [
    t('greeting', values(props)),
    '',
    t('lede', values(props)),
    '',
    t('agents', values(props)),
    props.agentNames.map((n) => `- ${n}`).join('\n'),
    '',
    t('renew', values(props)),
    '',
    `${t('openBilling')}: ${props.billingUrl}`,
    '',
    t('footer'),
    '',
    '— Motir',
  ].join('\n');
}

export default AgentsDeletionScheduledEmail;
