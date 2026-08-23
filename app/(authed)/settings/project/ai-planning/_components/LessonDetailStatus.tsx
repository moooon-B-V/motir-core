'use client';

import { useState, type ReactNode } from 'react';
import type { ProjectLessonDTO } from '@/lib/dto/projectLessons';
import { NotAppliedBadge } from './LessonBadges';
import { LessonApplyControl, type LessonApplyCopy } from './LessonApplyControl';

// THE DETAIL VIEW'S LIVE-STATE REGION (Subtask MOTIR-3346) — the §L7 status
// callout, the not-applied badge, and the action, as ONE client island.
//
// ⚠️ WHY THEY ARE ONE COMPONENT. All three render the SAME fact — is Motir
// applying this lesson — and the page-state contract says that fact comes from
// the mutation RESPONSE for the surface that was acted on. Leave the callout on
// the server and it keeps saying "Motir is applying this" under a button that
// now reads "Apply again", until something refreshes it; and the only thing that
// could refresh it is the `router.refresh()` the contract forbids here, which
// would race the write and revert the row.
//
// So the state lives here, the control reports back through `onApplied`, and the
// server's copy of it is never consulted again after mount. The count line
// elsewhere on the AI-planning surface is still server-rendered and still
// refreshed — that is the OTHER half of the contract, and the control does it.

export function LessonDetailStatus({
  lesson,
  projectKey,
  copy,
  retireLabel,
  applyingCallout,
  notAppliedLabel,
  notRecurredLabel,
}: {
  lesson: ProjectLessonDTO;
  projectKey: string;
  copy: LessonApplyCopy;
  retireLabel: string;
  /** The §L7 callout, rendered by the server so its copy stays with the page. */
  applyingCallout: ReactNode;
  /** Both badge labels, resolved — never a function (see `LessonApplyCopy`). */
  notAppliedLabel: string;
  notRecurredLabel: string;
}) {
  const [state, setState] = useState(lesson);

  return (
    <div className="flex flex-col gap-4">
      {state.injectionBlock === null ? (
        applyingCallout
      ) : (
        <div data-testid="lesson-not-applied">
          <NotAppliedBadge
            block={state.injectionBlock}
            label={state.injectionBlock === 'disabled' ? notAppliedLabel : notRecurredLabel}
          />
        </div>
      )}
      <div data-testid="lesson-detail-action" className="flex justify-start">
        <LessonApplyControl
          lesson={state}
          projectKey={projectKey}
          copy={copy}
          retireLabel={retireLabel}
          showBadge={false}
          onApplied={setState}
        />
      </div>
    </div>
  );
}
