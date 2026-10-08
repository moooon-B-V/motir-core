'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Check, CircleX, Info, Lock, Mail, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import {
  ENTERPRISE_REQUEST_STATUSES,
  type EnterpriseRequestStatusValue,
} from '@/lib/dto/platformEnterpriseRequest';
import { transitionEnterpriseRequestAction } from '../actions';

/**
 * The detail's STATE CARD — design § Enterprise requests Panels 4, 5, 7 and 8.
 * One of three things, decided from the request as the server last read it:
 *
 *  - an OPEN request and a viewer who may move it → **Move to**: exactly the
 *    legal next states the service returned (`moves`) — the forward move as the
 *    primary button, Mark lost as the secondary with danger-on-surface ink —
 *    and a one-line hint;
 *  - a CLOSED request (`won` / `lost`) → **State**: _Closed as … on …_, no
 *    button, for every role;
 *  - an open request and a `support` viewer → **State**: the read-only line, as
 *    real text rather than a disabled button (support sees no control at all).
 *
 * Mark won and Mark lost close the request for good, so each asks once in an
 * `alertdialog`; the two open-state moves apply on one press.
 *
 * ⚠️ NO LOCAL COPY OF THE REQUEST. The status and moves are props, re-rendered
 * from the server: the action `revalidatePath`s the detail, so the response to
 * the move carries the re-read request — its pill, these buttons and the History
 * (the page-state-after-mutation contract, case 2). The only state kept here is
 * what the server cannot know: the open confirm, and the refusal callout. A
 * STALE refusal names who moved the request and to what; the re-read under it
 * already shows that state, so the viewer chooses again from the right buttons.
 */

type Outcome =
  | { kind: 'stale'; state: EnterpriseRequestStatusValue; who: string | null; action: string }
  | { kind: 'failed' };

const MOVE_ICON: Partial<Record<EnterpriseRequestStatusValue, ReactNode>> = {
  contacted: <Mail aria-hidden />,
  offer_sent: <MessageSquare aria-hidden />,
  won: <Check aria-hidden />,
  lost: <CircleX aria-hidden />,
};

const CLOSES = new Set<EnterpriseRequestStatusValue>(['won', 'lost']);

function isStatus(value: string): value is EnterpriseRequestStatusValue {
  return (ENTERPRISE_REQUEST_STATUSES as readonly string[]).includes(value);
}

export interface EnterpriseRequestStateCardProps {
  requestId: string;
  organizationId: string;
  organizationName: string;
  status: EnterpriseRequestStatusValue;
  /** The legal next states for this viewer — the service's answer, never re-derived here. */
  moves: EnterpriseRequestStatusValue[];
  /** ISO 8601 — when the request reached `won` / `lost`. */
  closedAt: string | null;
  /** False for a `support` viewer: the read-only line instead of buttons. */
  canMove: boolean;
}

export function EnterpriseRequestStateCard({
  requestId,
  organizationId,
  organizationName,
  status,
  moves,
  closedAt,
  canMove,
}: EnterpriseRequestStateCardProps) {
  const t = useTranslations('platformAdmin.enterpriseRequests');
  const format = useFormatter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<EnterpriseRequestStatusValue | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const bold = (chunks: ReactNode) => (
    <b className="font-semibold text-(--el-text-strong)">{chunks}</b>
  );
  const closed = CLOSES.has(status);
  const showMoves = !closed && canMove && moves.length > 0;

  function move(to: EnterpriseRequestStatusValue) {
    const from = status;
    const action = t(`move.${to}` as 'move.lost');
    setConfirming(null);
    startTransition(async () => {
      const result = await transitionEnterpriseRequestAction(requestId, organizationId, from, to);
      if (result.ok) {
        setOutcome(null);
      } else if (result.code === 'STALE' && isStatus(result.currentStatus)) {
        setOutcome({
          kind: 'stale',
          state: result.currentStatus,
          who: result.movedBy?.email ?? null,
          action,
        });
      } else {
        setOutcome({ kind: 'failed' });
      }
    });
  }

  let callout: ReactNode = null;
  if (outcome?.kind === 'stale') {
    const values = { state: t(`status.${outcome.state}`), action: outcome.action, b: bold };
    callout = (
      <div
        role="alert"
        data-testid="enterprise-request-stale"
        className="flex items-start gap-2.5 rounded-(--radius-card) bg-(--el-tint-yellow) p-(--spacing-card-padding) font-sans text-sm text-(--el-text-strong)"
      >
        <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-(--el-warning)" />
        <span>
          {outcome.who
            ? t.rich('stale', { ...values, who: outcome.who })
            : t.rich('staleUnknown', values)}
        </span>
      </div>
    );
  } else if (outcome?.kind === 'failed') {
    callout = (
      <p
        role="alert"
        data-testid="enterprise-request-move-failed"
        className="font-sans text-sm text-(--el-danger-on-surface)"
      >
        {t('move.failed')}
      </p>
    );
  }

  let body: ReactNode;
  if (showMoves) {
    const hint = status === 'new' || status === 'contacted' || status === 'offer_sent';
    body = (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {moves.map((to) => (
            <Button
              key={to}
              data-testid={`enterprise-request-move-${to}`}
              variant={to === 'lost' ? 'secondary' : 'primary'}
              className={
                to === 'lost'
                  ? 'border-(--el-border-strong) text-(--el-danger-on-surface)'
                  : undefined
              }
              leftIcon={MOVE_ICON[to]}
              disabled={pending}
              onClick={() => (CLOSES.has(to) ? setConfirming(to) : move(to))}
            >
              {t(`move.${to}` as 'move.lost')}
            </Button>
          ))}
        </div>
        <p className="font-sans text-xs text-(--el-text-secondary)">
          {hint ? `${t(`move.hint.${status}` as 'move.hint.new')} ` : ''}
          {t('move.hint.closes')}
        </p>
      </div>
    );
  } else if (closed) {
    const when = closedAt ?? null;
    body = (
      <p
        data-testid="enterprise-request-closed"
        className="flex items-start gap-2 font-sans text-sm text-(--el-text-secondary)"
      >
        <Check aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {t.rich('closed', {
            state: t(`status.${status}`),
            date: when ? format.dateTime(new Date(when), { dateStyle: 'medium' }) : '—',
            b: bold,
          })}
        </span>
      </p>
    );
  } else {
    body = (
      <p
        data-testid="enterprise-request-read-only"
        className="flex items-start gap-2 font-sans text-sm text-(--el-text-secondary)"
      >
        <Lock aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t.rich('readOnly', { b: bold })}</span>
      </p>
    );
  }

  const confirmState = confirming ? t(`stateWord.${confirming}`) : '';

  return (
    <div className="flex flex-col gap-3">
      {callout}
      <Card
        data-testid="enterprise-request-state-card"
        header={
          <h2 className="font-sans text-sm font-semibold text-(--el-text)">
            {showMoves ? t('move.title') : t('move.stateTitle')}
          </h2>
        }
      >
        {body}
      </Card>
      <Modal
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        role="alertdialog"
        size="sm"
        title={t('confirm.title', { state: confirmState })}
        closeLabel={t('confirm.cancel')}
        hideClose
      >
        <p className="font-sans text-sm text-(--el-text)">
          {t.rich('confirm.body', {
            org: organizationName,
            state: confirming ? t(`status.${confirming}`) : '',
            b: bold,
          })}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(null)}>
            {t('confirm.cancel')}
          </Button>
          <Button
            data-testid="enterprise-request-confirm"
            onClick={() => confirming && move(confirming)}
          >
            {confirming ? t(`move.${confirming}` as 'move.lost') : ''}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
