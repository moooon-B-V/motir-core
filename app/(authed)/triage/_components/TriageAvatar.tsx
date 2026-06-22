import { cn } from '@/lib/utils/cn';

// The submitter avatar for the triage inbox (Subtask 6.11.6). The issue-cell
// `Avatar` is a dark-fill initial; the triage design-notes call for the
// name-hash TINTED avatar (a pastel background with `--el-text-strong` ink —
// AA-safe, finding #35), so this is the tiny local variant the spec allows.
// Decorative (`aria-hidden`); the caller renders the submitter name alongside
// for the accessible name. Circle → `rounded-full` (genuinely circular,
// style-independent).
//
// Routed through the DEDICATED `--el-avatar-*` ramp (MOTIR-1274 · 1266.3), the
// SAME family ProjectAvatar uses — so person + project avatars share one tunable
// token set instead of each pulling from the generic `--el-tint-*` pool. The
// array ORDER (and the hash) are kept verbatim so each name maps to the same
// pastel as before: `--el-avatar-*` defaults to its `--el-tint-*` value → zero
// visual change.
const TINTS = [
  'bg-(--el-avatar-mint)',
  'bg-(--el-avatar-sky)',
  'bg-(--el-avatar-lavender)',
  'bg-(--el-avatar-peach)',
  'bg-(--el-avatar-rose)',
  'bg-(--el-avatar-yellow)',
] as const;

function tintFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return TINTS[Math.abs(hash) % TINTS.length]!;
}

export interface TriageAvatarProps {
  name: string;
  /** `sm` = the queue-row size; `lg` = the detail attribution card. */
  size?: 'sm' | 'lg';
}

export function TriageAvatar({ name, size = 'sm' }: TriageAvatarProps) {
  const initial = (name.trim().charAt(0) || '?').toUpperCase();
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-(--el-text-strong)',
        tintFor(name),
        size === 'lg' ? 'h-10 w-10 text-sm' : 'h-[22px] w-[22px] text-[10px]',
      )}
      aria-hidden
    >
      {initial}
    </span>
  );
}
