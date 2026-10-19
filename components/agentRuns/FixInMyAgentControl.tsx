'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { SquareTerminal } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Notice, When } from '@/components/hosted/ContinueHostedControl';
import { pressKey } from '@/components/hosted/hostedModels';
import { RepairRunLink } from '@/components/github/RepairFixPart';
import { agentPanelHref } from '@/app/(authed)/runs/_components/AgentRunParts';
import { SignInCommand } from '@/app/(authed)/items/[key]/_components/SendToAgentDoor';
import type { FixInMyAgentDoorDto } from '@/lib/dto/agentInstanceRuns';

// FIX IN MY AGENT (Story MOTIR-8981 · MOTIR-9053), built to `design/github` and the
// ended run modal's copy of it, in the words of `github.development.fix.myAgent.*`.
//
// ⚠️ IT DOES NOT DECIDE WHETHER IT IS OFFERED. The door reads ONE server evaluation
// (`GET /api/work-items/{key}/fix-in-my-agent`, which asks the repair claim's own
// predicate), and renders nothing until that read has answered, so the fix part does not
// shift under a person's cursor. The press writes no status and no claim row itself: it
// POSTs the agent-run start with `command: 'fix'`, and every refusal is drawn from that
// route's own answer. Whether the fix RESUMED or started fresh is the run's own output,
// not this door's claim.

export type FixInMyAgentRefusal =
  | {
      kind: 'busy';
      holderName: string | null;
      byViewer: boolean;
      startedAt: string | null;
      runId: string | null;
    }
  | { kind: 'settled' }
  | { kind: 'signedOut' }
  | { kind: 'outOfCredits' }
  | { kind: 'permission' }
  | { kind: 'failed' };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The agent-run start's refusal → the notice the door draws. Exported for its test. */
export function inMyAgentRefusalOf(
  status: number,
  body: Record<string, unknown>,
  viewerId: string | null,
): FixInMyAgentRefusal {
  const code = str(body.code) ?? '';
  if (code === 'agent_run_repair_refused') {
    const claim = (body.claim ?? {}) as Record<string, unknown>;
    if (claim.outcome === 'taken') {
      const holder = (claim.holder ?? null) as { id?: unknown; name?: unknown } | null;
      return {
        kind: 'busy',
        holderName: str(holder?.name),
        byViewer: viewerId !== null && str(holder?.id) === viewerId,
        startedAt: str(claim.startedAt),
        runId: str(claim.runId),
      };
    }
    // The pull requests went green (or the card left the repairable state) while the
    // press was being prepared: nothing to fix any more.
    return { kind: 'settled' };
  }
  if (code === 'agent_not_signed_in') return { kind: 'signedOut' };
  if (status === 403) return { kind: 'permission' };
  if (status === 402) return { kind: 'outOfCredits' };
  return { kind: 'failed' };
}

interface PressedAgent {
  id: string;
  name: string;
  profileId: string;
}

type DoorRead =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; door: FixInMyAgentDoorDto };

export interface UseFixInMyAgentOptions {
  viewerId?: string | null;
  /** The fix started: the caller re-reads whatever shows the card's state. */
  onStarted?: () => void;
  /** A refusal that means the caller's view of the card is STALE. */
  onStateMoved?: () => void;
}

export function useFixInMyAgent(itemKey: string, opts: UseFixInMyAgentOptions = {}) {
  const { viewerId = null, onStarted, onStateMoved } = opts;
  const [read, setRead] = useState<DoorRead>({ state: 'loading' });
  const [starting, setStarting] = useState(false);
  const [refusal, setRefusal] = useState<FixInMyAgentRefusal | null>(null);
  const inFlight = useRef(false);
  const [pressed, setPressed] = useState<PressedAgent | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/work-items/${encodeURIComponent(itemKey)}/fix-in-my-agent`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        setRead({ state: 'error' });
        return;
      }
      setRead({ state: 'ready', door: (await res.json()) as FixInMyAgentDoorDto });
    } catch {
      setRead({ state: 'error' });
    }
  }, [itemKey]);

  useEffect(() => {
    // The async wrapper keeps the state update out of the effect BODY
    // (`react-hooks/set-state-in-effect`).
    void (async () => {
      await load();
    })();
  }, [load]);

  const start = useCallback(async (): Promise<void> => {
    if (inFlight.current || read.state !== 'ready' || !read.door.offered) return;
    inFlight.current = true;
    setPressed({
      id: read.door.agent.id,
      name: read.door.agent.name,
      profileId: read.door.agent.profileId,
    });
    setStarting(true);
    setRefusal(null);
    try {
      const res = await fetch(`/api/work-items/${encodeURIComponent(itemKey)}/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          agentInstanceId: read.door.agent.id,
          command: 'fix',
          idempotencyKey: pressKey(),
        }),
      });
      // The body is read on EVERY answer: a start whose body nobody reads leaves a
      // response a browser driver cannot read back (`Response.json()` then never settles).
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (res.ok) {
        onStarted?.();
        void load();
        return;
      }
      const refused = inMyAgentRefusalOf(res.status, body, viewerId);
      setRefusal(refused);
      if (refused.kind === 'settled' || refused.kind === 'busy') {
        onStateMoved?.();
        void load();
      }
    } catch {
      setRefusal({ kind: 'failed' });
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  }, [itemKey, load, onStarted, onStateMoved, read, viewerId]);

  return { read, starting, refusal, pressed, start, reload: load };
}

const bold = (chunks: ReactNode) => <b className="font-semibold">{chunks}</b>;

function Refusal({
  refusal,
  agent,
  runLabel,
}: {
  refusal: FixInMyAgentRefusal;
  agent: PressedAgent;
  runLabel: string | null;
}) {
  const agentName = agent.name;
  const agentId = agent.id;
  const profileId = agent.profileId;
  const t = useTranslations('github.development.fix.myAgent');
  const tRun = useTranslations('runs.hosted.refused');
  const testId = `fix-my-agent-refused-${refusal.kind}`;
  switch (refusal.kind) {
    case 'busy': {
      const when = () => (refusal.startedAt ? <When iso={refusal.startedAt} /> : null);
      const run = (chunks: ReactNode) =>
        refusal.runId ? <RepairRunLink runId={refusal.runId}>{chunks}</RepairRunLink> : chunks;
      const label = runLabel ?? refusal.runId ?? '—';
      return (
        <Notice testId={testId}>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-semibold">{t('refused.busy.title')}</p>
            <p>
              {refusal.byViewer
                ? t.rich('refused.busy.bodyYou', { when, run, label, b: bold })
                : t.rich('refused.busy.body', {
                    name: refusal.holderName ?? '—',
                    when,
                    run,
                    label,
                    b: bold,
                  })}
            </p>
          </div>
        </Notice>
      );
    }
    case 'settled':
      return (
        <Notice testId={testId}>
          <p>{t('settled.notice')}</p>
        </Notice>
      );
    case 'signedOut':
      return (
        <Notice testId={testId}>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-semibold">
              {t.rich('refused.signedOut.title', { agent: agentName, b: bold })}
            </p>
            <p>
              {t.rich('refused.signedOut.body', {
                agent: agentName,
                b: bold,
                link: (chunks) => (
                  <Link className="text-(--el-link) underline" href={agentPanelHref(agentId)}>
                    {chunks}
                  </Link>
                ),
                cmd: () => <SignInCommand profileId={profileId} />,
              })}
            </p>
          </div>
        </Notice>
      );
    default:
      return (
        <Notice testId={testId}>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-semibold">{tRun(`${refusal.kind}.title`)}</p>
            <p>{tRun(`${refusal.kind}.body`)}</p>
          </div>
        </Notice>
      );
  }
}

/**
 * The whole door for ONE card. `variant="part"` is the Development block's fix part
 * (the lead names the agent); `"modal"` is an ended run's copy of it (its own lead, and
 * the running fix is read back with a link to its run).
 */
export function FixInMyAgentControl({
  itemKey,
  viewerId = null,
  variant = 'part',
  onStarted,
  onStateMoved,
}: {
  itemKey: string;
  viewerId?: string | null;
  variant?: 'part' | 'modal';
  onStarted?: () => void;
  onStateMoved?: () => void;
}) {
  const t = useTranslations('github.development.fix.myAgent');
  const tRun = useTranslations('runs.hosted.refused');
  const tc = useTranslations('common');
  const press = useFixInMyAgent(itemKey, { viewerId, onStarted, onStateMoved });
  const { read } = press;

  if (read.state === 'loading') return null;
  if (read.state === 'error') {
    return (
      <Notice testId="fix-my-agent-read-failed">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-semibold">{tRun('failed.title')}</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => void press.reload()}>
            {tc('retry')}
          </Button>
        </div>
      </Notice>
    );
  }

  const door = read.door;
  const answer =
    press.refusal && press.pressed ? (
      <Refusal
        refusal={press.refusal}
        agent={press.pressed}
        runLabel={!door.offered ? (door.run?.label ?? null) : null}
      />
    ) : null;
  if (!door.offered) {
    // A fix running right now is read back where a person looks at the run.
    if (door.reason === 'repair_open' && door.run && variant === 'modal') {
      const run = door.run;
      const when = () => <When iso={run.startedAt} />;
      const link = (chunks: ReactNode) => <RepairRunLink runId={run.id}>{chunks}</RepairRunLink>;
      return (
        <div className="flex flex-col gap-1" data-testid="fix-my-agent-fixing">
          <p className="text-[13px] leading-normal text-(--el-text-secondary)">
            {run.byViewer
              ? t.rich('fixing.byYou', {
                  agent: run.agentName ?? '—',
                  when,
                  run: link,
                  label: run.label,
                  b: bold,
                })
              : t.rich('fixing.by', {
                  name: run.holder?.name ?? '—',
                  agent: run.agentName ?? '—',
                  when,
                  run: link,
                  label: run.label,
                  b: bold,
                })}
          </p>
          <p className="text-xs leading-normal text-(--el-text-secondary)">{t('fixing.why')}</p>
        </div>
      );
    }
    return answer;
  }

  return (
    <div className="flex flex-col gap-2" data-testid="fix-my-agent-control">
      <p className="text-[13px] leading-normal text-(--el-text)">
        {variant === 'modal'
          ? t('modal.lead')
          : t.rich('lead', { agent: door.agent.name, b: bold })}
      </p>
      <div className="flex flex-wrap items-center gap-2" data-testid="fix-my-agent-door">
        <Button
          type="button"
          variant="primary"
          size="sm"
          loading={press.starting}
          disabled={press.starting}
          onClick={() => void press.start()}
          leftIcon={<SquareTerminal className="size-3.5" aria-hidden="true" />}
          data-testid="fix-my-agent"
        >
          {press.starting ? t('door.starting') : t('door.label')}
        </Button>
      </div>
      <p className="text-xs leading-normal text-(--el-text-secondary)">{t('door.why')}</p>
      {answer}
    </div>
  );
}
