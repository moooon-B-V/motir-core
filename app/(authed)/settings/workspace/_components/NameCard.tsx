'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/ui/Toast';
import { renameWorkspaceAction, type ActionResult } from '../actions';

export function NameCard({ initialName }: { initialName: string }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { toast } = useToast();
  const [name, setName] = useState(initialName);
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(
    renameWorkspaceAction,
    { ok: true },
  );
  // Only toast on a real submit result, not the initial { ok: true } seed.
  const submitted = useRef(false);

  useEffect(() => {
    if (!submitted.current) return;
    if (state.ok) {
      toast({ variant: 'success', title: t('name.renamedToast') });
    } else if (state.error) {
      toast({ variant: 'error', title: t('name.renameErrorTitle'), description: state.error });
    }
  }, [state, toast, t]);

  return (
    <Card
      header={
        <div>
          <h2 className="font-sans text-base font-semibold text-(--el-text)">
            {t('name.heading')}
          </h2>
        </div>
      }
    >
      <form
        action={(formData) => {
          submitted.current = true;
          formAction(formData);
        }}
        className="flex items-start gap-3"
      >
        <div className="flex-1">
          <Input
            name="name"
            aria-label={t('name.heading')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            helperText={t('name.helper')}
          />
        </div>
        {/* The Input renders helper text below the box, so the row is taller
            than the control. Align to the row top and match the button to the
            input box height (44px) so it sits flush with the box, not the
            helper text underneath it. */}
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          disabled={!name.trim()}
          className="h-(--height-input)"
        >
          {tc('save')}
        </Button>
      </form>
    </Card>
  );
}
