import { ImageResponse } from 'next/og';

// The generated OpenGraph share card for the project square (Story 6.13 ·
// Subtask 6.13.6 · design Panel 4 — social/share image). A branded card: the
// Motir tile + the square headline + a one-line lede. Rendered server-side via
// next/og. Inline hex is required here — this is an isolated raster surface
// OUTSIDE the React/CSS token tree (ImageResponse can't read CSS vars), the one
// place the --el-* rule doesn't reach (same posture as the project OG image).

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Explore public project plans on Motir';

export default function ExploreOpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '80px',
        background: 'linear-gradient(135deg, #e6e0f5 0%, #dcecfa 100%)',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 18,
            background: '#5645d4',
            color: '#ffffff',
            fontSize: 40,
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          M
        </div>
        <div style={{ fontSize: 30, fontWeight: 700, color: '#2a2342' }}>Motir</div>
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
    { ...size },
  );
}
