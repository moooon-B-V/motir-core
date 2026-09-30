'use client';

import { useCallback, useMemo, useState } from 'react';
import type { AgentForCardDto } from '@/lib/dto/agentInstanceRuns';
import { pressKey, refusalOf, type HostedRunRefusal } from '@/components/hosted/hostedModels';

// SEND TO MY AGENT — the press and what it answers (Story MOTIR-6864 · MOTIR-7028;
// `design/runs/design-notes.md` § Run in my agent + § Revision 2).
//
// ⚠️ ONE PRESS, NO SECOND CLICK. Choosing a row POSTs the start once; the route
// wakes a sleeping agent itself and answers with the run id at once, so the Run
// section moves to the new run on the answer — the same tick a Run press bumps
// (the page-state contract: the run history is a client island that refetches on
// it, and the server surfaces are refreshed beside it).
//
// ⚠️ A REFUSAL IS NOT A RUN. Every refusal is answered before a run is opened, so
// it is drawn on the start bar and never in the timeline; the picker re-reads its
// list the next time it opens, so a row that has since become busy says so.

/** The row a person pressed — what the refusal's words and the starting detail name. */
export type PickedAgent = Pick<
  AgentForCardDto,
  'id' | 'name' | 'profileId' | 'profileName' | 'state'
>;

/** Why a send was refused, in the design's families (panels 5 and 6). */
export type AgentSendRefusal =
  | {
      kind:
        | 'notSignedIn'
        | 'wrongProject'
        | 'notReady'
        | 'imageTooOld'
        | 'cannotRun'
        | 'hibernating'
        | 'deleting'
        | 'notFound'
        | 'permission'
        | 'outOfCredits'
        | 'failed';
      agent: PickedAgent;
    }
  | { kind: 'runActive'; agent: PickedAgent; runId: string | null; workItemKey: string | null }
  /** The wake's own refusal, passed through: its body is `myAgents.refusal.*`'s. */
  | { kind: 'wake'; agent: PickedAgent; code: string; reason?: string }
  /** The shipped repositories notice, unchanged (`hosted_repository_not_writable`). */
  | { kind: 'notWritable'; agent: PickedAgent; hosted: HostedRunRefusal };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The start route's refusal body → the notice the start bar draws. Exported for its test. */
export function agentSendRefusalOf(
  status: number,
  body: Record<string, unknown>,
  agent: PickedAgent,
): AgentSendRefusal {
  const code = str(body.code) ?? '';
  switch (code) {
    case 'agent_not_signed_in':
      return { kind: 'notSignedIn', agent };
    case 'agent_instance_wrong_project':
      return { kind: 'wrongProject', agent };
    case 'agent_run_card_not_ready':
      return { kind: 'notReady', agent };
    case 'agent_instance_run_active':
      return {
        kind: 'runActive',
        agent,
        runId: str(body.runId),
        workItemKey: str(body.workItemKey),
      };
    case 'agent_instance_image_too_old':
      return { kind: 'imageTooOld', agent };
    case 'agent_profile_cannot_run':
      return { kind: 'cannotRun', agent };
    case 'agent_instance_state_conflict':
      // The body names no state; the pressed row's is the one that was stale.
      return { kind: agent.state === 'deleting' ? 'deleting' : 'hibernating', agent };
    case 'agent_instance_not_found':
      return { kind: 'notFound', agent };
    case 'hosted_repository_not_writable':
      return { kind: 'notWritable', agent, hosted: refusalOf(status, body, '') };
    case 'agent_instance_start_refused':
    case 'agent_instances_unavailable':
      return { kind: 'wake', agent, code, reason: str(body.reason) ?? undefined };
  }
  if (status === 403) return { kind: 'permission', agent };
  if (status === 402) return { kind: 'outOfCredits', agent };
  return { kind: 'failed', agent };
}

/** The run a send just opened — the starting detail says *Waking* or *Starting in*. */
export interface AgentSendStarted {
  runId: string;
  agentName: string;
  /** The pressed row was asleep (`hibernated`) or `failed`, so the send wakes it. */
  woke: boolean;
}

export interface AgentSendState {
  /** The id of the agent whose press is in flight, or null. */
  sendingId: string | null;
  refusal: AgentSendRefusal | null;
  started: AgentSendStarted | null;
  send: (agent: PickedAgent) => Promise<void>;
}

export function useAgentSend(itemKey: string, onStarted: () => void): AgentSendState {
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<AgentSendRefusal | null>(null);
  const [started, setStarted] = useState<AgentSendStarted | null>(null);

  const send = useCallback(
    async (agent: PickedAgent): Promise<void> => {
      if (sendingId) return;
      setSendingId(agent.id);
      setRefusal(null);
      try {
        const res = await fetch(`/api/work-items/${encodeURIComponent(itemKey)}/agent-runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ agentInstanceId: agent.id, idempotencyKey: pressKey() }),
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (res.ok && typeof body.dispatchRunId === 'string') {
          // The pressed row decides the word, not a re-read (design panel 7).
          setStarted({
            runId: body.dispatchRunId,
            agentName: agent.name,
            woke: agent.state === 'hibernated' || agent.state === 'failed',
          });
          onStarted();
          return;
        }
        setRefusal(agentSendRefusalOf(res.status, body, agent));
      } catch {
        setRefusal({ kind: 'failed', agent });
      } finally {
        setSendingId(null);
      }
    },
    [itemKey, onStarted, sendingId],
  );

  return useMemo(
    () => ({ sendingId, refusal, started, send }),
    [sendingId, refusal, started, send],
  );
}
