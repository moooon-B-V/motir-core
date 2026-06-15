'use client';

import { type ReactNode, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Check,
  Eye,
  Hash,
  History,
  Image as ImageIcon,
  Key,
  Loader2,
  Shield,
  Type,
  Unlink,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Pill } from '@/components/ui/Pill';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useToast } from '@/components/ui/Toast';
import { ProjectAvatar } from '../../../_components/ProjectAvatar';
import { ArchiveProjectCard } from './ArchiveProjectCard';
import { AvatarPicker } from './AvatarPicker';
import { ChangeKeyModal } from './ChangeKeyModal';
import { ReleaseKeyModal } from './ReleaseKeyModal';
import { updateProjectDetailsAction } from '../actions';

// The editable Details landing body (Story 6.8 · Subtask 6.8.4) — grows the
// 6.5.3 read-only identity card into the editable surface, per
// `design/projects/details.mock.html`. Name + avatar batch through ONE save bar
// (`updateDetails`); the KEY change is its own guarded modal (re-keying every
// issue is too consequential to fold into a generic "Save changes"); Previous
// keys list the retired aliases with a release-with-confirm.
//
// Role split (the 6.4.6 gating grammar): a non-admin member sees the values but
// NO controls — no save bar, no Change key / Change avatar, no Previous keys, no
// Danger zone — and the `Read-only` pill replaces `Admin`. The hide is
// presentation; the 6.8.1 PATCH/DELETE reject a non-admin server-side too.

export interface PreviousKeyView {
  identifier: string;
  /** The retired date, pre-formatted in the active locale by the server page. */
  retiredLabel: string;
}

export interface ProjectDetailsCardProps {
  projectId: string;
  projectName: string;
  projectIdentifier: string;
  avatarIcon: string | null;
  avatarColor: string | null;
  previousKeys: PreviousKeyView[];
  /** Project admin (or workspace owner/admin) — gates every editing affordance. */
  canManage: boolean;
}

export function ProjectDetailsCard({
  projectId,
  projectName,
  projectIdentifier,
  avatarIcon,
  avatarColor,
  previousKeys,
  canManage,
}: ProjectDetailsCardProps) {
  const td = useTranslations('settings.details');

  if (!canManage) {
    return (
      <Card header={<CardHead canManage={false} t={td} />}>
        <dl className="flex flex-col">
          <Field
            icon={<ImageIcon className="h-[15px] w-[15px]" aria-hidden />}
            label={td('fieldAvatar')}
          >
            <ProjectAvatar
              icon={avatarIcon}
              color={avatarColor}
              identifier={projectIdentifier}
              size={52}
            />
          </Field>
          <Field icon={<Type className="h-[15px] w-[15px]" aria-hidden />} label={td('fieldName')}>
            <span className="font-sans text-[13.5px] font-medium text-(--el-text)">
              {projectName}
            </span>
          </Field>
          <Field icon={<Hash className="h-[15px] w-[15px]" aria-hidden />} label={td('fieldKey')}>
            <KeyValue>{projectIdentifier}</KeyValue>
          </Field>
        </dl>
      </Card>
    );
  }

  return (
    <EditableDetails
      projectId={projectId}
      projectName={projectName}
      projectIdentifier={projectIdentifier}
      avatarIcon={avatarIcon}
      avatarColor={avatarColor}
      previousKeys={previousKeys}
    />
  );
}

function EditableDetails({
  projectId,
  projectName,
  projectIdentifier,
  avatarIcon,
  avatarColor,
  previousKeys,
}: Omit<ProjectDetailsCardProps, 'canManage'>) {
  const td = useTranslations('settings.details');
  const tc = useTranslations('common');
  const router = useRouter();
  const { toast } = useToast();

  // Editable form state + a saved baseline (the dirty comparison). The KEY +
  // previous-keys are read straight from props — their mutations are their own
  // modal flows that `router.refresh()` to reconcile the whole app.
  const [name, setName] = useState(projectName);
  const [icon, setIcon] = useState<string | null>(avatarIcon);
  const [color, setColor] = useState<string | null>(avatarColor);
  const [saved, setSaved] = useState({ name: projectName, icon: avatarIcon, color: avatarColor });
  const [justSaved, setJustSaved] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const trimmedName = name.trim();
  const dirty = trimmedName !== saved.name || icon !== saved.icon || color !== saved.color;
  const canSave = dirty && trimmedName.length > 0 && !isPending;

  function handleCancel() {
    setName(saved.name);
    setIcon(saved.icon);
    setColor(saved.color);
    setJustSaved(false);
  }

  function handleSave() {
    if (!canSave) return;
    startTransition(async () => {
      const result = await updateProjectDetailsAction({
        name: trimmedName,
        avatarIcon: icon,
        avatarColor: color,
      });
      if (result.ok) {
        setSaved({ name: trimmedName, icon, color });
        setName(trimmedName);
        setJustSaved(true);
        router.refresh();
        // Clear the transient "Saved" affordance after a beat (a callback, not
        // a useEffect — the React-19 set-state-in-effect lint rule).
        setTimeout(() => setJustSaved(false), 2500);
      } else {
        toast({ variant: 'error', title: td('saveErrorTitle') });
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* p-0 on Card lets the save-bar footer's border-t extend edge-to-edge; body + header re-pad themselves. */}
      <Card
        header={
          <div className="px-(--spacing-card-padding) pt-(--spacing-card-padding)">
            <CardHead canManage t={td} />
          </div>
        }
        className="p-0"
      >
        <div className="flex flex-col p-(--spacing-card-padding)">
          {/* Avatar */}
          <FieldStack
            icon={<ImageIcon className="h-[15px] w-[15px]" aria-hidden />}
            label={td('fieldAvatar')}
            help={td('avatarHelp')}
          >
            <AvatarPicker
              icon={icon}
              color={color}
              identifier={projectIdentifier}
              disabled={isPending}
              onChange={({ icon: nextIcon, color: nextColor }) => {
                setJustSaved(false);
                setIcon(nextIcon);
                setColor(nextColor);
              }}
            />
          </FieldStack>

          {/* Name */}
          <FieldStack
            icon={<Type className="h-[15px] w-[15px]" aria-hidden />}
            label={td('fieldName')}
            help={td('nameHelp')}
          >
            <Input
              value={name}
              onChange={(e) => {
                setJustSaved(false);
                setName(e.target.value);
              }}
              disabled={isPending}
              aria-label={td('fieldName')}
            />
          </FieldStack>

          {/* Key (read-only value + guarded change affordance) */}
          <FieldStack
            icon={<Hash className="h-[15px] w-[15px]" aria-hidden />}
            label={td('fieldKey')}
            help={td('keyHelp', { ident: projectIdentifier })}
          >
            <div className="flex items-center gap-2">
              <KeyValue>{projectIdentifier}</KeyValue>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={<Key className="h-4 w-4" />}
                onClick={() => setKeyOpen(true)}
                disabled={isPending}
              >
                {td('changeKey')}
              </Button>
            </div>
          </FieldStack>

          {/* Previous keys — present only when at least one key has been retired */}
          {previousKeys.length > 0 ? (
            <FieldStack
              icon={<History className="h-[15px] w-[15px]" aria-hidden />}
              label={td('prevKeysLabel')}
              help={td('prevKeysHelp', { ident: projectIdentifier })}
            >
              <ul className="flex flex-col gap-1.5">
                {previousKeys.map((pk) => (
                  <li key={pk.identifier} className="flex items-center gap-2.5">
                    <span
                      aria-hidden
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-control) bg-(--el-surface) text-(--el-text-muted)"
                    >
                      <Key className="h-[13px] w-[13px]" />
                    </span>
                    <span className="font-mono text-[12.5px] font-medium text-(--el-text)">
                      {pk.identifier}
                    </span>
                    <span className="font-sans text-xs text-(--el-text-muted)">
                      {td('prevKeyRetired', { date: pk.retiredLabel })}
                    </span>
                    <span className="flex-1" />
                    <Button
                      variant="ghost"
                      size="sm"
                      leftIcon={<Unlink className="h-4 w-4" />}
                      onClick={() => setReleasing(pk.identifier)}
                      disabled={isPending}
                    >
                      {td('release')}
                    </Button>
                  </li>
                ))}
              </ul>
            </FieldStack>
          ) : null}
        </div>

        {/* Save bar — the card footer action row */}
        <div className="flex items-center gap-3 border-t border-(--el-border-soft) px-(--spacing-card-padding) py-3">
          <SaveStatus saving={isPending} saved={justSaved} dirty={dirty} td={td} />
          <span className="flex-1" />
          <Button variant="ghost" onClick={handleCancel} disabled={!dirty || isPending}>
            {tc('cancel')}
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave} loading={isPending}>
            {td('saveButton')}
          </Button>
        </div>
      </Card>

      <ArchiveProjectCard
        projectId={projectId}
        projectName={projectName}
        projectIdentifier={projectIdentifier}
      />

      <ChangeKeyModal
        open={keyOpen}
        onOpenChange={setKeyOpen}
        currentKey={projectIdentifier}
        projectName={projectName}
      />
      <ReleaseKeyModal
        open={releasing !== null}
        onOpenChange={(o) => !o && setReleasing(null)}
        alias={releasing ?? ''}
      />
    </div>
  );
}

// ── presentational helpers ───────────────────────────────────────────────────

function CardHead({ canManage, t }: { canManage: boolean; t: (k: string) => string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('cardTitle')}</h2>
      {canManage ? (
        <Pill memberRole="admin">
          <Shield className="h-3.5 w-3.5" aria-hidden />
          {t('roleAdmin')}
        </Pill>
      ) : (
        <Pill memberRole="viewer">
          <Eye className="h-3.5 w-3.5" aria-hidden />
          {t('roleReadOnly')}
        </Pill>
      )}
    </div>
  );
}

function SaveStatus({
  saving,
  saved,
  dirty,
  td,
}: {
  saving: boolean;
  saved: boolean;
  dirty: boolean;
  td: (k: string) => string;
}) {
  if (saving) {
    return (
      <span
        role="status"
        className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-muted)"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        {td('saveSaving')}
      </span>
    );
  }
  if (saved) {
    return (
      <span
        role="status"
        className="flex items-center gap-1.5 font-sans text-xs font-medium text-(--el-success)"
      >
        <Check className="h-3.5 w-3.5" aria-hidden />
        {td('saveSaved')}
      </span>
    );
  }
  if (dirty) {
    return (
      <span className="flex items-center gap-1.5 font-sans text-xs text-(--el-text-secondary)">
        <span className="h-2 w-2 rounded-full bg-(--el-warning)" aria-hidden />
        {td('saveDirty')}
      </span>
    );
  }
  return null;
}

// A read-only identity row (label cell + value cell) inside a <dl>.
function Field({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 border-b border-(--el-border-soft) py-3.5 last:border-b-0">
      <dt className="flex w-[132px] flex-none items-center gap-2 font-sans text-[12.5px] text-(--el-text-muted)">
        {icon}
        {label}
      </dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

// A stacked editable field: label row on top, control below, optional help.
function FieldStack({
  icon,
  label,
  help,
  children,
}: {
  icon: ReactNode;
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-b border-(--el-border-soft) py-4 last:border-b-0">
      <span className="flex items-center gap-2 font-sans text-[12.5px] font-medium text-(--el-text-muted)">
        {icon}
        {label}
      </span>
      {children}
      {help ? (
        <p className="font-sans text-xs leading-relaxed text-(--el-text-muted)">{help}</p>
      ) : null}
    </div>
  );
}

function KeyValue({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-(--radius-control) bg-(--el-surface) px-2 py-1 font-mono text-[12.5px] font-medium text-(--el-text)">
      {children}
    </span>
  );
}
