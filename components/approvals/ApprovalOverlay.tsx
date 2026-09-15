'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowUpRight, CircleDashed, FileX2, Lock, X } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Pill } from '@/components/ui/Pill';
import { ApprovalGateControl, type GateVerb } from '@/components/approvals/ApprovalGateControl';
import { DesignResultPanel } from '@/app/(authed)/items/[key]/_components/DesignResultPanel';
import { decideApprovalGateAction } from '@/app/(authed)/items/[key]/approvalGateActions';
import { shallowPush } from '@/lib/navigation/shallowUrl';
import { parseApprovalOverlay, withoutApprovalOverlay } from '@/lib/approvals/overlayAddress';
import { fetchApprovalGateOverlay } from '@/lib/approvals/approvalOverlayClient';
import { announceGateDecided } from '@/lib/approvals/decidedGates';
import type {
  ApprovalGateDTO,
  ApprovalGateKindDTO,
  ApprovalGateOverlayReadDTO,
  GateDecision,
} from '@/lib/dto/approvalGate';
import type { GateRefusal } from '@/lib/approvalGates/refusals';

// THE APPROVAL OVERLAY (Story MOTIR-5214 · Subtask MOTIR-5224) — an approval
// decided FULL SCREEN over whatever authed page is open, built to
// `design/workbench/approval-overlay.mock.html` + `design-notes.md` § 22.
//
// ⚠️ IT IS THE FOURTH INSTANCE OF A DECIDED PATTERN, NOT A FIFTH.
// `components/planning/PlanningWorkspaceOverlay.tsx` is the model and its header
// is the specification; what follows is that shape, and only the places this one
// differs are argued here.
//
// ⚠️ THE OPEN STATE IS THE ADDRESS, AND IS HELD NOWHERE ELSE. It is open when
// `?approval=` is in the query (`lib/approvals/overlayAddress.ts`) and it closes
// by writing the two parameters away with `shallowPush`. There is no state hook,
// context value or ref recording openness — so browser Back closes it with no code
// watching (a `popstate` changes what `useSearchParams` reports), a pasted link
// opens it cold, and nothing can disagree with the address bar.
//
// ⚠️ EVERY CLOSE GOES THROUGH `requestClose()` — the exit row's Close, `Esc` and
// the scrim (both arrive at the dialog's `onOpenChange`), and 5a's own Close
// button. Back is the one vector that has already happened by the time anything
// sees it, and it needs no call: the address it lands on is already closed. The
// seam is ONE function so a later guard has exactly one place to intercept, as
// MOTIR-4731's does on the planning overlay (§ 22 *THE EXIT*: this overlay has
// nothing to guard today).
//
// ⚠️ THE FRAME IS COMPOSED, NEVER RE-IMPLEMENTED. `ApprovalGateControl` renders
// here exactly as on the item page, through ONE layout input (`layout="fill"`)
// that changes its box and nothing inside it — § 22's planning flag 1. There is
// no second approve control, and `tests/approval-gate-one-language.test.ts` is
// what says so.
//
// ⚠️ IT IS A CLIENT ISLAND, SO IT READS OVER HTTP (MOTIR-5223's route). The route
// answers `canDecide`; nothing here derives it. Deciding goes through the shipped
// `decideApprovalGateAction`, which is the write door and is not this card's.
//
// ── PAGE STATE AFTER A DECISION (`CLAUDE.md`) ────────────────────────────────
// Deciding does NOT close the overlay: the frame re-renders with the decided
// record from the action's OWN response (the inline-edit half — never a refetch
// of the thing just written), and `router.refresh()` reaches the server-rendered
// surfaces behind it (the strip count, the readiness of the cards this one was
// blocking). Both halves, for the reason `ApprovalsList` records (MOTIR-5118).
// The To-approve row underneath is a CLIENT island that `router.refresh()` cannot
// reach, so the decision is also ANNOUNCED (`lib/approvals/decidedGates.ts`, § 22
// planning flag 2 — MOTIR-5225) and the row settles in the same reconcile.

/** What the read SETTLED on, and for which address. There is no loading member:
 *  pending is DERIVED at render (`settled.token !== token`), which is the quick
 *  view's own shape and keeps a synchronous `setState` out of the effect body. */
type Load =
  | { token: string; outcome: 'read'; read: ApprovalGateOverlayReadDTO }
  | { token: string; outcome: 'unavailable' };

/** A decision THIS reader made here — the frame's own reconcile, per address. */
interface Decided {
  token: string;
  gate: ApprovalGateDTO;
  filesKept: boolean | null;
}

function tokenOf(itemKey: string, kind: ApprovalGateKindDTO): string {
  return `${itemKey} ${kind}`;
}

/** The exit row's control recipe — `PlanningWorkspaceHost`'s Close, class for
 *  class, which is what the design composes. */
const EXIT_CONTROL =
  'inline-flex shrink-0 items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm font-medium text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)';

/**
 * THE EXIT ROW — Close with its `Esc` chip, then the work item's key and title,
 * then *Open work item*, the one way out that LEAVES the page (§ 22 *THE EXIT*).
 *
 * It names the WORK ITEM, never the kind: "Design result" appears once, in band 1.
 * `workItem` is null while loading and on Panel 5a, where the key in the address
 * is the reader's own text and echoing it beside a refusal reads as a
 * confirmation. Narrow (`< md`, Panel 7): no `Esc` chip, no title, and *Open work
 * item* becomes its icon with the label kept as its accessible name.
 */
function ExitRow({
  onClose,
  workItem,
}: {
  onClose: () => void;
  workItem: { identifier: string; title: string } | null;
}) {
  const t = useTranslations('approvalOverlay');
  const tc = useTranslations('common');
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-(--el-border-soft) bg-(--el-surface) px-4 py-2">
      <button type="button" onClick={onClose} className={EXIT_CONTROL}>
        <X className="h-4 w-4 shrink-0" aria-hidden />
        {tc('close')}
        <kbd className="ml-1 hidden rounded-(--radius-kbd) border border-(--el-border) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-[0.6875rem] text-(--el-text-secondary) md:inline">
          {t('escKey')}
        </kbd>
      </button>
      {workItem ? (
        <>
          <span className="flex min-w-0 items-center gap-2">
            {/* `--el-text-secondary`, not muted: the row is `--el-surface`, where
                muted fails AA (6.24:1 vs 4.17:1 — § 22's token map). */}
            <span className="shrink-0 font-mono text-xs text-(--el-text-secondary)">
              {workItem.identifier}
            </span>
            <span className="hidden truncate text-sm text-(--el-text) md:inline">
              {workItem.title}
            </span>
          </span>
          <Link
            href={`/items/${workItem.identifier}`}
            aria-label={t('openWorkItem')}
            className={`ml-auto ${EXIT_CONTROL}`}
          >
            <span className="hidden md:inline">{t('openWorkItem')}</span>
            <ArrowUpRight className="h-4 w-4 shrink-0" aria-hidden />
          </Link>
        </>
      ) : null}
    </div>
  );
}

/** Panel 5b — the frame's three bands as muted blocks at their real proportions,
 *  edge to edge, so an answer that arrives does not reflow the screen. */
function LoadingBands() {
  const t = useTranslations('approvalOverlay');
  return (
    <div aria-busy="true" aria-label={t('loading')} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-(--el-border-soft) px-4 py-3">
        <span className="h-4 w-28 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        <span className="h-3 w-48 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
        <span className="ml-auto h-5 w-24 animate-pulse rounded-(--radius-badge) bg-(--el-muted)" />
      </div>
      <div className="flex min-h-0 flex-1 px-4 py-4">
        <span className="flex-1 animate-pulse rounded-(--radius-card) bg-(--el-muted)" />
      </div>
      <div className="flex items-center gap-3 border-t border-(--el-border-soft) px-4 py-3">
        <span className="h-3 w-56 animate-pulse rounded-(--radius-control) bg-(--el-muted)" />
      </div>
    </div>
  );
}

/** The three arms that mount NO frame are centred in the body with the card
 *  padding around them (§ 22 *The three arms that mount NO frame*). */
function Frameless({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center p-(--spacing-card-padding)">
      {children}
    </div>
  );
}

export function ApprovalOverlay() {
  const t = useTranslations('approvalOverlay');
  const tc = useTranslations('common');
  const tRow = useTranslations('workbench.approvals');
  const tGate = useTranslations('approvalGate');
  const tDesign = useTranslations('approvalGate.designResult');
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();

  const address = useMemo(() => parseApprovalOverlay(searchParams), [searchParams]);
  const open = address !== null;
  const itemKey = address?.itemKey ?? null;
  const kind = address?.kind ?? null;
  // An address missing either half OPENS and says the approval is not available
  // (Panel 5a) — never a guessed kind, because a card can carry more than one gate.
  const token = itemKey !== null && kind !== null ? tokenOf(itemKey, kind) : null;

  const [load, setLoad] = useState<Load | null>(null);
  const [decided, setDecided] = useState<Decided | null>(null);

  // ⚠️ FOCUS RETURN, and why it is not free here — the planning overlay's reason
  // verbatim: Radix returns focus only to its own `Trigger`, and this dialog is
  // opened by a URL write from a door (a row, a Review button) that is not one.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    if (!open && wasOpenRef.current) {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) opener.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  /** THE ONE CLOSE. `shallowPush`, never `router.push`: the page underneath never
   *  unmounted, so a server round trip would re-render what is already on screen
   *  and throw away its scroll and its client islands. */
  const requestClose = useCallback(() => {
    // Forget this address's answers, so re-opening it asks the server again
    // rather than showing a gate somebody may have decided in the meantime.
    setLoad(null);
    setDecided(null);
    // Open means `?approval=` is in the query, so the query is never empty here.
    shallowPush(withoutApprovalOverlay(`${pathname}?${searchParams.toString()}`));
  }, [pathname, searchParams]);

  useEffect(() => {
    if (itemKey === null || kind === null) return;
    const controller = new AbortController();
    const forToken = tokenOf(itemKey, kind);
    void (async () => {
      try {
        const read = await fetchApprovalGateOverlay(itemKey, kind, controller.signal);
        if (controller.signal.aborted) return;
        setLoad(
          read
            ? { token: forToken, outcome: 'read', read }
            : { token: forToken, outcome: 'unavailable' },
        );
      } catch {
        if (controller.signal.aborted) return;
        // ⚠️ A failed read is drawn as NOT AVAILABLE, because it is the one arm
        // with nothing to press and a way out — never a blank dialog, and never
        // a live frame over an answer that did not arrive. The design draws no
        // separate "could not load" state; this is the nearest honest one.
        setLoad({ token: forToken, outcome: 'unavailable' });
      }
    })();
    return () => controller.abort();
  }, [itemKey, kind]);

  if (!open) return null;

  const settled = token !== null && load?.token === token ? load : null;
  const read = settled?.outcome === 'read' ? settled.read : null;
  const unavailable =
    token === null ||
    settled?.outcome === 'unavailable' ||
    (read !== null && (read.gate === null || read.subject.state === 'no_gate'));
  const loading = !unavailable && read === null;
  const kindLabel = kind ? tRow(`kind.${kind}`) : '';

  let workItem: { identifier: string; title: string } | null = null;
  let srTitle = t('loading');
  let body: ReactNode = <LoadingBands />;

  if (unavailable) {
    // Panel 5a — ONE answer for "does not exist" and "not yours to see": the read
    // returns one 404 for both, and a second message would say which.
    srTitle = t('notAvailable.title');
    body = (
      <Frameless>
        <EmptyState
          icon={<Lock className="h-12 w-12" aria-hidden />}
          title={t('notAvailable.title')}
          description={t('notAvailable.body')}
          action={
            <Button type="button" variant="primary" size="sm" onClick={requestClose}>
              {tc('close')}
            </Button>
          }
        />
      </Frameless>
    );
  } else if (!loading && read !== null && read.gate !== null) {
    workItem = { identifier: read.workItem.identifier, title: read.workItem.title };
    srTitle = t('dialogTitle', { kind: kindLabel, key: read.workItem.identifier });
    const openWorkItem = (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => router.push(`/items/${read.workItem.identifier}`)}
      >
        {t('openWorkItem')}
      </Button>
    );
    const subject = read.subject;

    if (subject.state === 'kind_not_built') {
      // Panel 4a — a feature that has not shipped. Opposite in meaning to 4b,
      // which is a gate worth withdrawing, however alike they look.
      body = (
        <Frameless>
          <EmptyState
            icon={<CircleDashed className="h-12 w-12" aria-hidden />}
            title={tRow('notRenderable')}
            description={
              <>
                {t('notRenderable.body', { kind: kindLabel })}
                <span className="mt-(--spacing-sm) block">
                  <Pill tone="archived">{tRow('notBuiltYet')}</Pill>
                </span>
              </>
            }
            action={openWorkItem}
          />
        </Frameless>
      );
    } else if (subject.state === 'gone') {
      // Panel 4b — a registered kind whose subject no longer resolves.
      body = (
        <Frameless>
          <EmptyState
            icon={<FileX2 className="h-12 w-12" aria-hidden />}
            title={tRow('subjectGone')}
            description={t('subjectGone.body')}
            action={openWorkItem}
          />
        </Frameless>
      );
    } else if (subject.state === 'resolved') {
      const local = decided?.token === token ? decided : null;
      const gate = local?.gate ?? read.gate;
      const identifier = read.workItem.identifier;
      const decidedState = gate.state !== 'awaiting';

      const verbs: GateVerb[] = [
        {
          decision: 'request_changes',
          label: tGate('verb.requestChanges'),
          variant: 'secondary',
          confirms: false,
        },
        {
          decision: 'approve',
          label: tGate('verb.approve'),
          variant: 'primary',
          confirms: true,
        },
      ];

      const onDecide = async (decision: GateDecision): Promise<GateRefusal | null> => {
        const result = await decideApprovalGateAction({ gateId: gate.id, decision, identifier });
        // A refusal applies nothing; the frame draws it IN PLACE and the overlay
        // stays open over it.
        if (!result.ok) return result.refusal;
        setDecided({ token: token!, gate: result.gate, filesKept: result.filesKept });
        // The WHOLE decision, not only its state: the To-approve row reads the
        // state, and the item page underneath reads `outcomeRef` for its status
        // rail and `filesKept` for its record (MOTIR-5570).
        announceGateDecided({ gate: result.gate, filesKept: result.filesKept });
        router.refresh();
        return null;
      };

      body = (
        <ApprovalGateControl
          layout="fill"
          gate={gate}
          // THE READ'S ANSWER, never this component's — a decided gate is
          // immutable, so nothing is left to press on one either way.
          canDecide={read.canDecide && !decidedState}
          kindLabel={tDesign('kindLabel')}
          subjectMeta={
            gate.subjectVersion
              ? tDesign('meta.withVersion', { version: gate.subjectVersion.slice(0, 8) })
              : tDesign('meta.plain')
          }
          // The route reads the GATE's own subject, so a decided gate shows the
          // version that was decided on (ADR §6c), not whatever is current now.
          port={<DesignResultPanel evidence={subject.evidence} isDesignCard />}
          verbs={verbs}
          consequence={tDesign('consequence', { key: identifier })}
          confirmConsequences={[
            tDesign('confirm.records'),
            tDesign('confirm.keepsFiles'),
            tDesign('confirm.movesToDone', { key: identifier }),
          ]}
          routedToLabel={read.routedToLabel}
          filesKept={local ? local.filesKept : subject.filesKept}
          onDecide={onDecide}
        />
      );
    }
  }

  return (
    <Modal
      open
      onOpenChange={(next) => {
        // `Esc` and the scrim both arrive here; the dialog is controlled, so this
        // IS the interception point.
        if (!next) requestClose();
      }}
      size="full"
      srTitle={srTitle}
      // At full size the dialog IS the surface: edge to edge, no radius, no border.
      className="flex flex-col rounded-none border-0 p-0"
      // The overlay carries its own Close, top-left — two Closes in one dialog is
      // a question nobody should be asked.
      hideClose
    >
      {/* modal-scroll-container: measured 1136x360, tallest = a design subject of six 32rem frames in the fill form (design-notes § 22 Panel 2b), band 2 the only scroll owner and band 3 on the bottom edge, panel 360px */}
      <ExitRow onClose={requestClose} workItem={workItem} />
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </Modal>
  );
}
