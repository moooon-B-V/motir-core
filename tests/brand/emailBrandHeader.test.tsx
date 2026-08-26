import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { render as renderEmail } from '@react-email/render';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmailLayout } from '@/lib/emailTemplates/_components/EmailLayout';
import { EMAIL_MARK_FILE, EMAIL_MARK_PATH, EMAIL_MARK_PX } from '@/components/brand/waveBand';

// MOTIR-1150 — the mark in transactional email (design/brand/design-notes.md
// §7e). Email is the one surface where every rule the rest of the app follows is
// inverted, and each inversion has a client that punishes getting it wrong:
//
//   inline <svg>   → Outlook's Word renderer drops it entirely
//   a CSS variable → Gmail strips <style>, so it resolves to nothing
//   currentColor   → outside the CSS tree it resolves to BLACK
//   no alt text    → ~40% of clients block images, and the alt IS the header
//
// None of those fail loudly in a test that only checks "an image is present", so
// each is asserted by name.
//
// ── MOTIR-3505 — and neither did the one that was actually broken ───────────
// Every assertion above passed for months while the mark rendered for NOBODY.
// The `src` was a `data:image/svg+xml` URI: SVG, which Gmail / Outlook / Yahoo
// render in email in no transport at all, delivered over `data:`, which Gmail's
// image proxy cannot fetch and therefore drops. The header degraded to its alt
// text for 100% of recipients rather than the 40% the comment above budgets for,
// which is exactly why it shipped unnoticed.
//
// The gap was not that a rendering test was missing — one was here, and it read
// the `src` — it is that it asserted what the src DREW and never what it WAS. So
// the `describe` below asserts the TRANSPORT and the FORMAT, by name, and the
// two live at the same altitude as the drawing assertions rather than under them.

const PROD_ORIGIN = 'https://app.motir.co';

async function html(): Promise<string> {
  return renderEmail(<EmailLayout preview="preview">body</EmailLayout>);
}

/** The mark's `src`, exactly as a mail client would receive it. */
async function markSource(): Promise<string> {
  const out = await html();
  return out.match(/<img[^>]*src="([^"]+)"/)![1]!;
}

describe('the email brand header (§7e)', () => {
  const previous = process.env['MOTIR_BASE_URL'];

  beforeEach(() => {
    // The layout absolutises the mark against the app's own origin, so the value
    // under test is the one a DEPLOYED Motir emits. With the variable unset
    // `resolveBaseUrl()` answers http://localhost:3000 — correct for local
    // development, and not what a recipient is ever sent.
    process.env['MOTIR_BASE_URL'] = PROD_ORIGIN;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env['MOTIR_BASE_URL'];
    else process.env['MOTIR_BASE_URL'] = previous;
  });

  it('renders the mark as an <img>, never an inline <svg> element', async () => {
    const out = await html();
    expect(out).toContain('<img');
    expect(out).not.toContain('<svg');
  });

  it('never reaches for a CSS variable, which Gmail would strip', async () => {
    expect(await html()).not.toContain('var(--');
  });

  it('gives the image explicit width, height and alt="Motir"', async () => {
    // The alt is not decoration: with images blocked it is the ENTIRE header,
    // which is also why §8 files this slot as informative rather than decorative.
    const out = await html();
    const img = out.match(/<img[^>]*>/)![0];
    expect(img).toMatch(new RegExp(`width="${EMAIL_MARK_PX}"`));
    expect(img).toMatch(new RegExp(`height="${EMAIL_MARK_PX}"`));
    expect(img).toMatch(/alt="Motir"/);
  });

  it('keeps the visible wordmark and the "— Motir" sign-off intact', async () => {
    // The chrome around the mark is unchanged: this card added a glyph to the
    // header, it did not redesign the layout.
    const out = await html();
    expect(out).toContain('Motir');
    expect(out).toContain('— Motir');
  });
});

describe('the mark’s TRANSPORT and FORMAT (MOTIR-3505)', () => {
  const previous = process.env['MOTIR_BASE_URL'];

  beforeEach(() => {
    process.env['MOTIR_BASE_URL'] = PROD_ORIGIN;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env['MOTIR_BASE_URL'];
    else process.env['MOTIR_BASE_URL'] = previous;
  });

  it('serves the mark over https://, so Gmail’s proxy has something to FETCH', async () => {
    // THE GUARD. Gmail rewrites every image through googleusercontent.com and
    // drops any source it cannot fetch, so the transport is not a detail of the
    // URL — it is whether the header exists.
    const src = await markSource();
    expect(src.startsWith('https://')).toBe(true);
  });

  it('is never a data: URI, in any casing', async () => {
    const src = await markSource();
    expect(src.toLowerCase()).not.toContain('data:');
  });

  it('is never a relative path — an email has no base URL to resolve against', async () => {
    // The failure mode this one guards is subtler than the data URI: a
    // root-relative `/email-mark-40.png` looks correct in a rendering harness,
    // which has a document, and resolves against nothing in a mail client.
    const src = await markSource();
    expect(src.startsWith('/')).toBe(false);
    expect(src).toBe(`${PROD_ORIGIN}${EMAIL_MARK_PATH}`);
  });

  it('points at a RASTER, and at one this repository actually ships', async () => {
    // The transport is only half of it: a hosted .svg would pass every assertion
    // above and still render in none of Gmail, Outlook or Yahoo. And a src that
    // is absolute, https and a PNG is still nothing if no file answers it — the
    // 404 is invisible from inside a render.
    const src = await markSource();
    expect(src.endsWith('.png')).toBe(true);
    expect(src).not.toContain('.svg');
    expect(existsSync(join(process.cwd(), 'public', EMAIL_MARK_FILE))).toBe(true);
  });

  it('absolutises against the CONFIGURED origin, not a hardcoded one', async () => {
    // A self-hosted Motir serves its own mark from its own origin. Hardcoding
    // app.motir.co would point every self-host deployment's email at a host it
    // does not control — so the guard is that the origin TRACKS MOTIR_BASE_URL,
    // not that it equals any particular value.
    process.env['MOTIR_BASE_URL'] = 'https://motir.internal.example/';
    expect(await markSource()).toBe(`https://motir.internal.example${EMAIL_MARK_PATH}`);
  });
});
