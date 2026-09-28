'use client';

import { useTranslations } from 'next-intl';
import { Cloud } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { HostedRunCancel } from '@/app/(authed)/runs/_components/HostedRunCancel';
import { isLiveRun } from '@/lib/runs/timeline';
import { HostedModelPicker } from './HostedModelPicker';
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

export function RunHostedButton() {
  const t = useTranslations('runs.hosted.door');
  const door = useHostedRun();
  if (!door) return null;

  const run = door.currentRun;
  if (run && isLiveRun(run.status)) {
    if (run.origin !== 'hosted') return null;
    return <HostedRunCancel runId={run.id} onCancelled={door.notifyRunsChanged} />;
  }

  const modelsReady = door.models.state === 'ok' && door.models.models.length > 0;
  const disabled = !door.ready || !modelsReady || door.starting || !door.selectedModel;
  const again = run?.origin === 'hosted';

  return (
    <div className="flex items-center gap-2" data-testid="run-hosted-door">
      <HostedModelPicker
        models={door.models}
        value={door.selectedModel}
        onChange={door.selectModel}
        disabled={!door.ready || door.starting}
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
      >
        {door.starting ? t('starting') : again ? t('runAgain') : t('run')}
      </Button>
    </div>
  );
}
