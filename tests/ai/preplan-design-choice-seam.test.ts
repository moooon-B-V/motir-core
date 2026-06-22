import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawPreplanSession, RawPreplanStateResponse } from '@/lib/ai/types';
import type { SaveDesignChoiceInput } from '@/lib/ai/motirAiClient';
import type { ProjectContext } from '@/lib/projects';

// Integration-SEAM test for the design-choice round-trip (Subtask 7.3.81). The unit
// tests prove the WRITE serialization and the READ mapping in isolation; this test
// proves they AGREE — it saves a choice through `saveDesignChoice` and reads it BACK
// through `getPreplanState`'s `PreplanStateDTO.designChoice`. The motir-ai boundary
// is a STATEFUL in-memory fake: `saveDesignChoice` stores exactly the body the
// service serialized, and `getPreplanState` returns it under the same wire key
// motir-ai uses. So if anyone renames a key on ONE side of the seam (the write body
// vs the read mapper), the choice fails to round-trip and this test goes red —
// catching the DTO key drift the per-layer mocks would each mask.
//
// (`SaveDesignChoiceInput` is imported type-only from the client for the fake's
// typing — type imports are erased, so they don't defeat the mock.)

// The fake's single cell of motir-ai state.
let stored: RawPreplanSession['designChoice'] = null;

function sessionRow(): RawPreplanSession {
  return {
    aiProjectId: 'ai_seam_1',
    classification: 'startup',
    platform: 'web',
    docSkipSet: [],
    designStarter: stored ? 'bare' : null,
    designChoice: stored,
    validationTiming: null,
    currentGate: 'vision',
    conversation: [],
    status: 'active',
    createdAt: '2026-06-22T00:00:00.000Z',
    updatedAt: '2026-06-22T00:00:00.000Z',
  };
}

vi.mock('@/lib/ai/motirAiClient', () => ({
  // PATCH: persist exactly what the service serialized into the body.
  saveDesignChoice: vi.fn(async (input: SaveDesignChoiceInput): Promise<RawPreplanSession> => {
    stored = input.designChoice;
    return sessionRow();
  }),
  // GET: hand the stored choice back under the wire key, like motir-ai does.
  getPreplanState: vi.fn(
    async (): Promise<RawPreplanStateResponse> => ({
      session: sessionRow(),
      docs: [],
      catalog: null,
    }),
  ),
}));

// Resolve the org id without a DB (the write find-or-creates under it).
vi.mock('@/lib/workspaces/context', () => ({
  withWorkspaceContext: <T>(_c: unknown, fn: (tx: unknown) => Promise<T>) => fn({}),
}));
vi.mock('@/lib/repositories/workspaceRepository', () => ({
  workspaceRepository: { findByIdInTx: async () => ({ organizationId: 'org_1' }) },
}));

import { aiPreplanService } from '@/lib/services/aiPreplanService';

const ctx = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  project: { id: 'pj_1', identifier: 'MOTIR', name: 'Motir' },
} as ProjectContext;

beforeEach(() => {
  stored = null;
});

describe('design-choice persist→restore seam (7.3.81)', () => {
  it('a saved choice reads BACK through PreplanStateDTO.designChoice unchanged (no key drift)', async () => {
    const choice = { styleId: 'neo-brutalism', paletteId: 'evergreen', typeId: 'editorial' };

    const saved = await aiPreplanService.saveDesignChoice(ctx, choice);
    expect(saved).toEqual(choice);

    // Re-read the way the onboarding loop resumes — the choice survives the
    // write-body → wire → read-DTO trip with every axis key intact.
    const dto = await aiPreplanService.getPreplanState(ctx);
    expect(dto.session?.designChoice).toEqual(choice);
  });

  it('the empty state reads back a null designChoice before any save', async () => {
    const dto = await aiPreplanService.getPreplanState(ctx);
    expect(dto.session?.designChoice).toBeNull();
  });
});
