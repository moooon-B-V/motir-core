import { ImageResponse } from 'next/og';
import { loadOgFonts, OG_FONT_FAMILY } from '@/app/_brand/ogFonts';
import { BRAND_ACCENT_HEX, WAVE_BAND_PATH, WAVE_BAND_VIEW_BOX } from '@/components/brand/waveBand';

// The generated OpenGraph share card for the project square (Story 6.13 ·
// Subtask 6.13.6 · design Panel 4 — social/share image). A branded card: the
// Motir lockup + the square headline + a one-line lede. Rendered server-side via
// next/og. Inline hex is required here — this is an isolated raster surface
// OUTSIDE the React/CSS token tree (ImageResponse can't read CSS vars), the one
// place the --el-* rule doesn't reach (same posture as the project OG image).
// Each literal below names the token it came from; that provenance is the thing
// to keep in sync.
//
// MOTIR-1150 · design/brand/design-notes.md §6 changed TWO things here:
//
//   1. The 72px purple tile bearing the letter M is gone — it was a stand-in for
//      a mark that did not exist yet. It is now the real wave band at the same
//      72px, painted #5645d4 (--color-primary), with the wordmark beside it.
//   2. The card is set in INTER, passed through `fonts`. It said 'sans-serif'
//      before, which in a raster surface with no CSS tree means "whatever the
//      build container ships" — so the card and the site it advertises were set
//      in different faces.
//
// This is the SECTION layout: brand lockup top-left, headline and lede anchoring
// the bottom. The project card (`p/[identifier]`) is deliberately a different
// layout, not this one parameterised — there the project is the subject, so it
// keeps its own big tile and the brand moves to a footer lockup (§6 "Two
// layouts, not one").

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Explore public project plans on Motir';

export default async function ExploreOpengraphImage() {
  const fonts = await loadOgFonts();
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '80px',
        // --color-tint-lavender → --color-tint-sky.
        background: 'linear-gradient(135deg, #e6e0f5 0%, #dcecfa 100%)',
        fontFamily: OG_FONT_FAMILY,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <svg viewBox={WAVE_BAND_VIEW_BOX} width={72} height={72}>
          <path d={WAVE_BAND_PATH} fill={BRAND_ACCENT_HEX} />
        </svg>
        <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', color: '#2a2342' }}>
          Motir
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
        <div style={{ fontSize: 60, fontWeight: 800, color: '#1f1b2e', lineHeight: 1.1 }}>
          Explore public project plans built on Motir
        </div>
        <div style={{ fontSize: 28, color: '#473f63', maxWidth: 920 }}>
          Real, public roadmaps and project plans from teams building in the open — free to read, no
          sign-up.
        </div>
      </div>
    </div>,
    { ...size, fonts },
  );
}
