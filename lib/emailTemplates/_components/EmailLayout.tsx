import { Body, Container, Head, Hr, Html, Img, Preview, Text } from '@react-email/components';
import type { ReactNode } from 'react';
import { BRAND_ACCENT_HEX, waveBandDataUri } from '@/components/brand/waveBand';

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

// The brand mark for email (design/brand/design-notes.md §7e). Email is a
// raster-and-tables world: Outlook's Word renderer drops inline <svg> entirely
// and Gmail strips <style>, so the mark ships as an <img> with a LITERAL colour
// and explicit width/height — never an inline <svg> element, never a CSS
// variable. `alt="Motir"` is not decoration: roughly 40% of clients block images
// by default, and the alt text is then the entire header.
//
// One colour for both themes. Email has no reliable dark-mode signal, and
// #5645d4 holds 6.57:1 on the white body this layout hardcodes (§4).
const BRAND_MARK_PX = 20;
const brandMarkSrc = waveBandDataUri({ size: BRAND_MARK_PX, fill: BRAND_ACCENT_HEX });

const brandMark = {
  display: 'inline-block',
  verticalAlign: 'middle',
  marginRight: '8px',
};

const brandName = {
  verticalAlign: 'middle',
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
          <Text style={brandRow}>
            <Img
              src={brandMarkSrc}
              width={BRAND_MARK_PX}
              height={BRAND_MARK_PX}
              alt="Motir"
              style={brandMark}
            />
            <span style={brandName}>Motir</span>
          </Text>
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
