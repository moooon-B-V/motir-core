import { describe, it, expect, vi } from 'vitest';
import type { RawPreplanStateResponse, RawPreplanFinding } from '@/lib/ai/types';
import type { ProjectContext } from '@/lib/projects';

// Integration-SEAM test for the per-tier `summary` (MOTIR-1392 producer →
// MOTIR-1225 consumer). The producer (motir-ai) emits a structured `summary` on
// each `docs[]` entry; this side reads it back through `PreplanArtifactLogDTO`.
// The fake motir-ai client returns the summary under the EXACT wire keys motir-ai
// uses (label/value/tone); the assertion reads it through the DTO. So if anyone
// renames a key on EITHER side of the seam — the raw wire type vs the DTO/mapper —
// the round-trip breaks and this test goes red, catching the DTO key drift the
// per-layer unit mocks would each mask (the `preplan-design-choice-seam` pattern).

const SUMMARY: Record<string, RawPreplanFinding[]> = {
  discovery: [
    { label: 'What', value: 'send & track invoices', tone: 'positive' },
    { label: 'Who', value: 'solo freelancers', tone: 'positive' },
    { label: 'Closest', value: 'FreshBooks · Wave', tone: 'positive' },
  ],
  vision: [
    { label: 'In v1', value: 'invoices · reminders', tone: 'positive' },
    { label: 'Out', value: 'teams · accounting', tone: 'neutral' },
  ],
};

function artifact(kind: 'discovery' | 'vision', summary: RawPreplanFinding[]) {
  return {
    kind,
    currentBody: `# ${kind}\n\nrendered markdown only`,
    currentVersion: 1,
    summary,
    versions: [],
  };
}

vi.mock('@/lib/ai/motirAiClient', () => ({
  getPreplanState: vi.fn(
    async (): Promise<RawPreplanStateResponse> => ({
      session: null,
      docs: [artifact('discovery', SUMMARY.discovery!), artifact('vision', SUMMARY.vision!)],
      catalog: null,
    }),
  ),
}));

import { aiPreplanService } from '@/lib/services/aiPreplanService';

const ctx = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  project: { id: 'pj_1', identifier: 'MOTIR', name: 'Motir' },
} as ProjectContext;

describe('per-tier summary read seam (MOTIR-1225)', () => {
  it('each tier’s `summary` reads BACK through PreplanArtifactLogDTO verbatim (no key drift)', async () => {
    const dto = await aiPreplanService.getPreplanState(ctx);

    const discovery = dto.docs.find((d) => d.kind === 'discovery')!;
    // every axis key — label / value / tone — survives the wire → DTO trip intact
    expect(discovery.summary).toEqual(SUMMARY.discovery);

    const vision = dto.docs.find((d) => d.kind === 'vision')!;
    expect(vision.summary).toEqual(SUMMARY.vision);
    // the muted negative-space tone is carried, not flattened to positive
    expect(vision.summary.find((f) => f.label === 'Out')?.tone).toBe('neutral');
  });

  it('a tier with no structured doc yet maps to an empty summary (never undefined)', async () => {
    const { getPreplanState } = await import('@/lib/ai/motirAiClient');
    vi.mocked(getPreplanState).mockResolvedValueOnce({
      session: null,
      docs: [artifact('discovery', [])],
      catalog: null,
    });

    const dto = await aiPreplanService.getPreplanState(ctx);
    expect(dto.docs.find((d) => d.kind === 'discovery')!.summary).toEqual([]);
  });
});
