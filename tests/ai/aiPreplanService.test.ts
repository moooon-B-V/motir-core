import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the boundary client (no network). aiPreplanService is a pure read-through:
// it forwards the already-resolved ProjectContext's core ids to the 7.3.25 client
// primitive and maps the wire body to the motir-core DTO — there is no DB read to
// stub (unlike usage, this read carries no org resolution), so this is a pure
// mapping test in the node env.
vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn() }));

import { aiPreplanService } from '@/lib/services/aiPreplanService';
import { getPreplanState } from '@/lib/ai/motirAiClient';
import { toDirectionDocView } from '@/lib/onboarding/directionDoc';
import type { ProjectContext } from '@/lib/projects';
import type { RawPreplanStateResponse } from '@/lib/ai/types';

const ctx = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  project: { id: 'pj_1', identifier: 'MOTIR', name: 'Motir' },
} as ProjectContext;

const fullRaw: RawPreplanStateResponse = {
  session: {
    aiProjectId: 'aip_internal_1',
    classification: 'startup',
    platform: 'web',
    docSkipSet: ['feasibility'],
    designStarter: 'minimal',
    validationTiming: 'after',
    currentGate: 'vision',
    conversation: [{ role: 'user', content: 'build me a tracker' }],
    status: 'active',
    createdAt: '2026-06-19T10:00:00.000Z',
    updatedAt: '2026-06-19T11:00:00.000Z',
  },
  docs: [
    {
      kind: 'discovery',
      currentBody: '# Discovery (Tier 1)\n\n## 1. Audience\n\nB2B teams.',
      currentVersion: 2,
      versions: [
        {
          version: 1,
          changeReason: null,
          changeKind: null,
          diff: null,
          createdAt: '2026-06-19T10:05:00.000Z',
        },
        {
          version: 2,
          changeReason: 'user revised the audience',
          changeKind: 'edit',
          diff: { added: ['B2B'], removed: ['B2C'] },
          createdAt: '2026-06-19T10:30:00.000Z',
        },
      ],
    },
    {
      kind: 'vision',
      currentBody: '# Vision (Tier 2)\n\n## 1. Pitch\n\nThe shape of v1.',
      currentVersion: 1,
      versions: [
        {
          version: 1,
          changeReason: null,
          changeKind: null,
          diff: null,
          createdAt: '2026-06-19T10:40:00.000Z',
        },
      ],
    },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe('aiPreplanService.getPreplanState', () => {
  it('forwards ONLY the core (workspace, project) ids to the client — never an aiProject id', async () => {
    vi.mocked(getPreplanState).mockResolvedValue({ session: null, docs: [] });

    await aiPreplanService.getPreplanState(ctx);

    expect(getPreplanState).toHaveBeenCalledTimes(1);
    expect(getPreplanState).toHaveBeenCalledWith({
      coreWorkspaceId: 'ws_1',
      coreProjectId: 'pj_1',
    });
  });

  it('maps a populated session + revision logs to the DTO, dropping the motir-ai-internal aiProjectId', async () => {
    vi.mocked(getPreplanState).mockResolvedValue(fullRaw);

    const dto = await aiPreplanService.getPreplanState(ctx);

    // The 5 strategy decisions + gate + transcript essentials survive…
    expect(dto.session).toEqual({
      classification: 'startup',
      platform: 'web',
      designStarter: 'minimal',
      validationTiming: 'after',
      docSkipSet: ['feasibility'],
      currentGate: 'vision',
      status: 'active',
      conversation: [{ role: 'user', content: 'build me a tracker' }],
      createdAt: '2026-06-19T10:00:00.000Z',
      updatedAt: '2026-06-19T11:00:00.000Z',
    });
    // …and the motir-ai-internal identity is NOT leaked to the browser.
    expect(dto.session).not.toHaveProperty('aiProjectId');
  });

  it('preserves each artifact’s current body + version AND the forward revision log (diffs verbatim)', async () => {
    vi.mocked(getPreplanState).mockResolvedValue(fullRaw);

    const dto = await aiPreplanService.getPreplanState(ctx);

    expect(dto.docs).toEqual([
      {
        kind: 'discovery',
        currentBody: '# Discovery (Tier 1)\n\n## 1. Audience\n\nB2B teams.',
        currentVersion: 2,
        versions: [
          {
            version: 1,
            changeReason: null,
            changeKind: null,
            diff: null,
            createdAt: '2026-06-19T10:05:00.000Z',
          },
          {
            version: 2,
            changeReason: 'user revised the audience',
            changeKind: 'edit',
            diff: { added: ['B2B'], removed: ['B2C'] },
            createdAt: '2026-06-19T10:30:00.000Z',
          },
        ],
      },
      {
        kind: 'vision',
        currentBody: '# Vision (Tier 2)\n\n## 1. Pitch\n\nThe shape of v1.',
        currentVersion: 1,
        versions: [
          {
            version: 1,
            changeReason: null,
            changeKind: null,
            diff: null,
            createdAt: '2026-06-19T10:40:00.000Z',
          },
        ],
      },
    ]);
  });

  it('threads each produced tier’s current body + version through to the DTO, mappable to a DirectionDocView', async () => {
    vi.mocked(getPreplanState).mockResolvedValue(fullRaw);

    const dto = await aiPreplanService.getPreplanState(ctx);

    // The body is sourced from the motir-ai wire, never synthesized.
    expect(dto.docs.map((d) => [d.kind, d.currentBody, d.currentVersion])).toEqual([
      ['discovery', '# Discovery (Tier 1)\n\n## 1. Audience\n\nB2B teams.', 2],
      ['vision', '# Vision (Tier 2)\n\n## 1. Pitch\n\nThe shape of v1.', 1],
    ]);
    // …and folds straight onto 834's read-only view model at the 7.3.5 gate.
    expect(toDirectionDocView(dto.docs[1]!)).toEqual({
      kind: 'vision',
      contentMd: '# Vision (Tier 2)\n\n## 1. Pitch\n\nThe shape of v1.',
      version: 1,
    });
  });

  it('passes the empty resume state through as session: null / docs: [] (a not-yet-started project, not an error)', async () => {
    vi.mocked(getPreplanState).mockResolvedValue({ session: null, docs: [] });

    const dto = await aiPreplanService.getPreplanState(ctx);

    expect(dto).toEqual({ session: null, docs: [] });
  });

  it('propagates a client transport error (the route maps it to 502)', async () => {
    vi.mocked(getPreplanState).mockRejectedValue(new Error('boom'));

    await expect(aiPreplanService.getPreplanState(ctx)).rejects.toThrow('boom');
  });
});
