import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { passwordResetEmail } from '@/lib/emailTemplates/passwordReset';
import {
  BRAND_ACCENT_HEX,
  BRAND_ACCENT_INK_HEX,
  BRAND_LINK_HEX,
} from '@/components/brand/waveBand';

// MOTIR-6474 — the transactional emails paint the Motir palette's brand colours
// (design/brand/design-notes.md §10, rows 12–13): the primary button is the ink
// `--el-accent` fill with its `--el-accent-text` label, and every body link is
// `--el-link`. Asserted on a RENDERED email, because the colours ship as inline
// styles a mail client reads — not on the style objects that produce them.

const TEMPLATES = join(process.cwd(), 'lib/emailTemplates');

describe('the rendered password-reset email', () => {
  it('paints the button and the link in the approved brand colours', async () => {
    const { html } = await passwordResetEmail({
      recipientName: 'Sam',
      resetUrl: 'https://app.example.test/reset-password?token=abc',
    });
    const css = html.toLowerCase();
    expect(css).toContain(`background-color:${BRAND_ACCENT_HEX}`);
    expect(css).toContain(`color:${BRAND_LINK_HEX}`);
    // The button's label colour sits beside its fill in the same style attribute.
    expect(css).toMatch(
      new RegExp(`background-color:${BRAND_ACCENT_HEX};color:${BRAND_ACCENT_INK_HEX}`),
    );
  });
});

describe('the old colours are gone from every template', () => {
  it('no template or shared component carries #4f46e5 or #2563eb', () => {
    const files = [
      ...readdirSync(TEMPLATES).filter((f) => f.endsWith('.tsx')),
      ...readdirSync(join(TEMPLATES, '_components')).map((f) => `_components/${f}`),
    ];
    const offenders = files.filter((f) =>
      /#4f46e5|#2563eb/i.test(readFileSync(join(TEMPLATES, f), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
