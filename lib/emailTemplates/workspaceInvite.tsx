import { Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { createTranslator } from 'next-intl';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import { getMessagesFor } from '@/lib/i18n/messages';
import { defaultLocale, type Locale } from '@/lib/i18n/locales';
import type { RenderedEmail } from './types';

// Workspace-invite email. Matches design/workspaces/invite-email-html.png.
// Per CLAUDE.md, templates are pure render functions: no sendEmail call, no DB
// access, no environment lookups. The service that composes this email decides
// the recipient + dispatches. Localized via next-intl's synchronous
// `createTranslator` (NOT getTranslations) because rendering runs inside the
// email.send background job, off any request scope. `locale` is optional and
// defaults to the base locale (e.g. unit tests that render without one).

// A minimal translator shape (satisfied by createTranslator's result).
type T = (key: string, values?: Record<string, string | number>) => string;

export interface WorkspaceInviteEmailProps {
  inviterName: string;
  workspaceName: string;
  acceptUrl: string;
  locale?: Locale;
}

function WorkspaceInviteEmail({
  inviterName,
  workspaceName,
  acceptUrl,
  t,
}: WorkspaceInviteEmailProps & { t: T }) {
  return (
    <EmailLayout
      preview={t('preview', { inviter: inviterName, workspace: workspaceName })}
      footer={`${t('expires')} ${t('ignore', { inviter: inviterName })}`}
    >
      <Text style={greeting}>{t('greeting')}</Text>
      <Text style={lede}>{t('lede', { inviter: inviterName, workspace: workspaceName })}</Text>
      <Section style={cta}>
        <PrimaryButton href={acceptUrl} label={t('accept')} />
      </Section>
      <Text style={fallbackLabel}>{t('fallback')}</Text>
      <Text style={fallbackLinkRow}>
        <Link href={acceptUrl} style={fallbackLink}>
          {acceptUrl}
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

/**
 * Public template entry point. Returns `{ subject, text, html }` for the service
 * to spread into `sendEmail(...)`. Async because `@react-email/render` returns a
 * Promise.
 */
export async function workspaceInviteEmail(
  props: WorkspaceInviteEmailProps,
): Promise<RenderedEmail> {
  const locale = props.locale ?? defaultLocale;
  const t = createTranslator({
    locale,
    messages: getMessagesFor(locale),
    namespace: 'email.invite',
  }) as T;
  const html = await render(<WorkspaceInviteEmail {...props} t={t} />);
  return {
    subject: t('subject', { workspace: props.workspaceName }),
    text: buildPlainText(props, t),
    html,
  };
}

function buildPlainText(props: WorkspaceInviteEmailProps, t: T): string {
  return [
    t('greeting'),
    '',
    t('lede', { inviter: props.inviterName, workspace: props.workspaceName }),
    '',
    `${t('accept')}: ${props.acceptUrl}`,
    '',
    t('expires'),
    '',
    t('ignore', { inviter: props.inviterName }),
    '',
    '— Prodect',
  ].join('\n');
}

// Default export is the React component itself — needed for react-email
// dev-mode previews when we adopt the `react-email dev` server later.
export default WorkspaceInviteEmail;
