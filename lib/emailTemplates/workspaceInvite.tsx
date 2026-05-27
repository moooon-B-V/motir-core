import { Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import type { RenderedEmail } from './types';

// Workspace-invite email. Matches design/workspaces/invite-email-html.png.
// Per CLAUDE.md, templates are pure render functions: no sendEmail
// call, no DB access, no environment lookups. The service that
// composes this email decides the recipient and dispatches.

export interface WorkspaceInviteEmailProps {
  inviterName: string;
  workspaceName: string;
  acceptUrl: string;
}

function WorkspaceInviteEmail({
  inviterName,
  workspaceName,
  acceptUrl,
}: WorkspaceInviteEmailProps) {
  return (
    <EmailLayout
      preview={`${inviterName} invited you to join ${workspaceName} on Prodect`}
      footer={`This invite expires in 7 days. Don't know ${inviterName}? You can safely ignore this email.`}
    >
      <Text style={greeting}>Hi,</Text>
      <Text style={lede}>
        {inviterName} invited you to join {workspaceName} on Prodect.
      </Text>
      <Section style={cta}>
        <PrimaryButton href={acceptUrl} label="Accept invite" />
      </Section>
      <Text style={fallbackLabel}>Or copy this link into your browser:</Text>
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
 * Public template entry point. Returns `{ subject, text, html }` for
 * the service to spread into `sendEmail(...)`. Async because
 * `@react-email/render` returns a Promise.
 */
export async function workspaceInviteEmail(
  props: WorkspaceInviteEmailProps,
): Promise<RenderedEmail> {
  const element = <WorkspaceInviteEmail {...props} />;
  const [html, _autoText] = await Promise.all([
    render(element),
    // Discard the auto-derived text — we hand-write it below so the
    // dev-console "link unredacted in plain text" contract is exact
    // and not subject to the renderer's tag-stripping heuristics.
    Promise.resolve(''),
  ]);
  return {
    subject: `You're invited to join ${props.workspaceName} on Prodect`,
    text: buildPlainText(props),
    html,
  };
}

function buildPlainText({
  inviterName,
  workspaceName,
  acceptUrl,
}: WorkspaceInviteEmailProps): string {
  return [
    'Hi,',
    '',
    `${inviterName} invited you to join ${workspaceName} on Prodect.`,
    '',
    `Accept invite: ${acceptUrl}`,
    '',
    'This invite expires in 7 days.',
    '',
    `Don't know ${inviterName}? You can safely ignore this email.`,
    '',
    '— Prodect',
  ].join('\n');
}

// Default export is the React component itself — needed for react-email
// dev-mode previews when we adopt the `react-email dev` server later.
export default WorkspaceInviteEmail;
