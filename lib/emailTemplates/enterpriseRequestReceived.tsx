import { Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type {
  EnterpriseAgentPathValue,
  EnterpriseAutonomyValue,
  EnterpriseStartWhenValue,
  EnterpriseTeamSizeValue,
} from '@/lib/dto/billing';
import type { RenderedEmail } from './types';

// An org asked for ENTERPRISE (Story MOTIR-7602 · Subtask MOTIR-7606). Sent to
// every platform staff member when the Contact-sales request commits: who asked,
// for which org, what they told us, and the one link that matters — the request
// in the operator console. Unanswered questions are left out rather than printed
// as blanks. No price, ever: the offer is private and lives outside the product.

type T = (key: string, values?: Record<string, string | number>) => string;

export interface EnterpriseRequestReceivedEmailProps {
  organizationName: string;
  requesterName: string;
  requesterEmail: string;
  cardsPerDay: number | null;
  parallelAgents: number | null;
  agentPath: EnterpriseAgentPathValue | null;
  autonomy: EnterpriseAutonomyValue | null;
  startWhen: EnterpriseStartWhenValue | null;
  teamSize: EnterpriseTeamSizeValue | null;
  contact: string;
  note: string;
  /** The finished console link, `<origin>/admin/enterprise-requests/<id>`. */
  requestUrl: string;
  locale?: Locale;
}

function values(p: EnterpriseRequestReceivedEmailProps) {
  return {
    organization: p.organizationName,
    requester: p.requesterName,
    email: p.requesterEmail,
    contact: p.contact,
  };
}

/** One line per answered question, in the form's order. */
function needLines(p: EnterpriseRequestReceivedEmailProps, t: T): string[] {
  const lines: string[] = [];
  if (p.cardsPerDay !== null) lines.push(t('cardsPerDay', { count: p.cardsPerDay }));
  if (p.parallelAgents !== null) lines.push(t('parallelAgents', { count: p.parallelAgents }));
  if (p.agentPath) lines.push(t('agentPath', { value: t(`agentPathValue.${p.agentPath}`) }));
  if (p.autonomy) lines.push(t('autonomy', { value: t(`autonomyValue.${p.autonomy}`) }));
  if (p.startWhen) lines.push(t('startWhen', { value: t(`startWhenValue.${p.startWhen}`) }));
  if (p.teamSize) lines.push(t('teamSize', { value: t(`teamSizeValue.${p.teamSize}`) }));
  return lines;
}

function EnterpriseRequestReceivedEmail(props: EnterpriseRequestReceivedEmailProps & { t: T }) {
  const { t } = props;
  const needs = needLines(props, t);
  return (
    <EmailLayout preview={t('preview', values(props))} footer={t('footer')}>
      <Text style={para}>{t('greeting')}</Text>
      <Text style={para}>{t('lede', values(props))}</Text>
      <Text style={heading}>{t('needsHeading')}</Text>
      {needs.length > 0 ? (
        needs.map((line) => (
          <Text key={line} style={item}>
            {line}
          </Text>
        ))
      ) : (
        <Text style={item}>{t('noNeeds')}</Text>
      )}
      <Text style={item}>{t('contact', values(props))}</Text>
      <Text style={heading}>{t('noteHeading')}</Text>
      <Text style={para}>{props.note}</Text>
      <PrimaryButton href={props.requestUrl} label={t('openRequest')} />
    </EmailLayout>
  );
}

const para = { fontSize: '16px', margin: '0 0 16px' };
const heading = { fontSize: '16px', fontWeight: 600, margin: '8px 0 8px' };
const item = { fontSize: '16px', margin: '0 0 4px' };

export async function enterpriseRequestReceivedEmail(
  props: EnterpriseRequestReceivedEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.enterpriseRequestReceived',
  }) as T;
  const html = await render(<EnterpriseRequestReceivedEmail {...props} t={t} />);
  const needs = needLines(props, t);
  return {
    subject: t('subject', values(props)),
    text: [
      t('greeting'),
      '',
      t('lede', values(props)),
      '',
      t('needsHeading'),
      ...(needs.length > 0 ? needs : [t('noNeeds')]),
      t('contact', values(props)),
      '',
      t('noteHeading'),
      props.note,
      '',
      `${t('openRequest')}: ${props.requestUrl}`,
      '',
      t('footer'),
      '',
      '— Motir',
    ].join('\n'),
    html,
  };
}

export default EnterpriseRequestReceivedEmail;
