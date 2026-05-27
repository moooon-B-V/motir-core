import { Link, Section, Text } from '@react-email/components';
import { render } from '@react-email/render';
import { EmailLayout } from './_components/EmailLayout';
import { PrimaryButton } from './_components/PrimaryButton';
import type { RenderedEmail } from './types';

// Password-reset email. Wired into Better-Auth's
// emailAndPassword.sendResetPassword in lib/auth/index.ts. The 1-hour
// expiry copy here MUST match the resetPasswordTokenExpiresIn config
// — if you change one, change the other.

export interface PasswordResetEmailProps {
  recipientName: string;
  resetUrl: string;
}

function PasswordResetEmail({ recipientName, resetUrl }: PasswordResetEmailProps) {
  return (
    <EmailLayout
      preview="Reset your Prodect password"
      footer="This link expires in 1 hour. If you didn't request this, you can ignore this email."
    >
      <Text style={greeting}>Hi {recipientName},</Text>
      <Text style={lede}>We received a request to reset your Prodect password.</Text>
      <Section style={cta}>
        <PrimaryButton href={resetUrl} label="Reset your password" />
      </Section>
      <Text style={fallbackLabel}>Or copy this link into your browser:</Text>
      <Text style={fallbackLinkRow}>
        <Link href={resetUrl} style={fallbackLink}>
          {resetUrl}
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

export async function passwordResetEmail(props: PasswordResetEmailProps): Promise<RenderedEmail> {
  const html = await render(<PasswordResetEmail {...props} />);
  return {
    subject: 'Reset your Prodect password',
    text: buildPlainText(props),
    html,
  };
}

function buildPlainText({ recipientName, resetUrl }: PasswordResetEmailProps): string {
  return [
    `Hi ${recipientName},`,
    '',
    'We received a request to reset your Prodect password.',
    '',
    `Reset link: ${resetUrl}`,
    '',
    "This link expires in 1 hour. If you didn't request this, you can ignore this email.",
    '',
    '— Prodect',
  ].join('\n');
}

export default PasswordResetEmail;
