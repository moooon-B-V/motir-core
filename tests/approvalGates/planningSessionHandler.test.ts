import { describe, expect, it } from 'vitest';
import {
  APPROVAL_GATE_HANDLERS,
  UNREGISTERED_GATE_KINDS,
  handlerFor,
  isRegisteredGateKind,
} from '@/lib/approvalGates/registry';
import { planningSessionGateHandler } from '@/lib/approvalGates/planningSessionHandler';
import { ApprovalGateVerbNotOfferedError } from '@/lib/approvalGates/errors';
import type { GateEffectArgs, GateRoutingArgs } from '@/lib/approvalGates/registry';
import { AWAITING_REPLY_AFTER_MS } from '@/lib/services/planningSessionGateService';

// MOTIR-7913 — the planning-session handler's pure contract. No database: the live
// subject reads are the integration file's (`planningSessionGate.test.ts`).

const gate = {
  id: 'gate_1',
  workspaceId: 'ws_1',
  projectId: 'pj_1',
  workItemId: null,
  subjectId: 'session_1',
} as GateEffectArgs['gate'];
const args = { gate } as GateEffectArgs;

describe('the planning-session kind is registered', () => {
  it('is a registered kind with a handler, not one of the unregistered holes', () => {
    expect(isRegisteredGateKind('planning_session')).toBe(true);
    expect(handlerFor('planning_session')).toBe(planningSessionGateHandler);
    expect(APPROVAL_GATE_HANDLERS.planning_session).toBe(planningSessionGateHandler);
    expect(UNREGISTERED_GATE_KINDS as readonly string[]).not.toContain('planning_session');
  });
});

describe('the handler', () => {
  it('routes by the written `routedToId`, never by a work item', () => {
    expect(planningSessionGateHandler.routeTo({ item: null } as GateRoutingArgs)).toBeNull();
  });

  it('asks the planning permission the overlay already asserts and owns no status', () => {
    expect(planningSessionGateHandler.permission).toBe('ai:plan');
    expect(planningSessionGateHandler.statusIntent).toBeNull();
  });

  it('has no `decline` or `overturn` verb to advertise', () => {
    expect(planningSessionGateHandler.decline).toBeUndefined();
    expect(planningSessionGateHandler.overturn).toBeUndefined();
  });

  it.each(['approve', 'requestChanges'] as const)('%s is refused as not offered', async (verb) => {
    const err = await planningSessionGateHandler[verb](args).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    expect((err as ApprovalGateVerbNotOfferedError).reason).toBe('no_verbs_on_planning_session');
    expect((err as ApprovalGateVerbNotOfferedError).gateId).toBe('gate_1');
  });

  it('has no current subject without a gate in hand (the generic raise skips card-less kinds)', async () => {
    expect(
      await planningSessionGateHandler.currentSubject({ item: null } as GateRoutingArgs),
    ).toBeNull();
  });
});

describe('the reply threshold', () => {
  it('is ten minutes, in the one exported constant', () => {
    expect(AWAITING_REPLY_AFTER_MS).toBe(10 * 60 * 1000);
  });
});
