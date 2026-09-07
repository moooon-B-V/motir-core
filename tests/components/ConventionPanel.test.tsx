// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { ConventionPanel } from '@/app/(authed)/code-health/_components/ConventionPanel';
import type { CodingConventionDTO, ConventionSurfaceDTO } from '@/lib/dto/codeHealth';

// ⚠️ THE PLANNING DOORS READ THE ADDRESS (MOTIR-4730). Every surface that mounts
// one — and this tree mounts one — now calls `usePathname` / `useSearchParams`,
// because the workspace opens OVER the page you are on rather than navigating to
// `/planning`. Outside a router context the real hooks return `null` and the
// door throws on its first render, so the mock is no longer optional here.
const nav = vi.hoisted(() => ({
  pathname: '/dashboard',
  searchParams: new URLSearchParams(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => nav.searchParams,
}));

// The Convention tab of /code-health (MOTIR-1663), under happy-dom. This is the
// OBSERVABLE INVERSE of MOTIR-2127: a project whose motir-ai store holds a derived
// convention must render the DOCUMENT + its provenance badges — not the empty
// state the mis-shaped read-back produced for every project on the platform. The
// panel is the last layer that bug passed through, so it is asserted here directly
// rather than only through the mapper.

function convention(over: Partial<CodingConventionDTO> = {}): CodingConventionDTO {
  return {
    id: 'conv_2',
    repoKey: 'acme/web',
    version: 2,
    contentMd: '# House rules\n\n- Route → Service → Repository, never upward.',
    provenance: [
      { ruleId: 'layering.no-upward-imports', category: 'layering', source: 'adopted' },
      { ruleId: 'error.typed-taxonomy', category: 'error-handling', source: 'proposed' },
    ],
    createdAt: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

function surface(over: Partial<ConventionSurfaceDTO> = {}): ConventionSurfaceDTO {
  return {
    repoKey: 'acme/web',
    convention: convention(),
    versions: [convention()],
    nextCursor: null,
    ...over,
  };
}

afterEach(cleanup);

describe('ConventionPanel', () => {
  it('renders the derived convention document + provenance badges for a repo that has one', () => {
    renderWithIntl(<ConventionPanel conventions={[surface()]} />);

    // The repo header + the derived-version pill.
    expect(screen.getByText('acme/web')).toBeTruthy();
    expect(screen.getByText('v2 · derived')).toBeTruthy();
    // The document itself — rendered markdown, not a placeholder.
    expect(screen.getByText('House rules')).toBeTruthy();
    expect(screen.getByText(/Route → Service → Repository/)).toBeTruthy();
    // The auto-used banner (derived = auto-used, no approve gate — MOTIR-1660).
    expect(screen.getByText('Derived from your code — auto-used')).toBeTruthy();
    // Provenance: one Adopted rule, one Proposed rule.
    expect(screen.getByText('Adopted')).toBeTruthy();
    expect(screen.getByText('Proposed')).toBeTruthy();
    expect(screen.getByText('layering.no-upward-imports')).toBeTruthy();
    // ...and NOT the "nothing derived" copy.
    expect(screen.queryByText(/No convention rules have been derived yet/)).toBeNull();
  });

  it('still renders the empty state for a project with no derived convention', () => {
    renderWithIntl(<ConventionPanel conventions={[]} />);

    expect(screen.getByText('No convention yet')).toBeTruthy();
    expect(screen.queryByText('House rules')).toBeNull();
  });

  it('renders the per-repo no-rules copy when a repo card has no convention yet', () => {
    renderWithIntl(<ConventionPanel conventions={[surface({ convention: null, versions: [] })]} />);

    expect(screen.getByText(/No convention rules have been derived yet/)).toBeTruthy();
    expect(screen.queryByText('v2 · derived')).toBeNull();
  });

  it('renders one card per connected repo, keyed by repoKey', () => {
    renderWithIntl(
      <ConventionPanel
        conventions={[
          surface(),
          surface({
            repoKey: 'acme/api',
            convention: convention({ id: 'conv_9', repoKey: 'acme/api', version: 1 }),
            versions: [convention({ id: 'conv_9', repoKey: 'acme/api', version: 1 })],
          }),
        ]}
      />,
    );

    expect(screen.getByText('acme/web')).toBeTruthy();
    expect(screen.getByText('acme/api')).toBeTruthy();
    expect(screen.getByText('v2 · derived')).toBeTruthy();
    expect(screen.getByText('v1 · derived')).toBeTruthy();
  });

  it('lists version history WITHOUT a lifecycle status, marking the current version', () => {
    const older = convention({ id: 'conv_1', version: 1, createdAt: '2026-07-01T00:00:00.000Z' });
    renderWithIntl(
      <ConventionPanel conventions={[surface({ versions: [convention(), older] })]} />,
      { now: new Date('2026-07-04T00:00:00.000Z') },
    );

    expect(screen.getByText('Version history')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getByText('v1')).toBeTruthy();
    // Exactly one row is marked current — the latest derived version.
    expect(screen.getAllByText('Current')).toHaveLength(1);
    // The retired approve lifecycle must not reappear (MOTIR-1660/1662).
    expect(screen.queryByText('Standard')).toBeNull();
    expect(screen.queryByText('Superseded')).toBeNull();
    // The older version is dated relative to the pinned `now`.
    expect(screen.getByText('3 days ago')).toBeTruthy();
  });

  it('hides version history when there is only one version', () => {
    renderWithIntl(<ConventionPanel conventions={[surface()]} />);

    expect(screen.queryByText('Version history')).toBeNull();
  });
});
