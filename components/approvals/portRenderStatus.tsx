'use client';

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

// THE PORT'S RENDER SIGNAL (Story MOTIR-4778 · Subtask MOTIR-5032).
//
// `design/work-items/design-notes.md` § The UNIVERSAL APPROVAL FRAME, *The
// states*, state `X`:
//
//   "`X` — the port failed, so there are NO verbs. You cannot approve what
//    cannot be shown."
//
// ⚠️ WHY A CHANNEL AND NOT A PROP. The frame takes its subject as an opaque
// `port: ReactNode` — that opacity is the whole point of a UNIVERSAL frame, and
// it is what lets a new gate kind supply a port without touching the control.
// The consequence is that the frame cannot INSPECT its own port: "did it
// render?" is not answerable from a React node. So the port TELLS it, through
// this context, and the frame does the gating.
//
// A PROP would have been the smaller change and it is the wrong one: a
// `portFailed` prop is something the CONSUMER passes, and a consumer that
// passes a verb set and forgets the prop ships a live Approve button over a
// blank box — the exact failure the design was re-cut to prevent. Reporting from
// the PORT SUBTREE means the component that actually knows is the component that
// says so, and no call site can forget on its behalf.
//
// ⚠️ SILENCE MEANS RENDERED, DELIBERATELY. A port that reports nothing is a
// STATIC subject — Markdown, a text body, a metadata block — which is shown by
// being present and has no failure mode to report. Only a port that CAN fail
// (a sandboxed frame fetching bytes over the network) participates. Defaulting
// the other way would empty band 3 for every existing consumer and every state
// MOTIR-4792 shipped, which is why `aggregatePortRenderStatus([])` is
// `'rendered'` rather than `'rendering'`.

/**
 * What a port can say about itself.
 *
 * `'rendering'` and `'failed'` BOTH withhold the verbs — you cannot approve what
 * is not yet on screen any more than you can approve what failed — but they are
 * distinct states because only one of them is `X`: `'rendering'` is transient
 * and says nothing, while `'failed'` owes the reader the copy and a next action.
 */
export type PortRenderStatus = 'rendering' | 'rendered' | 'failed';

/**
 * How a port reports. Keyed by the reporter's own id because a port may hold
 * SEVERAL failable subjects — `DesignResultPanel` renders one `MockFrame` per
 * published mock — and last-write-wins would let a second frame's success erase
 * a first frame's failure.
 */
export interface PortRenderReporter {
  /** `null` deregisters — the reporting subtree unmounted. */
  report(id: string, status: PortRenderStatus | null): void;
}

const PortRenderStatusContext = createContext<PortRenderReporter | null>(null);

export function PortRenderStatusProvider({
  reporter,
  children,
}: {
  reporter: PortRenderReporter;
  children: ReactNode;
}) {
  return (
    <PortRenderStatusContext.Provider value={reporter}>{children}</PortRenderStatusContext.Provider>
  );
}

/**
 * Declare THIS subtree's render status to the frame above it.
 *
 * Renders nothing and is inert outside a frame (the context is null), so a port
 * component stays usable on its own — `DesignResultPanel` still renders as a
 * plain read-only panel on a card with no gate, which is `DesignResultSection`'s
 * `if (!current) return port` path.
 */
export function useReportPortRenderStatus(status: PortRenderStatus): void {
  const reporter = useContext(PortRenderStatusContext);
  const id = useId();

  // Two effects rather than one with a cleanup, so a STATUS CHANGE does not
  // deregister-then-register: that churn is invisible in a batched commit but
  // would make the aggregate momentarily wrong if React ever split them.
  useEffect(() => {
    reporter?.report(id, status);
  }, [reporter, id, status]);

  useEffect(() => () => reporter?.report(id, null), [reporter, id]);
}

/**
 * The aggregate the frame gates on: any failure fails the port.
 *
 * ⚠️ ONE FAILED SUBJECT AMONG THREE IS A FAILED PORT. That is the conservative
 * reading and it is the design's: the claim is that you saw what you approved,
 * and a reader who saw two of three mocks did not. An aggregate that let a
 * majority carry it would put a live Approve button over a partially-invisible
 * subject, which is the same defect wearing a fraction.
 */
export function aggregatePortRenderStatus(statuses: Iterable<PortRenderStatus>): PortRenderStatus {
  let sawRendering = false;
  for (const status of statuses) {
    if (status === 'failed') return 'failed';
    if (status === 'rendering') sawRendering = true;
  }
  return sawRendering ? 'rendering' : 'rendered';
}

const NO_REPORTS: ReadonlyMap<string, PortRenderStatus> = new Map();

/**
 * The frame's half of the channel: a stable reporter plus the aggregate its
 * reports imply. Split out of the control so the aggregation is testable on its
 * own and so the control's own body stays about the three bands.
 */
export function usePortRenderStatus(): {
  reporter: PortRenderReporter;
  status: PortRenderStatus;
} {
  const [reports, setReports] = useState<ReadonlyMap<string, PortRenderStatus>>(NO_REPORTS);

  const reporter = useMemo<PortRenderReporter>(
    () => ({
      report(id, status) {
        setReports((prev) => {
          if (status === null) {
            if (!prev.has(id)) return prev;
            const next = new Map(prev);
            next.delete(id);
            return next;
          }
          // Returning `prev` unchanged on a repeat report is what keeps a port
          // that re-reports the same status in an effect from looping.
          if (prev.get(id) === status) return prev;
          const next = new Map(prev);
          next.set(id, status);
          return next;
        });
      },
    }),
    [],
  );

  return { reporter, status: aggregatePortRenderStatus(reports.values()) };
}
