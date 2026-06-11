import { Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// Mention notification email (Story 5.1 · Subtask 5.1.6). Sent by the
// `email.send` job when someone @-mentions a user in a comment or in a work
// item's description; the mentionNotify fan-out (lib/jobs/definitions/
// mentionNotify.ts) composes the props. Pure template per CLAUDE.md: no I/O,
// no env reads — `issueUrl` arrives fully built, the `excerpt` is already
// plain text (mention tokens rendered as @Name via lib/mentions/excerpt.ts).
// Localized via next-intl's synchronous createTranslator (rendering runs
// off-request, in the email.send job); `locale` defaults to the base locale —
// there is no persisted per-user locale yet (the same signal gap the invite
// email documents), so senders currently omit it.

// A minimal translator shape (satisfied by createTranslator's result).
type T = (key: string, values?: Record<string, string | number>) => string;

export interface MentionNotificationEmailProps {
  recipientName: string;
  authorName: string;
  /** The work item's system identifier, e.g. "PROD-42". */
  workItemIdentifier: string;
  workItemTitle: string;
  /** Where the mention sits — picks the lede copy. */
  source: 'comment' | 'description';
  /** Plain-text excerpt of the mentioning body; null hides the quote block. */
  excerpt: string | null;
  /** The fully-built deep link to the work item. */
  issueUrl: string;
  locale?: Locale;
}

function MentionNotificationEmail(p: MentionNotificationEmailProps & { t: T }) {
  const { t } = p;
  const ledeKey = p.source === 'comment' ? 'ledeComment' : 'ledeDescription';
  return (
    <EmailLayout preview={t('preview', { author: p.authorName, identifier: p.workItemIdentifier })}>
      <Text style={greeting}>{t('greeting', { name: p.recipientName })}</Text>
      <Text style={lede}>
        {t(ledeKey, {
          author: p.authorName,
          identifier: p.workItemIdentifier,
          title: p.workItemTitle,
        })}
      </Text>
      {p.excerpt ? <Text style={quote}>{p.excerpt}</Text> : null}
      <Section style={cta}>
        <PrimaryButton href={p.issueUrl} label={t('view')} />
      </Section>
      <Text style={fallbackLabel}>{t('fallback')}</Text>
      <Text style={fallbackLinkRow}>
        <Link href={p.issueUrl} style={fallbackLink}>
          {p.issueUrl}
        </Link>
      </Text>
    </EmailLayout>
  );
}

const greeting = { fontSize: '16px', margin: '0 0 16px' };
const lede = { fontSize: '16px', margin: '0 0 16px' };
const quote = {
  borderLeft: '3px solid #e5e7eb',
  color: '#4b5563',
  fontSize: '14px',
  margin: '0 0 24px',
  padding: '4px 0 4px 12px',
};
const cta = { margin: '0 0 24px' };
const fallbackLabel = { color: '#6b7280', fontSize: '14px', margin: '0 0 8px' };
const fallbackLinkRow = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: '13px',
  margin: '0 0 24px',
};
const fallbackLink = { color: '#2563eb', wordBreak: 'break-all' as const };

export async function mentionNotificationEmail(
  props: MentionNotificationEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.mentionNotification',
  }) as T;
  const html = await render(<MentionNotificationEmail {...props} t={t} />);
  return {
    subject: t('subject', {
      author: props.authorName,
      identifier: props.workItemIdentifier,
      title: props.workItemTitle,
    }),
    text: buildPlainText(props, t),
    html,
  };
}

function buildPlainText(p: MentionNotificationEmailProps, t: T): string {
  const ledeKey = p.source === 'comment' ? 'ledeComment' : 'ledeDescription';
  return [
    t('greeting', { name: p.recipientName }),
    '',
    t(ledeKey, { author: p.authorName, identifier: p.workItemIdentifier, title: p.workItemTitle }),
    ...(p.excerpt ? ['', p.excerpt] : []),
    '',
    // Hand-written plain text with the link UNREDACTED (the 1.1.6 dev-console
    // grep contract — never auto-derived `label (url)` form).
    `${t('view')}: ${p.issueUrl}`,
    '',
    '— Motir',
  ].join('\n');
}

export default MentionNotificationEmail;
