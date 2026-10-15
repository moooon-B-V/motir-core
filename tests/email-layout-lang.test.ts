import { describe, expect, it } from 'vitest';
import { EMAIL_TEMPLATE_CLASS, type EmailTemplate } from '@/lib/services/emailService';
import { renderFixture } from './helpers/emailTemplateFixtures';

// Story MOTIR-7732 · MOTIR-8104 — every transactional email declares the
// language it is written in on <html lang>, from the recipient's locale, so a
// screen reader and a mail client's translate offer read it correctly. With no
// locale the email is English and says so.

const TEMPLATES = Object.keys(EMAIL_TEMPLATE_CLASS) as EmailTemplate[];

describe('<html lang> on every transactional email', () => {
  it.each(TEMPLATES)('%s declares the locale it is rendered in', async (template) => {
    const { html } = await renderFixture(template, { locale: 'de' });
    expect(html).toMatch(/<html[^>]*\blang="de-DE"/);
  });

  it.each(TEMPLATES)('%s declares English when no locale is given', async (template) => {
    const { html } = await renderFixture(template);
    expect(html).toMatch(/<html[^>]*\blang="en-US"/);
  });
});
