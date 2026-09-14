'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ApprovalGateControl } from '@/components/approvals/ApprovalGateControl';
import type { ApprovalGateDTO } from '@/lib/dto/approvalGate';

// THE DEVELOPMENT BLOCK'S FRAME ARM (Story MOTIR-4906 · Subtask MOTIR-5336),
// `design/github/design-notes.md` §20 · Panel 12c. When the card's
// approve-to-merge gate is AWAITING, the block IS the universal frame — composed
// exactly as `DesignResultSection` composes the design gate: band 2 (the port)
// is the pull-request rows plus How to test, unchanged; ONE frame for all the
// run target's pull requests, never one per row.
//
// ⚠️ NO VERBS, AND NO DECIDE PATH. `pull_request_approval` is unregistered until
// MOTIR-4909, which supplies the kind's label, consequence and *Approve and
// merge*. Until then this arm renders the frame's verb-less state, and no live
// tenant reaches it — the kind has no rows. `ApprovalGateControl` is composed,
// never modified.
//
// A client boundary of its own because the frame takes a callback, which a
// server component cannot hand across; the PORT arrives as already-rendered
// children, so the rows and the block keep rendering where they did.

export interface DevelopmentGateRead {
  gate: ApprovalGateDTO;
  canDecide: boolean;
  routedToLabel: string | null;
}

export function DevelopmentGateFrame({
  read,
  subjectMeta,
  children,
}: {
  read: DevelopmentGateRead;
  /** Band 1's meta — the run that delivered the pull requests, when known. */
  subjectMeta: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations('github');
  return (
    <ApprovalGateControl
      gate={read.gate}
      canDecide={read.canDecide}
      // MOTIR-4909 keys the kind's own label; until then the card's own title
      // names what is being decided rather than an invented string.
      kindLabel={t('development.title')}
      subjectMeta={subjectMeta}
      // `data-port` lifts the block's code surfaces to `--el-card` on the port's
      // `--el-surface` (§20 Decisions: the same fill would leave only the edge).
      port={
        <div data-port className="min-w-0">
          {children}
        </div>
      }
      verbs={[]}
      consequence={null}
      confirmConsequences={[]}
      routedToLabel={read.routedToLabel}
      onDecide={async () => null}
    />
  );
}
