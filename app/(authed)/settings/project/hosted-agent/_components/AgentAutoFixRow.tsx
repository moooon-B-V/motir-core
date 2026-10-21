'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { SwitchRow } from '@/components/settings/SwitchRow';
import { useToast } from '@/components/ui/Toast';
import type { ProjectAgentAutoFixSettingsDto } from '@/lib/dto/projectAgentAutoFixSettings';

// AgentAutoFixRow (Story MOTIR-8981 · MOTIR-9060) — the one switch below the Hosted
// agent room's model card: "fix a red pull request in the work item's own agent".
//
// A client island over `GET / PATCH /api/projects/[key]/agent-auto-fix`, SEEDED with
// the value the page read on the server, so it has no loading face of its own. The
// switch commits at once (a save bar would show the setting on while nothing had
// recorded it): the press moves the switch and the row stops taking presses; a failed
// write returns it to the value it held and raises the room's own failure toast. The
// response DTO is the committed value — applied in place, never `router.refresh()`
// (CLAUDE.md § page state, case 1).

export function AgentAutoFixRow({
  projectKey,
  initial,
  canConfigure,
}: {
  projectKey: string;
  initial: boolean;
  canConfigure: boolean;
}) {
  const t = useTranslations('settings');
  const { toast } = useToast();
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);

  function flip(next: boolean) {
    if (!canConfigure || inFlight.current) return;
    inFlight.current = true;
    const prev = value;
    setValue(next);
    setSaving(true);
    const failed = () => {
      setValue(prev);
      inFlight.current = false;
      setSaving(false);
      toast({
        variant: 'error',
        title: t('hostedAgent.errorTitle'),
        description: t('hostedAgent.saveError'),
      });
    };
    void fetch(`/api/projects/${encodeURIComponent(projectKey)}/agent-auto-fix`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ agentAutoFixEnabled: next }),
    })
      .then(async (res) => {
        if (!res.ok) {
          failed();
          return;
        }
        const saved = (await res.json()) as ProjectAgentAutoFixSettingsDto;
        setValue(saved.agentAutoFixEnabled);
        inFlight.current = false;
        setSaving(false);
      })
      .catch(failed);
  }

  return (
    <Card>
      <SwitchRow
        testId="agent-auto-fix-switch"
        checked={value}
        onCheckedChange={flip}
        disabled={!canConfigure || saving}
        label={t('hostedAgent.autoFix.label')}
        hint={t('hostedAgent.autoFix.help')}
      />
    </Card>
  );
}
