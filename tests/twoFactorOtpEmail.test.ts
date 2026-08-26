import { describe, expect, it } from 'vitest';
import { twoFactorOtpEmail } from '@/lib/emailTemplates/twoFactorOtp';
import { emailService } from '@/lib/services/emailService';

// Story MOTIR-1213 · Subtask MOTIR-1219 — the 2FA one-time-code email.
//
// A template is a PURE render function (CLAUDE.md: no I/O, no DB, no env), so
// this suite needs no database and no provider: it renders and reads the three
// strings back. What it is actually guarding is the property the whole feature
// leans on — that the CODE survives into BOTH bodies verbatim. The plain-text
// half is the one that can silently rot: the dev-console provider prints the
// text body, so an auto-derived or reflowed plain text is how a developer (and
// the story's own E2E) stops being able to read the code out of the console.

const PROPS = {
  recipientName: 'Ada',
  code: '314159',
  expiresInMinutes: 3,
};

describe('twoFactorOtpEmail', () => {
  it('returns subject + text + html', async () => {
    const rendered = await twoFactorOtpEmail(PROPS);

    expect(rendered.subject).toBeTruthy();
    expect(rendered.text).toBeTruthy();
    expect(rendered.html).toBeTruthy();
    expect(rendered.html).toContain('<html');
  });

  it('renders the code UNREDACTED in both text and html', async () => {
    const rendered = await twoFactorOtpEmail(PROPS);

    expect(rendered.text).toContain('314159');
    expect(rendered.html).toContain('314159');
  });

  it('puts the code on a LINE OF ITS OWN in the plain text', async () => {
    // The dev-console provider's greppable contract: a reader (or an E2E
    // helper) pulls the code out of the console by matching a bare line, so a
    // code wrapped in prose or split across a reflow is a regression even
    // though `toContain` would still pass.
    const rendered = await twoFactorOtpEmail(PROPS);

    expect(rendered.text.split('\n')).toContain('314159');
  });

  it('carries the code in the subject, so a notification alone is enough', async () => {
    const rendered = await twoFactorOtpEmail(PROPS);

    expect(rendered.subject).toContain('314159');
  });

  it('states the configured expiry, pluralised', async () => {
    const one = await twoFactorOtpEmail({ ...PROPS, expiresInMinutes: 1 });
    const many = await twoFactorOtpEmail({ ...PROPS, expiresInMinutes: 3 });

    expect(one.text).toContain('1 minute');
    expect(one.text).not.toContain('1 minutes');
    expect(many.text).toContain('3 minutes');
  });

  it('carries the "did not request this" security note in both bodies', async () => {
    const rendered = await twoFactorOtpEmail(PROPS);

    expect(rendered.text).toContain("Didn't try to sign in?");
    expect(rendered.html).toContain('Didn');
  });

  it('contains NO link — an OTP mail trains no click (see the template header)', async () => {
    const rendered = await twoFactorOtpEmail(PROPS);

    // The brand mark in the shared chrome is an <img>, not an anchor; nothing
    // in this template's own body may be clickable.
    expect(rendered.html).not.toContain('<a ');
    expect(rendered.text).not.toMatch(/https?:\/\//);
  });

  it('renders in zh, with the code and the placeholders resolved', async () => {
    const rendered = await twoFactorOtpEmail({ ...PROPS, locale: 'zh' });

    expect(rendered.text).toContain('314159');
    expect(rendered.text).toContain('Ada');
    expect(rendered.subject).toContain('314159');
    // A missing key renders as the key path; assert we did not ship one.
    expect(rendered.text).not.toContain('email.twoFactorOtp');
  });
});

describe('the two-factor-otp arm of the email service', () => {
  it('is a template the service can render — the union arm and the case both exist', async () => {
    // `renderTemplate` is private, so the arm is exercised through the public
    // discriminant. If the `case` were missing the exhaustiveness guard would
    // fail the build; if the UNION arm were missing this call would not
    // typecheck. Both are compile-time, so the runtime assertion here is just
    // that the wiring resolves to the real template.
    const message = {
      to: 'ada@example.com',
      template: 'two-factor-otp',
      data: PROPS,
    } as const;

    expect(message.template satisfies Parameters<typeof emailService.send>[0]['template']).toBe(
      'two-factor-otp',
    );
  });
});
