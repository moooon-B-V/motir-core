'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowUpRight, ChevronRight, Inbox, Calendar, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Popover } from '@/components/ui/Popover';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { listCandidateParentsAction } from '@/app/(authed)/items/actions';
import type { SprintDto } from '@/lib/dto/sprints';

// The Promote picker (Subtask 6.11.6, design panel 1b) — a Popover offering the
// four promote targets (Backlog / Active sprint / Under an epic / Under a story)
// + a position-in-backlog chooser. The chosen target maps to the
// `POST .../promote` body: `parentId` for epic/story, `sprintId` for sprint,
// neither for backlog. Position "Top" / "Bottom" rides as `placement` (the
// service appends at the bottom of the destination scope by default — see the
// PR note on Top).

export type PromoteTarget =
  | { kind: 'backlog' }
  | { kind: 'sprint'; sprintId: string }
  | { kind: 'parent'; parentId: string };

export interface PromotePopoverProps {
  busy: boolean;
  onPromote: (target: PromoteTarget, placement: 'top' | 'bottom') => void;
}

type Step = 'targets' | 'sprint' | 'epic' | 'story';

export function PromotePopover({ busy, onPromote }: PromotePopoverProps) {
  const t = useTranslations('triage');
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('targets');
  const [placement, setPlacement] = useState<'top' | 'bottom'>('bottom');

  const [sprints, setSprints] = useState<SprintDto[] | null>(null);
  const [parents, setParents] = useState<{
    epic: ComboboxOption<string>[];
    story: ComboboxOption<string>[];
  }>({
    epic: [],
    story: [],
  });
  const [parentValue, setParentValue] = useState<string | null>(null);
  const [sprintValue, setSprintValue] = useState<string | null>(null);

  // Reset to the target list each time the popover closes (no effect — the
  // open-state callback owns the reset, avoiding a cascading setState-in-effect).
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setStep('targets');
      setParentValue(null);
      setSprintValue(null);
    }
  }

  async function goToSprint() {
    setStep('sprint');
    if (sprints === null) {
      const res = await fetch('/api/sprints');
      if (res.ok) {
        const data = (await res.json()) as { sprints: SprintDto[] };
        setSprints(data.sprints.filter((s) => s.state === 'active'));
      } else {
        setSprints([]);
      }
    }
  }

  async function goToParent(kind: 'epic' | 'story') {
    setStep(kind);
    if (parents[kind].length === 0) {
      const res = await listCandidateParentsAction(kind === 'epic' ? 'story' : 'task');
      // Epics hold stories; stories hold tasks/bugs. The promote targets here
      // are "parent under an epic" / "parent under a story", so we list epics
      // (legal parents of a story) and stories (legal parents of a task/bug).
      const candidates = res.ok ? res.candidates : [];
      const filtered = candidates.filter((c) => c.kind === kind);
      setParents((prev) => ({
        ...prev,
        [kind]: filtered.map((c) => ({
          value: c.id,
          label: c.title,
          secondary: c.identifier,
          keywords: c.identifier,
          icon: <IssueTypeIcon type={c.kind} className="h-4 w-4" />,
        })),
      }));
    }
  }

  const sprintOptions: ComboboxOption<string>[] = (sprints ?? []).map((s) => ({
    value: s.id,
    label: s.name,
    secondary: s.goal ?? undefined,
  }));

  const positionOptions: ComboboxOption<'top' | 'bottom'>[] = [
    { value: 'top', label: t('promote.positionTop') },
    { value: 'bottom', label: t('promote.positionBottom') },
  ];

  function targetRow(
    icon: React.ReactNode,
    label: string,
    sub: string,
    onClick: () => void,
    chevron: boolean,
  ) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-3 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left transition-colors hover:bg-(--el-surface)"
      >
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{icon}</span>
        <span className="flex flex-1 flex-col">
          <span className="text-sm font-medium text-(--el-text)">{label}</span>
          <span className="text-xs text-(--el-text-muted)">{sub}</span>
        </span>
        {chevron ? <ChevronRight className="h-4 w-4 text-(--el-text-faint)" aria-hidden /> : null}
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <Button variant="secondary" size="sm" leftIcon={<ArrowUpRight className="h-4 w-4" />}>
          {t('actions.promote')}
        </Button>
      </Popover.Trigger>
      <Popover.Content align="start" width={320} className="p-2" overflowVisible>
        {step === 'targets' ? (
          <div className="flex flex-col gap-1">
            <p className="px-(--spacing-control-x) pb-1 pt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-(--el-text-faint)">
              {t('promote.heading')}
            </p>
            {targetRow(
              <Inbox className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />,
              t('promote.backlog'),
              t('promote.backlogSub'),
              () => onPromote({ kind: 'backlog' }, placement),
              false,
            )}
            {targetRow(
              <Calendar className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />,
              t('promote.sprint'),
              t('promote.sprintSub'),
              goToSprint,
              true,
            )}
            {targetRow(
              <IssueTypeIcon type="epic" className="h-4 w-4" />,
              t('promote.epic'),
              t('promote.pickEpic'),
              () => goToParent('epic'),
              true,
            )}
            {targetRow(
              <IssueTypeIcon type="story" className="h-4 w-4" />,
              t('promote.story'),
              t('promote.pickStory'),
              () => goToParent('story'),
              true,
            )}
            <div className="my-1 border-t border-(--el-border)" />
            <div className="px-(--spacing-control-x) pb-1">
              <Combobox
                options={positionOptions}
                value={placement}
                onChange={(v) => setPlacement(v)}
                label={t('promote.position')}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 p-1">
            <button
              type="button"
              onClick={() => setStep('targets')}
              className="inline-flex items-center gap-1 self-start text-xs text-(--el-link)"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
              {t('promote.back')}
            </button>
            {step === 'sprint' ? (
              <>
                <Combobox
                  options={sprintOptions}
                  value={sprintValue}
                  onChange={(v) => setSprintValue(v)}
                  label={t('promote.pickSprint')}
                  searchable
                  searchPlaceholder={t('promote.pickSearch')}
                  emptyText={t('promote.pickSprintEmpty')}
                  loading={sprints === null}
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!sprintValue}
                  loading={busy}
                  onClick={() =>
                    sprintValue && onPromote({ kind: 'sprint', sprintId: sprintValue }, placement)
                  }
                >
                  {t('promote.confirm')}
                </Button>
              </>
            ) : (
              <>
                <Combobox
                  options={parents[step]}
                  value={parentValue}
                  onChange={(v) => setParentValue(v)}
                  label={step === 'epic' ? t('promote.pickEpic') : t('promote.pickStory')}
                  searchable
                  searchPlaceholder={t('promote.pickSearch')}
                  emptyText={
                    step === 'epic' ? t('promote.pickEpicEmpty') : t('promote.pickStoryEmpty')
                  }
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!parentValue}
                  loading={busy}
                  onClick={() =>
                    parentValue && onPromote({ kind: 'parent', parentId: parentValue }, placement)
                  }
                >
                  {t('promote.confirm')}
                </Button>
              </>
            )}
          </div>
        )}
      </Popover.Content>
    </Popover>
  );
}
