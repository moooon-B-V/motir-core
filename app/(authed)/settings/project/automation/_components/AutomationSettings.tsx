'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import type { AutomationRuleDto, AutomationRuleSummaryDto } from '@/lib/dto/automationRules';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { LabelDto } from '@/lib/dto/labels';
import { AutomationRuleList } from './AutomationRuleList';
import { AutomationRuleEditor } from './AutomationRuleEditor';
import { AutomationRuleAuditLog } from './AutomationRuleAuditLog';

// The automation settings surface root (Story 6.6 · Subtask 6.6.5) — switches
// between the rule LIST and the when/if/then EDITOR (the editor is a full panel,
// per design/projects/automation.mock.html, not a modal), and owns the list-
// level mutations (enable/disable + delete) with optimistic state + revert. The
// editor reads/writes through the 6.6.1 routes; this component reconciles the
// returned DTO into the list. Admin-gating is enforced server-side (the page +
// every route) — this client never renders for a non-admin.

type Mode =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'edit'; rule: AutomationRuleSummaryDto }
  | { kind: 'log'; rule: AutomationRuleSummaryDto };

export interface AutomationSettingsProps {
  projectKey: string;
  currentUserName: string;
  initialRules: AutomationRuleSummaryDto[];
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  referencedLabels: LabelDto[];
}

export function AutomationSettings({
  projectKey,
  currentUserName,
  initialRules,
  statuses,
  members,
  sprints,
  customFields,
  components,
  referencedLabels,
}: AutomationSettingsProps) {
  const t = useTranslations('settings.automation');
  const { toast } = useToast();

  const [rules, setRules] = useState<AutomationRuleSummaryDto[]>(initialRules);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [deleting, setDeleting] = useState<AutomationRuleSummaryDto | null>(null);

  const base = `/api/projects/${encodeURIComponent(projectKey)}/automation-rules`;

  // The single-rule routes (enable toggle, content PATCH) return the bare
  // `AutomationRuleDto` (no last-run join). Merge it back into the summary row,
  // preserving the existing `lastRun` (the run history doesn't change on an
  // enable / content edit).
  function replaceRule(next: AutomationRuleDto) {
    setRules((cur) => cur.map((r) => (r.id === next.id ? { ...next, lastRun: r.lastRun } : r)));
  }

  async function toggleEnabled(rule: AutomationRuleSummaryDto) {
    const nextEnabled = !rule.enabled;
    const snapshot = rules;
    // Optimistic: flip locally (and, when enabling, clear the failure tally the
    // server resets) so the Switch + banner respond immediately.
    setRules((cur) =>
      cur.map((r) =>
        r.id === rule.id
          ? {
              ...r,
              enabled: nextEnabled,
              consecutiveFailureCount: nextEnabled ? 0 : r.consecutiveFailureCount,
            }
          : r,
      ),
    );
    try {
      const res = await fetch(`${base}/${encodeURIComponent(rule.id)}/enabled`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (!res.ok) throw new Error('toggle');
      const data = (await res.json()) as { rule: AutomationRuleDto };
      replaceRule(data.rule);
    } catch {
      setRules(snapshot);
      toast({
        variant: 'error',
        title: t('toast.errorTitle'),
        description: t('toast.toggleError'),
      });
    }
  }

  async function confirmDelete(rule: AutomationRuleSummaryDto) {
    const snapshot = rules;
    setRules((cur) => cur.filter((r) => r.id !== rule.id));
    setDeleting(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(rule.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete');
      toast({ variant: 'success', title: t('toast.deleted', { name: rule.name }) });
    } catch {
      setRules(snapshot);
      toast({
        variant: 'error',
        title: t('toast.errorTitle'),
        description: t('toast.deleteError'),
      });
    }
  }

  function handleSaved(saved: AutomationRuleDto) {
    setRules((cur) => {
      const existing = cur.find((r) => r.id === saved.id);
      // A content edit keeps the rule's run history; a create has none yet.
      const next: AutomationRuleSummaryDto = { ...saved, lastRun: existing?.lastRun ?? null };
      return existing ? cur.map((r) => (r.id === saved.id ? next : r)) : [next, ...cur];
    });
    const created = mode.kind === 'create';
    setMode({ kind: 'list' });
    toast({
      variant: 'success',
      title: created
        ? t('toast.created', { name: saved.name })
        : t('toast.saved', { name: saved.name }),
    });
  }

  if (mode.kind === 'log') {
    return (
      <AutomationRuleAuditLog
        projectKey={projectKey}
        ruleId={mode.rule.id}
        ruleName={mode.rule.name}
        onBack={() => setMode({ kind: 'list' })}
      />
    );
  }

  if (mode.kind !== 'list') {
    const editingRule = mode.kind === 'edit' ? mode.rule : null;
    return (
      <AutomationRuleEditor
        rule={editingRule}
        ownerName={editingRule ? editingRule.owner.name : currentUserName}
        projectKey={projectKey}
        statuses={statuses}
        members={members}
        sprints={sprints}
        customFields={customFields}
        components={components}
        referencedLabels={referencedLabels}
        onCancel={() => setMode({ kind: 'list' })}
        onSaved={handleSaved}
        onReEnable={editingRule ? () => void toggleEnabled(editingRule) : undefined}
      />
    );
  }

  return (
    <>
      <AutomationRuleList
        rules={rules}
        onCreate={() => setMode({ kind: 'create' })}
        onEdit={(rule) => setMode({ kind: 'edit', rule })}
        onViewLog={(rule) => setMode({ kind: 'log', rule })}
        onToggleEnabled={(rule) => void toggleEnabled(rule)}
        onDelete={(rule) => setDeleting(rule)}
      />
      <DeleteRuleModal
        rule={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onConfirm={confirmDelete}
      />
    </>
  );
}

function DeleteRuleModal({
  rule,
  onOpenChange,
  onConfirm,
}: {
  rule: AutomationRuleSummaryDto | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (rule: AutomationRuleSummaryDto) => void;
}) {
  const t = useTranslations('settings.automation.delete');
  const tc = useTranslations('common');
  if (!rule) return null;

  return (
    <Modal open onOpenChange={onOpenChange} size="md">
      <div className="mb-(--spacing-md) flex items-start gap-3">
        <span
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-full"
          style={{ backgroundColor: 'var(--el-tint-rose)' }}
        >
          <TriangleAlert className="size-5" style={{ color: 'var(--el-danger)' }} aria-hidden />
        </span>
        <div>
          <h2 className="font-serif text-xl font-semibold text-(--el-text)">
            {t('title', { name: rule.name })}
          </h2>
          <p className="mt-1 font-sans text-sm text-(--el-text-muted)">{t('body')}</p>
        </div>
      </div>
      <Modal.Footer>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button variant="danger" onClick={() => onConfirm(rule)}>
          {t('confirm')}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
