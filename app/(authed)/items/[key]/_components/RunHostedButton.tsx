'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import { Cloud } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { HostedRunCancel } from '@/app/(authed)/runs/_components/HostedRunCancel';
import { isLiveRun } from '@/lib/runs/timeline';
import { HostedModelPicker } from './HostedModelPicker';
import { HostedModelProvenance } from '@/components/hosted/HostedModelPicker';
import { provenanceFor } from '@/components/hosted/hostedModels';
import { useHostedRun } from './HostedRunProvider';

// THE RUN HOSTED DOOR — the Run section header's one control (Story MOTIR-683 ·
// MOTIR-691; `design/runs/design-notes.md` § The ACCESS PATH).
//
// The header holds exactly one thing at a time:
//
//   · ready, never run or last run ended → the picker + Run hosted
//     (Run hosted again once a hosted run has ended);
//   · not ready → the same door, DISABLED (its reason is a line in the body —
//     a door that disappears reads as a feature that does not exist);
//   · a HOSTED run is live → Cancel run;
//   · a LOCAL run is live → nothing: it runs on somebody's machine.
//
// It is offered on a leaf AND a parent card: a parent's hosted run works its
// children through the CLI in the container, exactly as a local scope run does.
//
// ⚠️ THE SOURCE LINE (MOTIR-6996; design § Run hosted — the picker says where its
// model came from). While the picker holds the card's RESOLVED model, the row's
// last child says why — its difficulty, a project override, or a parent's
// leaves. It goes when the person picks another model (F6), and comes back if
// they re-pick it. `items-start` keeps the button level with the trigger.

export function RunHostedButton() {
  const t = useTranslations('runs.hosted.door');
  const door = useHostedRun();
  const lineId = useId();
  if (!door) return null;

  const run = door.currentRun;
  if (run && isLiveRun(run.status)) {
    if (run.origin !== 'hosted') return null;
    return <HostedRunCancel runId={run.id} onCancelled={door.notifyRunsChanged} />;
  }
  // A died card is continued, not re-run (design § Continue hosted, C7): the server
  // refuses a fresh hosted run on it, so the header offers none.
  if (door.runDoorHidden) return null;

  const modelsReady = door.models.state === 'ok' && door.models.models.length > 0;
  const disabled = !door.ready || !modelsReady || door.starting || !door.selectedModel;
  const again = run?.origin === 'hosted';
  const provenance = provenanceFor(door.models, door.selectedModel);

  return (
    <div className="flex flex-wrap items-start gap-2" data-testid="run-hosted-door">
      <HostedModelPicker
        models={door.models}
        value={door.selectedModel}
        onChange={door.selectModel}
        disabled={!door.ready || door.starting}
        provenance={provenance}
        describedBy={lineId}
      />
      <Button
        type="button"
        variant="primary"
        size="sm"
        disabled={disabled}
        loading={door.starting}
        onClick={() => void door.start()}
        leftIcon={<Cloud className="size-3.5" aria-hidden="true" />}
        data-testid="run-hosted"
        // The anchor the design card's "Automatic re-run skipped" lines link to (MOTIR-702).
        id="run-hosted"
      >
        {door.starting ? t('starting') : again ? t('runAgain') : t('run')}
      </Button>
      <HostedModelProvenance provenance={provenance} id={lineId} />
    </div>
  );
}
