import { ImageResponse } from 'next/og';
import { getSession } from '@/lib/auth';
import { publicProjectsService } from '@/lib/services/publicProjectsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// Generated OpenGraph image for a public project (Story 6.12 · Subtask 6.12.4 ·
// design Panel 9 — social/share card). A simple branded card: the project's
// initial tile + name + "Public project on Motir". Rendered server-side via
// next/og ImageResponse. Inline hex is required here (this is an isolated raster
// surface OUTSIDE the React/CSS token tree — ImageResponse can't read CSS vars),
// so it uses the brand palette values directly; this is the one place the
// --el-* rule doesn't reach.

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

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

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '80px',
        background: 'linear-gradient(135deg, #e6e0f5 0%, #dcecfa 100%)',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '28px' }}>
        <div
          style={{
            width: 120,
            height: 120,
            borderRadius: 24,
            background: '#5645d4',
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
          <div style={{ fontSize: 72, fontWeight: 700, color: '#1a1a1a' }}>{name}</div>
          <div style={{ fontSize: 32, color: '#5d5b54', marginTop: 8 }}>
            Public project on Motir
          </div>
        </div>
      </div>
    </div>,
    { ...size },
  );
}
