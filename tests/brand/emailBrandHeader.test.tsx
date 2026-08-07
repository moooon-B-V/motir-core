import { render as renderEmail } from '@react-email/render';
import { describe, expect, it } from 'vitest';
import { EmailLayout } from '@/lib/emailTemplates/_components/EmailLayout';
import { BRAND_ACCENT_HEX, WAVE_BAND_PATH } from '@/components/brand/waveBand';

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

async function html(): Promise<string> {
  return renderEmail(<EmailLayout preview="preview">body</EmailLayout>);
}

/** The mark's `src`, percent-decoded. Decoding the whole document instead would
 *  throw on the first unrelated `%` in it. */
async function markSource(): Promise<string> {
  const out = await html();
  return decodeURIComponent(out.match(/<img[^>]*src="([^"]+)"/)![1]!);
}

describe('the email brand header (§7e)', () => {
  it('renders the mark as an <img>, never an inline <svg> element', async () => {
    const out = await html();
    expect(out).toContain('<img');
    expect(out).not.toContain('<svg');
  });

  it('bakes a literal #5645d4 in — currentColor would resolve to black here', async () => {
    const src = await markSource();
    expect(src).toContain(`fill="${BRAND_ACCENT_HEX}"`);
    expect(src).toContain(WAVE_BAND_PATH);
    expect(await html()).not.toContain('currentColor');
  });

  it('never reaches for a CSS variable, which Gmail would strip', async () => {
    expect(await html()).not.toContain('var(--');
  });

  it('gives the image explicit width, height and alt="Motir"', async () => {
    // The alt is not decoration: with images blocked it is the ENTIRE header,
    // which is also why §8 files this slot as informative rather than decorative.
    const out = await html();
    const img = out.match(/<img[^>]*>/)![0];
    expect(img).toMatch(/width="20"/);
    expect(img).toMatch(/height="20"/);
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
