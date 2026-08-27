'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Switch } from '@/components/ui/Switch';
import { Pill } from '@/components/ui/Pill';
import { useToast } from '@/components/ui/Toast';

// The require-2FA control (Story MOTIR-1215 · Subtask MOTIR-3646), built to
// `design/org-admin/security-policy.mock.html` panels 3–6 and 8.
//
// ⚠️ IT IS TIER-AGNOSTIC ON PURPOSE, AND THAT IS THE WHOLE REASON IT LIVES IN
// ITS OWN FILE. MOTIR-3647 mounts this SAME component at the workspace tier —
// at `/settings/workspace/security` and, below the workspace-tier reveal
// threshold, inside `WorkspaceFoldInSection` on this very page. So it imports no
// service, reads no cookie, and cannot name which tier it is rendering: every
// tier-varying string and the write itself arrive as props. A component that
// reached for the org internally would have to be rewritten one card later, and
// `tests/components/require-two-factor-card.test.tsx` asserts the import
// boundary rather than trusting this paragraph.
//
// ⚠️ THE SAVE IS ABSOLUTE, NEVER A TOGGLE. `onSave` takes the DESIRED value.
// A toggle is a read-derived write: two admins flipping at once both invert the
// value they read and the winner is whichever commit landed last — a policy
// nobody chose (`twoFactorPolicyService`'s own header carries the rule). There
// is deliberately no `onToggle` here and none in the action beneath it.

/** What a save answers with — the shape both tiers' Server Actions return. */
export interface RequireTwoFactorSaveResult {
  ok: boolean;
  error?: string;
}

export interface RequireTwoFactorCardProps {
  /** This tier's OWN column. Not the effective requirement — see `lockedBy`. */
  requiresTwoFactor: boolean;
  /**
   * The NAME of the organization mandating from above, or `null` when nothing
   * is. Non-null renders the locked state: the switch is `disabled` and a `Pill`
   * says who locked it.
   *
   * ⚠️ It is NOT `requiresTwoFactor === false`. A workspace can be locked while
   * its own column is already `true` — the design's panel 6, "on here AND above"
   * — and the two must stay separable, or turning the organization's policy off
   * would silently drop a requirement a workspace admin chose. MOTIR-3644 stores
   * the two operands rather than their OR precisely so this stays expressible.
   * At the ORGANIZATION tier this is always `null`: nothing sits above an org.
   */
  lockedBy: string | null;
  /** The card's body copy, resolved by the caller — it names the tier. */
  description: string;
  /** The label shown beside the switch when the requirement is ON at this tier. */
  stateOnLabel: string;
  /**
   * Whether the actor may OPERATE the control. `false` renders it READ-ONLY —
   * the switch shows the current value and is `disabled` — never absent and
   * never a refusal panel.
   *
   * ⚠️ READ-ONLY IS NOT REFUSAL, and the distinction is load-bearing (MOTIR-3647).
   * A refusal is a decision about the SURFACE and belongs to the route: the org
   * pane refuses a non-admin whole, the way `members/` and `usage/` do. This
   * control is instead reached by any workspace member through
   * `WorkspaceFoldInSection`, which renders for every member so that a plain one
   * can still reach **Leave workspace** (MOTIR-3519). Hiding the setting there
   * would tell a member nothing about why they are being asked to enrol; making
   * it operable would let a `viewer` change a security policy. Read-only is the
   * third thing, and it is the right one.
   *
   * The ORG pane never passes `false` — its route has already refused by then.
   */
  canManage: boolean;
  /** The tier's own name, for any copy that has to say whose setting this is. */
  tierName: string;
  /** The absolute write. Resolved by the caller to its own tier's action. */
  onSave: (next: boolean) => Promise<RequireTwoFactorSaveResult>;
}

export function RequireTwoFactorCard({
  requiresTwoFactor,
  lockedBy,
  description,
  stateOnLabel,
  canManage,
  tierName,
  onSave,
}: RequireTwoFactorCardProps) {
  const t = useTranslations('orgAdmin.security');
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(requiresTwoFactor);
  const [isPending, startTransition] = useTransition();
  // The server value is the truth; re-sync when a refresh re-renders us with a
  // new one (a second admin's flip, or our own action's revalidate).
  const lastServerValue = useRef(requiresTwoFactor);
  useEffect(() => {
    if (lastServerValue.current === requiresTwoFactor) return;
    lastServerValue.current = requiresTwoFactor;
    setEnabled(requiresTwoFactor);
  }, [requiresTwoFactor]);

  function save(next: boolean) {
    setEnabled(next); // optimistic — the AcceptanceVideoCard shape
    startTransition(async () => {
      const result = await onSave(next);
      if (result.ok) {
        toast({ variant: 'success', title: t('savedToast') });
        return;
      }
      setEnabled(!next); // revert the optimistic flip
      toast({ variant: 'error', title: t('saveErrorTitle'), description: result.error });
    });
  }

  const locked = lockedBy !== null;
  // Both reasons the switch cannot be operated, kept apart because they say
  // different things to the reader: `locked` means a HIGHER TIER decided this,
  // and gets the Pill plus the explanation; `!canManage` means YOU may not
  // change it, and gets a quiet read-only note.
  const inoperable = locked || !canManage;

  return (
    <Card
      id="require-two-factor"
      header={
        <div>
          <h2 className="font-sans text-base font-semibold text-(--el-text)">{t('cardTitle')}</h2>
          <p className="text-(--el-text-muted) font-sans text-sm">{description}</p>
        </div>
      }
    >
      <div className="flex items-center justify-between gap-4">
        {locked ? (
          // ⚠️ NOT `--el-danger`, and the design says so outright: nothing has
          // gone wrong here, something was decided elsewhere. `info` puts the
          // hue in the tint BACKGROUND with strong ink, which is what keeps it
          // AA in both themes.
          <Pill severity="info">
            <Lock className="h-3 w-3" aria-hidden />
            {t('lockedBy', { org: lockedBy })}
          </Pill>
        ) : (
          <span
            className={
              enabled
                ? 'font-sans text-sm font-medium text-(--el-text)'
                : 'text-(--el-text-secondary) font-sans text-sm'
            }
          >
            {enabled ? stateOnLabel : t('stateOff')}
          </span>
        )}
        <Switch
          checked={enabled || locked}
          onCheckedChange={save}
          // ⚠️ `disabled`, NOT absent. A missing control tells an admin nothing,
          // and a live one that silently does nothing is worse than both.
          disabled={inoperable || isPending}
          aria-label={t('cardTitle')}
        />
      </div>
      {locked ? (
        <p className="text-(--el-text-secondary) mt-(--spacing-md) font-sans text-sm">
          {requiresTwoFactor
            ? t('lockedNoteBoth', { org: lockedBy })
            : t('lockedNoteAbove', { org: lockedBy })}
        </p>
      ) : null}
      {!canManage && !locked ? (
        <p className="text-(--el-text-secondary) mt-(--spacing-md) font-sans text-sm">
          {t('readOnlyNote', { tier: tierName })}
        </p>
      ) : null}
    </Card>
  );
}
