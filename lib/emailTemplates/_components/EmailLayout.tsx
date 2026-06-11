import { Body, Container, Head, Hr, Html, Preview, Text } from '@react-email/components';
import type { ReactNode } from 'react';

// Shared chrome for every Motir transactional email. Each template
// wraps its content in <EmailLayout preview="…">…</EmailLayout> so
// the outer styling (max-width, padding, header, footer divider,
// "— Motir" sign-off) stays consistent.
//
// `preview` is the inbox snippet text — the first thing users see in
// Gmail / Outlook list views. Always pass a one-line summary of the
// email's purpose; an empty preview lets the email client pick
// arbitrary leading body text which usually reads badly.

export interface EmailLayoutProps {
  preview: string;
  children: ReactNode;
  // The footer is rendered above the "— Motir" line. Templates that
  // need a per-email caveat ("This invite expires in 7 days." / "If
  // you didn't request this, you can ignore this email.") pass it
  // here; the line break + small grey treatment is consistent.
  footer?: ReactNode;
}

const main = {
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  backgroundColor: '#ffffff',
  margin: '0',
  padding: '0',
};

const container = {
  maxWidth: '560px',
  margin: '0 auto',
  padding: '24px',
};

const brandRow = {
  color: '#6b7280',
  fontSize: '14px',
  margin: '0 0 24px',
};

const divider = {
  borderColor: '#e5e7eb',
  borderStyle: 'solid',
  borderWidth: '1px 0 0',
  margin: '24px 0',
};

const footerText = {
  color: '#6b7280',
  fontSize: '14px',
  margin: '0 0 8px',
};

const signOff = {
  color: '#6b7280',
  fontSize: '14px',
  margin: '0',
};

export function EmailLayout({ preview, children, footer }: EmailLayoutProps) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Text style={brandRow}>Motir</Text>
          {children}
          {footer ? (
            <>
              <Hr style={divider} />
              <Text style={footerText}>{footer}</Text>
            </>
          ) : null}
          <Text style={signOff}>— Motir</Text>
        </Container>
      </Body>
    </Html>
  );
}
