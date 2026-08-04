'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Lock, MoveVertical } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { SettingsCard } from '@/components/settings/SettingsCard';
import { SwitchRow } from '@/components/settings/SwitchRow';
import type { ProjectStatusAutomationDto } from '@/lib/dto/projectStatusAutomation';

// StatusAutomationEditor (Story MOTIR-1615 · Subtask MOTIR-1622) — the two
// bidirectional status-derivation switches, per
// `design/projects/status-automation.mock.html` + design-notes.md §1–§7.
//
// PLACEMENT (design §1): a card at the TOP of the SHIPPED
// /settings/project/workflow page, above the transition-enforcement section —
// not a new settings page. These switches govern how a status move propagates
// along the project's workflow, and this page already hosts `workflowPolicyMode`,
// the other "how do status moves behave here" switch. So: no nav-registry entry,
// no new route, and the route↔registry totality test is untouched.
//
// SAVE MODEL — dirty state + a Save footer, optimistic-with-reconcile, mirroring
// the shipped `AiPlanningSettingsEditor`. The MOTIR-1622 card's prose said
// "PATCH on toggle"; the APPROVED design draws the footer and the shipped
// sibling pane works this way, so the design + shipped precedent win (and the
// card's real requirements still hold: the flip is optimistic, the success
// response IS the confirmation, and there is NO `router.refresh()` on the
// toggle's own value — CLAUDE.md § page state, where refreshing the cell causes
// the visible revert). Both switches sit under ONE footer because they are two
// halves of one decision — "how should status stay in step here" — unlike the
// AI pane's three independent cards.
//
// A pure client consumer of `PATCH /api/projects/[key]/status-automation`; it
// never touches the service layer. The server re-gates the write
// (`assertCanManage`), so `isAdmin` here only governs whether the edit
// affordances render — a non-admin still SEES the configuration (design §5,
// panel 3: disabled, never hidden, so a member learns why their items move on
// their own).

interface Working {
  rollup: boolean;
  cascade: boolean;
}

function toWorking(dto: ProjectStatusAutomationDto): Working {
  return { rollup: dto.autoRollupParentStatus, cascade: dto.autoCompleteChildrenOnParentDone };
}

export function StatusAutomationEditor({
  projectKey,
  projectName,
  settings,
  isAdmin,
}: {
  projectKey: string;
  projectName: string;
  settings: ProjectStatusAutomationDto;
  isAdmin: boolean;
}) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { toast } = useToast();

  // `committed` is the last-persisted state (the optimistic snapshot target);
  // `working` holds the in-flight edits. dirty = working ≠ committed.
  const [committed, setCommitted] = useState<Working>(() => toWorking(settings));
  const [working, setWorking] = useState<Working>(() => toWorking(settings));
  const [saving, setSaving] = useState(false);

  const dirty = working.rollup !== committed.rollup || working.cascade !== committed.cascade;
  const canSave = isAdmin && dirty && !saving;

  const reset = useCallback(() => setWorking(committed), [committed]);

  const save = useCallback(() => {
    if (!isAdmin) return;
    const prev = committed;
    const next = working;
    // Optimistic: the committed snapshot flips now; revert on the response.
    setCommitted(next);
    setSaving(true);
    void fetch(`/api/projects/${encodeURIComponent(projectKey)}/status-automation`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        autoRollupParentStatus: next.rollup,
        autoCompleteChildrenOnParentDone: next.cascade,
      }),
    })
      .then((res) => {
        setSaving(false);
        if (res.ok) {
          toast({
            variant: 'success',
            title: t('statusAutomation.savedTitle'),
            description: t('statusAutomation.savedDesc', { project: projectName }),
          });
          return;
        }
        setCommitted(prev);
        toast({
          variant: 'error',
          title: t('statusAutomation.errorTitle'),
          description: t('statusAutomation.saveError'),
        });
      })
      .catch(() => {
        setCommitted(prev);
        setSaving(false);
        toast({
          variant: 'error',
          title: t('statusAutomation.errorTitle'),
          description: t('statusAutomation.saveError'),
        });
      });
  }, [isAdmin, committed, working, projectKey, projectName, t, toast]);

  return (
    <SettingsCard
      testId="status-automation"
      icon={<MoveVertical className="size-[17px]" aria-hidden />}
      title={t('statusAutomation.title')}
      subtitle={t('statusAutomation.subtitle')}
      footer={
        isAdmin ? (
          <div className="bg-(--el-surface-soft) border-(--el-border-soft) flex items-center justify-end gap-2.5 border-t px-(--spacing-card-padding) py-3.5">
            <span
              className="text-(--el-text-muted) mr-auto text-xs"
              data-testid="status-automation-footer-hint"
            >
              {dirty ? t('statusAutomation.footer.dirtyHint') : null}
            </span>
            <Button variant="secondary" onClick={reset} disabled={!dirty || saving}>
              {tc('cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={save}
              loading={saving}
              disabled={!canSave}
              data-testid="status-automation-save"
            >
              {t('statusAutomation.footer.save')}
            </Button>
          </div>
        ) : (
          // Design §5 panel 3 — the shipped read-only band, in place of the save
          // footer. Stated reason, not a silently missing control.
          <div className="bg-(--el-surface-soft) border-(--el-border-soft) text-(--el-text-muted) flex items-center gap-2.5 border-t px-(--spacing-card-padding) py-3.5 text-xs">
            <Lock className="size-3.5 shrink-0" aria-hidden />
            {t('statusAutomation.lock')}
          </div>
        )
      }
    >
      <SwitchRow
        testId="status-automation-rollup"
        checked={working.rollup}
        onCheckedChange={(v) => setWorking((p) => ({ ...p, rollup: v }))}
        disabled={!isAdmin}
        label={t('statusAutomation.rollup.label')}
        hint={t('statusAutomation.rollup.hint')}
      >
        {/* The ladder read-out (design §4). "Rolls up parent status" does not
            tell an admin WHEN each rung fires, which is the one thing they need
            to predict the behaviour on their own board. A <dl> of three pairs —
            a table would over-structure it, and a new primitive for one read-out
            is the complexity the design system asks us not to add. */}
        <dl className="border-(--el-border) mt-2.5 grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-1 border-l pl-3 text-xs leading-relaxed">
          <dt className="font-semibold whitespace-nowrap text-(--el-text-secondary)">
            {t('statusAutomation.rollup.ladder.inProgressStatus')}
          </dt>
          <dd className="text-(--el-text-helper) m-0">
            {t('statusAutomation.rollup.ladder.inProgressWhen')}
          </dd>
          <dt className="font-semibold whitespace-nowrap text-(--el-text-secondary)">
            {t('statusAutomation.rollup.ladder.inReviewStatus')}
          </dt>
          <dd className="text-(--el-text-helper) m-0">
            {t('statusAutomation.rollup.ladder.inReviewWhen')}
          </dd>
          <dt className="font-semibold whitespace-nowrap text-(--el-text-secondary)">
            {t('statusAutomation.rollup.ladder.doneStatus')}
          </dt>
          <dd className="text-(--el-text-helper) m-0">
            {t('statusAutomation.rollup.ladder.doneWhen')}
          </dd>
        </dl>
      </SwitchRow>

      <SwitchRow
        testId="status-automation-cascade"
        checked={working.cascade}
        onCheckedChange={(v) => setWorking((p) => ({ ...p, cascade: v }))}
        disabled={!isAdmin}
        label={t('statusAutomation.cascade.label')}
        hint={
          working.cascade ? (
            // The consequence sentence is load-bearing, not decoration (design
            // §3): "children nobody has started yet" is the one fact that makes
            // this switch's risk legible, so it carries emphasis.
            t.rich('statusAutomation.cascade.hint', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })
          ) : (
            <>{t('statusAutomation.cascade.hintOff')}</>
          )
        }
      />
    </SettingsCard>
  );
}
