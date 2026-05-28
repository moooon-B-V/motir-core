import { Button } from '@react-email/components';

// Indigo CTA button. Match the design-system primary action color
// (currently #4f46e5 — indigo-600). When the design system gets a
// proper "email primary" token, swap the hard-coded hex here.

const button = {
  display: 'block',
  width: '100%',
  backgroundColor: '#4f46e5',
  color: '#ffffff',
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
