import { Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// The weekly follower DIGEST (Story 8.9 · Subtask 8.9.7 ·
// `docs/decisions/public-follow-and-changelog.md` §4).
//
// ⚠️ IT IS NEVER RENDERED EMPTY. The service does not call this template when a
// project shipped nothing in the window — silence is information, and an
// "0 items shipped this week" mail is the thing that trains people to filter
// you. There is deliberately no empty state here to fall back on.
//
// It carries the `List-Unsubscribe` pair in `headers`, which is what lets a
// mail client draw its own unsubscribe button. For a bulk send that is not a
// nicety: it is the difference between somebody unsubscribing and somebody
// reporting the mail as spam, and the second costs the sending domain.

type T = (key: string, values?: Record<string, string | number>) => string;

export interface FollowDigestEntry {
  identifier: string;
  title: string;
  url: string;
}

export interface FollowDigestEmailProps {
  projectName: string;
  changelogUrl: string;
  unsubscribeUrl: string;
  entries: FollowDigestEntry[];
  locale?: Locale;
}

function FollowDigestEmail({
  projectName,
  changelogUrl,
  unsubscribeUrl,
  entries,
  t,
}: FollowDigestEmailProps & { t: T }) {
  return (
    <EmailLayout
      preview={t('preview', { project: projectName, count: entries.length })}
      footer={t('why')}
    >
      <Text style={lede}>{t('lede', { project: projectName, count: entries.length })}</Text>
      <Section style={list}>
        {entries.map((entry) => (
          <Text key={entry.identifier} style={row}>
            <Link href={entry.url} style={rowLink}>
              {entry.title}
            </Link>
          </Text>
        ))}
      </Section>
      <Section style={cta}>
        <PrimaryButton href={changelogUrl} label={t('viewAll')} />
      </Section>
      <Text style={unsubRow}>
        <Link href={unsubscribeUrl} style={unsubLink}>
          {t('unsubscribe')}
        </Link>
      </Text>
    </EmailLayout>
  );
}

const lede = { fontSize: '16px', margin: '0 0 20px' };
const list = { margin: '0 0 24px' };
const row = { fontSize: '15px', margin: '0 0 10px' };
const rowLink = { color: '#2563eb', textDecoration: 'none' };
const cta = { margin: '0 0 24px' };
const unsubRow = { fontSize: '13px', color: '#6b7280', margin: '0' };
const unsubLink = { color: '#6b7280' };

export async function followDigestEmail(props: FollowDigestEmailProps): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.followDigest',
  }) as T;
  const html = await render(<FollowDigestEmail {...props} t={t} />);
  return {
    subject: t('subject', { project: props.projectName, count: props.entries.length }),
    text: buildPlainText(props, t),
    html,
    // RFC 8058: the POST form is what makes a client's button ONE click rather
    // than a mailto the person has to send. Both headers are required for it —
    // a `List-Unsubscribe` without the `-Post` companion still renders a link,
    // but the client asks the reader to confirm by email.
    headers: {
      'List-Unsubscribe': `<${props.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

function buildPlainText(props: FollowDigestEmailProps, t: T): string {
  return [
    t('lede', { project: props.projectName, count: props.entries.length }),
    '',
    ...props.entries.map((e) => `- ${e.title}\n  ${e.url}`),
    '',
    `${t('viewAll')}: ${props.changelogUrl}`,
    '',
    `${t('unsubscribe')}: ${props.unsubscribeUrl}`,
    '',
    '— Motir',
  ].join('\n');
}

export default FollowDigestEmail;
