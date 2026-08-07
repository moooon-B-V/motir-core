import { ImageResponse } from 'next/og';
import { loadOgFonts, OG_FONT_FAMILY } from '@/app/_brand/ogFonts';
import { BRAND_ACCENT_HEX, WAVE_BAND_PATH, WAVE_BAND_VIEW_BOX } from '@/components/brand/waveBand';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// Generated OpenGraph image for a public project (Story 6.12 · Subtask 6.12.4 ·
// design Panel 9 — social/share card). Rendered server-side via next/og
// ImageResponse. Inline hex is required here (this is an isolated raster surface
// OUTSIDE the React/CSS token tree — ImageResponse can't read CSS vars), so it
// uses the brand palette values directly; this is the one place the --el-* rule
// doesn't reach.
//
// MOTIR-1150 · design/brand/design-notes.md §6 — TWO LAYOUTS, NOT ONE. The
// project keeps its big initial tile, because on this card the PROJECT is the
// subject; the brand moves to a footer lockup so the two identities never
// compete. (The explore card is the mirror case and puts the brand first.)
// The card is also set in Inter now, passed through `fonts` — it said
// 'sans-serif' before, which in a raster surface means whatever face the build
// container happens to ship.
//
// `export const alt` is new here and is not optional: it is the only accessible
// name a social embed ever gets, and the explore card has always had one (§6).

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'Public project on Motir';

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ identifier: string }>;
}) {
  const { identifier } = await params;
  const session = await getSession();
  const actorUserId = session?.user.id ?? null;

  let name = identifier;
  try {
    const overview = await publicProjectsService.getOverview(identifier, actorUserId);
    name = overview.name;
  } catch (err) {
    if (!(err instanceof ProjectNotFoundError)) throw err;
  }
  const initial = name.trim().charAt(0).toUpperCase() || 'P';
  const fonts = await loadOgFonts();

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: '56px',
        padding: '80px',
        // --color-tint-lavender → --color-tint-sky.
        background: 'linear-gradient(135deg, #e6e0f5 0%, #dcecfa 100%)',
        fontFamily: OG_FONT_FAMILY,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '28px' }}>
        <div
          style={{
            width: 120,
            height: 120,
            borderRadius: 24,
            // --el-accent carrying --el-accent-text, light theme.
            background: BRAND_ACCENT_HEX,
            color: '#ffffff',
            fontSize: 64,
            fontWeight: 800,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {initial}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ fontSize: 72, fontWeight: 700, color: '#1f1b2e' }}>{name}</div>
          <div style={{ fontSize: 32, color: '#473f63', marginTop: 8 }}>
            Public project on Motir
          </div>
        </div>
      </div>
      {/* The footer lockup — quieter than the project row above it by 0.85
            opacity, so the host never competes with the subject (§6). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '20px', opacity: 0.85 }}>
        <svg viewBox={WAVE_BAND_VIEW_BOX} width={56} height={56}>
          <path d={WAVE_BAND_PATH} fill={BRAND_ACCENT_HEX} />
        </svg>
        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', color: '#2a2342' }}>
          Motir
        </div>
      </div>
    </div>,
    { ...size, fonts },
  );
}
