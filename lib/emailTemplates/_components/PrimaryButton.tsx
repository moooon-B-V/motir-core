import { Button } from '@react-email/components';
import { EMAIL_BUTTON_BG, EMAIL_BUTTON_INK } from './emailColors';

// The primary CTA: the Motir palette's ink fill with its white label — the app's
// own primary button, baked for email (design/brand/design-notes.md §10).

const button = {
  display: 'block',
  width: '100%',
  backgroundColor: EMAIL_BUTTON_BG,
  color: EMAIL_BUTTON_INK,
  fontWeight: 600,
  fontSize: '16px',
  textDecoration: 'none',
  padding: '14px 20px',
  borderRadius: '8px',
  textAlign: 'center' as const,
  boxSizing: 'border-box' as const,
};

export interface PrimaryButtonProps {
  href: string;
  label: string;
}

export function PrimaryButton({ href, label }: PrimaryButtonProps) {
  return (
    <Button href={href} style={button}>
      {label}
    </Button>
  );
}
